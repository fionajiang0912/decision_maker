// api/decide.js  —— Vercel Serverless Function（Node.js runtime）
// 职责：收前端决策文本 -> 按 IP 每日限流 -> 调 DeepSeek（OpenAI 兼容接口）-> 解析成 {pros,cons,advice} 返回。
// Key 只从环境变量 DEEPSEEK_API_KEY 读，绝不硬编、绝不出现在返回体、绝不 log、绝不进 URL。

const MAX_LEN = 1000;           // 与前端一致的输入上限
const DAILY_LIMIT = 80;         // 同一 IP 每天最多 80 次，第 81 次拦下
const RATE_MSG = "今天太多人来找包工头拍板啦，明天再来~";

// ---------- 工具 ----------

function getClientIp(req) {
  // x-forwarded-for 可能是 "client, proxy1, proxy2"，取第一个
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real.trim();
  return "unknown";
}

function todayStr() {
  // 用 UTC 日期做 key，避免服务器时区漂移；每日边界为 UTC 00:00
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const end = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0
  ));
  return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

// ---------- 限流（Upstash Redis REST，跨请求/跨实例真实生效）----------
// 若未配置 Upstash 环境变量，则降级为“不限流但正常工作”，并在响应头标注。

async function checkRateLimit(ip) {
  // Vercel Marketplace 的 Upstash 集成注入的是 KV_REST_API_URL/TOKEN；
  // 手动接 Upstash 时通常叫 UPSTASH_REDIS_REST_URL/TOKEN。两种都支持。
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  // 未接 KV：降级放行（交付说明里已诚实标注此情况）
  if (!url || !token) {
    return { limited: false, enforced: false };
  }

  const key = `rl:${ip}:${todayStr()}`;
  const ttl = secondsUntilUtcMidnight();

  try {
    // 用 pipeline 一次发 INCR + EXPIRE(NX)，减少往返
    const resp = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(ttl), "NX"]
      ])
    });

    if (!resp.ok) {
      // KV 挂了不能连累用户：放行，但标注未强制
      return { limited: false, enforced: false };
    }

    const arr = await resp.json(); // [{result: <count>}, {result: 0|1}]
    const count = arr && arr[0] ? Number(arr[0].result) : 0;

    if (count > DAILY_LIMIT) {
      return { limited: true, enforced: true, count };
    }
    return { limited: false, enforced: true, count };
  } catch (e) {
    // 网络异常同样放行
    return { limited: false, enforced: false };
  }
}

// ---------- 提示词 ----------

const SYSTEM_PROMPT = [
  "你是一位说话风趣、接地气的“决策包工头”。用户会告诉你一件他正在纠结的事，",
  "你要用中文、说人话地帮他拍板。",
  "",
  "请只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记，格式严格如下：",
  '{"pros":["","",""],"cons":["","",""],"advice":""}',
  "要求：",
  "- pros：支持“去做/选它”的理由，恰好 3 条，每条一句话，具体、接地气。",
  "- cons：反对/需要顾虑的点，恰好 3 条，每条一句话。",
  "- advice：一句风趣的“包工头建议”，像工地老师傅一样直接、给个明确倾向，别和稀泥。",
  "- 如果用户输入是乱码、纯符号或看不懂，pros/cons 就写常识性的通用提醒，",
  '  advice 写“这我看不懂哈，用人话说说你在纠结啥”。'
].join("\n");

// 从模型返回文本里稳妥抠出 JSON
function parseModelJson(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();

  // 去掉可能的 ```json ... ``` 包裹
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 直接尝试
  let obj = tryParse(s);
  if (obj) return normalize(obj);

  // 退而求其次：截取第一个 { 到最后一个 }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    obj = tryParse(s.slice(first, last + 1));
    if (obj) return normalize(obj);
  }
  return null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const fix3 = (a) => {
    let arr = Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : [];
    arr = arr.slice(0, 3);
    while (arr.length < 3) arr.push("——");
    return arr;
  };
  return {
    pros: fix3(obj.pros),
    cons: fix3(obj.cons),
    advice: (obj.advice && String(obj.advice).trim()) || "这事儿你自己心里其实有数了。"
  };
}

// ---------- 读取请求体（Vercel 多数情况下已解析，做个兜底）----------
async function readBody(req) {
  if (req.body) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    return req.body;
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// ---------- 主处理 ----------

module.exports = async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "只收 POST 哈" }));
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "包工头还没上工（后端没配 API Key），喊老板配一下" }));
  }

  // 输入
  let body;
  try { body = await readBody(req); } catch (e) { body = {}; }
  let text = body && typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "先说说你纠结啥，我才好拍板呀" }));
  }
  if (text.length > MAX_LEN) {
    // 超长直接拒绝，绝不放进模型——防止绕过前端灌爆烧账单
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "话太多啦，挑最纠结那句给我就行" }));
  }

  // 限流
  const ip = getClientIp(req);
  const rl = await checkRateLimit(ip);
  res.setHeader("x-ratelimit-enforced", rl.enforced ? "1" : "0");
  if (rl.limited) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ error: RATE_MSG }));
  }

  // 调 DeepSeek（OpenAI 兼容接口）
  try {
    const apiResp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 800,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text }
        ]
      })
    });

    if (!apiResp.ok) {
      // 不把大模型的原始错误/任何敏感信息透给前端
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "哎呀线断了，包工头没听清，再点一下试试" }));
    }

    const data = await apiResp.json();
    const raw =
      data &&
      Array.isArray(data.choices) &&
      data.choices[0] &&
      data.choices[0].message &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content
        : "";

    const parsed = parseModelJson(raw);
    if (!parsed) {
      // 解析失败兜底：不甩脏数据给前端
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "包工头嘴瓢了没说清，再点一下试试" }));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify(parsed));
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "哎呀线断了，包工头没听清，再点一下试试" }));
  }
};
