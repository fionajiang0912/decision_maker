# 一页纸决策器

> 纠结的事，包工头替你拍板。

前端一屏 + 后端 serverless 函数，部署在 Vercel。用户输入正在纠结的事，
后端调 DeepSeek（OpenAI 兼容接口，模型 `deepseek-v4-flash`）返回「👍支持方 3 条 / 👎反对方 3 条 / 🛠包工头建议 1 句」。

---

## 目录结构

```
decision-maker/
├─ public/index.html   前端一屏（内联 CSS/JS，零外链）
├─ api/decide.js       后端 serverless 函数，前端 fetch('/api/decide') 调它
├─ package.json
├─ vercel.json         只配了函数超时
└─ README.md
```

- 前端**不接触 API Key**，只 fetch 自己的 `/api/decide`。
- Key 只在后端从环境变量读，绝不出现在前端源码、日志或 URL 里。

---

## 部署到 Vercel（3 步）

### 1. 导入项目
- 把这个目录推到一个 Git 仓库（GitHub/GitLab/Bitbucket 都行）。
- 打开 [vercel.com](https://vercel.com) → **Add New → Project** → 选中这个仓库 → **Import**。
- Framework 选 **Other**（零配置即可，Vercel 会自动把 `public/` 当静态目录、`api/` 当函数目录）。先别急着点 Deploy，先配环境变量（第 2 步）。

### 2. 配环境变量

进 **Project → Settings → Environment Variables**，点 **Add New**，加：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ 必填 | 你的 DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com) → API Keys 里拿）。没有它后端起不来。 |
| `UPSTASH_REDIS_REST_URL` | 建议 | 做每日限流用。见下方 Upstash 集成，加集成后**自动注入**，不用手填。 |
| `UPSTASH_REDIS_REST_TOKEN` | 建议 | 同上，自动注入。 |

**填 `DEEPSEEK_API_KEY` 的具体步骤：**
1. Name 填 `DEEPSEEK_API_KEY`，Value 粘贴你的 DeepSeek key。
2. Environments 三个都勾上：**Production / Preview / Development**。
3. **Save**。
4. **改完环境变量后必须 Redeploy 一次才生效**（Deployments → 最近一次 → 右上角 `···` → **Redeploy**）。只 Save 不 Redeploy，线上还是旧的、读不到 key。

**加 Upstash（限流用，免费层）：**
- 项目页 → **Storage / Integrations** → Marketplace 搜 **Upstash** → 选 **Redis** → 一键连接到本项目。
- 连好后，Vercel 会自动把 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 注入到项目环境变量里，代码直接就能用，**你不用手动复制粘贴**。
- 如果不加 Upstash：产品照样能跑，但**限流不生效**（详见下面「限流说明」）。

### 3. 部署
- 点 **Deploy**，等构建完成，拿到形如 `https://decision-maker-xxxx.vercel.app` 的网址。
- 打开网址就能用。改了环境变量后需要 **Redeploy** 一次才生效。

---

## 本地跑

需要 Node 18+ 和 Vercel CLI：

```bash
npm i -g vercel
cd decision-maker
# 本地准备一个 .env（不要提交到 git）：
#   DEEPSEEK_API_KEY=sk-...
#   UPSTASH_REDIS_REST_URL=...      （可选）
#   UPSTASH_REDIS_REST_TOKEN=...    （可选）
vercel dev
```

`vercel dev` 会在 `http://localhost:3000` 起本地服务，前端和 `/api/decide` 一起跑。

> 本地也可以不写 `.env`，改用 `vercel env add DEEPSEEK_API_KEY development` 把 key 存到 Vercel、再 `vercel env pull` 拉到本地 `.env.local`。二选一即可，别把任何含 key 的文件提交到 git。

---

## 限流说明（请老板知晓边界）

- **口径**：按 IP 计数，`x-forwarded-for` 取第一个 IP 当作「同一用户」。同一 IP **每天最多 80 次**，第 81 次直接拦下、**不调大模型**，返回：「今天太多人来找包工头拍板啦，明天再来~」。
- **实现**：用 Upstash Redis 做每日计数（key 形如 `rl:<ip>:<日期>`，当天 UTC 24:00 过期），**跨请求、跨 serverless 实例真实生效**，不靠进程内存假装。
- **这是粗筛闸门，不是安全防线**，已知边界：
  - **共享 IP 会误伤**：同一公司/学校/家庭 NAT、运营商大出口后面的多个真人共用一个出口 IP，会被算成一个人，可能提前触顶。
  - **换网络能绕过**：一个人切 WiFi/流量、开代理、走不同出口 IP，计数就重来，能绕开上限。
  - 日期按 **UTC** 切，不是北京时间 0 点重置。
- 想更严实（登录配额、设备指纹、验证码等）不在本期范围内。

---

## 隐私 / 安全

- API Key 只在后端 `process.env.DEEPSEEK_API_KEY` 读取，只拼进请求头的 `Authorization: Bearer …`，前端源码里搜不到，也不写日志、不进返回体、不进 URL。
- 后端出错时只回友好文案，不把大模型原始错误/堆栈透给前端。
- 前端零外链：不引任何 CDN、字体、统计脚本，只请求自己的 `/api/decide`。
