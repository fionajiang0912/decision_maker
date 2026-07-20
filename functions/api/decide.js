// functions/api/decide.js —— Cloudflare Pages Function
// 与 api/decide.js（Vercel 版）功能一致：收前端决策文本 -> 按 IP 每日限流 -> 调 DeepSeek -> 返回 {pros,cons,advice}
// Key 只从环境变量 DEEPSEEK_API_KEY 读，绝不硬编、绝不出现在返回体、绝不 log、绝不进 URL。

const MAX_LEN = 1000;
const DAILY_LIMIT = 80;
const RATE_MSG = "今天太多人来找包工头拍板啦，明天再来~";

function getClientIp(request) {
  // Cloudflare 官方给的 cf-connecting-ip 最权威
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
  return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

// 限流：Upstash Redis REST。同时兼容 UPSTASH_* 和 KV_REST_* 两种命名。
// 没配则降级放行（不限流但不影响出卡片）。
async function checkRateLimit(ip, env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { limited: false, enforced: false };

  const key = `rl:${ip}:${todayStr()}`;
  const ttl = secondsUntilUtcMidnight();

  try {
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
    if (!resp.ok) return { limited: false, enforced: false };
    const arr = await resp.json();
    const count = arr && arr[0] ? Number(arr[0].result) : 0;
    if (count > DAILY_LIMIT) return { limited: true, enforced: true, count };
    return { limited: false, enforced: true, count };
  } catch (e) {
    return { limited: false, enforced: false };
  }
}

const SYSTEM_PROMPT = [
  "你是一位说话风趣、接地气的\"决策包工头\"。用户会告诉你一件他正在纠结的事，",
  "你要用中文、说人话地帮他拍板。",
  "",
  "请只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记，格式严格如下：",
  '{"pros":["","",""],"cons":["","",""],"advice":""}',
  "要求：",
  "- pros：支持\"去做/选它\"的理由，恰好 3 条，每条一句话，具体、接地气。",
  "- cons：反对/需要顾虑的点，恰好 3 条，每条一句话。",
  "- advice：一句风趣的\"包工头建议\"，像工地老师傅一样直接、给个明确倾向，别和稀泥。",
  "- 如果用户输入是乱码、纯符号或看不懂，pros/cons 就写常识性的通用提醒，",
  '  advice 写"这我看不懂哈，用人话说说你在纠结啥"。'
].join("\n");

function parseModelJson(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let obj = tryParse(s);
  if (obj) return normalize(obj);

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

function jsonResponse(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders || {})
    }
  });
}

// Cloudflare Pages Function：POST /api/decide
export async function onRequestPost({ request, env }) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: "包工头还没上工（后端没配 API Key），喊老板配一下" },
      500
    );
  }

  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const text = body && typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    return jsonResponse({ error: "先说说你纠结啥，我才好拍板呀" }, 400);
  }
  if (text.length > MAX_LEN) {
    return jsonResponse({ error: "话太多啦，挑最纠结那句给我就行" }, 400);
  }

  const ip = getClientIp(request);
  const rl = await checkRateLimit(ip, env);
  const enforcedHeader = { "x-ratelimit-enforced": rl.enforced ? "1" : "0" };
  if (rl.limited) {
    return jsonResponse({ error: RATE_MSG }, 429, enforcedHeader);
  }

  try {
    const apiResp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
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
      return jsonResponse(
        { error: "哎呀线断了，包工头没听清，再点一下试试" },
        502,
        enforcedHeader
      );
    }

    const data = await apiResp.json();
    const raw =
      data && data.choices && data.choices[0] && data.choices[0].message &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content
        : "";

    const parsed = parseModelJson(raw);
    if (!parsed) {
      return jsonResponse(
        { error: "包工头嘴瓢了没说清，再点一下试试" },
        502,
        enforcedHeader
      );
    }

    return jsonResponse(parsed, 200, enforcedHeader);
  } catch (e) {
    return jsonResponse(
      { error: "哎呀线断了，包工头没听清，再点一下试试" },
      502,
      enforcedHeader
    );
  }
}
