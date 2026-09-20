#!/usr/bin/env node
/**
 * 本机模型连通性自检。
 *
 *   npm run check:model -- --base https://api.kimi.com/coding/v1 --model kimi-for-coding --key sk-...
 *   # 或用环境变量（推荐，避免密钥进入 shell 历史）：
 *   SKILLFUSE_BASE_URL=... SKILLFUSE_MODEL=... SKILLFUSE_API_KEY=... npm run check:model
 *
 * 逐项验证：可达性 → 鉴权 → 模型列表 → 对话 → 浏览器跨域 → JSON 跟随能力，
 * 任何一项失败都给出具体的下一步，而不是只丢一个 HTTP 码。
 */

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseUrl = (arg("base") ?? process.env.SKILLFUSE_BASE_URL ?? "").trim().replace(/\/+$/, "");
const model = (arg("model") ?? process.env.SKILLFUSE_MODEL ?? "").trim();
const apiKey = (arg("key") ?? process.env.SKILLFUSE_API_KEY ?? "").trim();
const timeoutMs = Number(arg("timeout") ?? 60_000);

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

if (!baseUrl || !model) {
  console.error(`用法：
  npm run check:model -- --base <Base URL> --model <模型名> [--key <API key>]

示例（Kimi for Coding）：
  SKILLFUSE_API_KEY=sk-... npm run check:model -- \\
    --base https://api.kimi.com/coding/v1 --model kimi-for-coding

密钥也可以放在环境变量 SKILLFUSE_API_KEY 里，避免进入 shell 历史。`);
  process.exit(2);
}

const headers = { "Content-Type": "application/json" };
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

let failures = 0;
let warnings = 0;

const step = (n, title) => console.log(`\n${C.b(`[${n}] ${title}`)}`);
const pass = (msg) => console.log(`  ${C.ok("✓")} ${msg}`);
const fail = (msg, fix) => {
  failures += 1;
  console.log(`  ${C.bad("✗")} ${msg}`);
  if (fix) console.log(`    ${C.dim("怎么办：")}${fix}`);
};
const warn = (msg, fix) => {
  warnings += 1;
  console.log(`  ${C.warn("!")} ${msg}`);
  if (fix) console.log(`    ${C.dim("怎么办：")}${fix}`);
};

async function call(path, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: ac.signal });
    return { res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 网络代理挡在中间时，403 往往来自代理而不是模型服务——两者的处理办法完全不同。 */
function looksLikeEgressBlock(body = "") {
  return /allowlist|egress|not allowed|blocked by policy|forbidden by policy|proxy/i.test(body);
}

function explainStatus(status, body = "") {
  if (status === 403 && looksLikeEgressBlock(body)) {
    return "这条 403 来自你和端点之间的网络代理，不是模型服务：该域名不在出网白名单里。把域名加进公司网络 / 运行环境的出网允许列表，或换一个网络环境重试。";
  }
  if (status === 401 || status === 403) return "密钥无效、已过期，或该密钥没有这个模型的权限。去控制台确认后重试。";
  if (status === 404) return "路径不对：多数端点的 Base URL 需要以 /v1 结尾；也确认模型名拼写与厂商文档一致。";
  if (status === 429) return "限流或额度不足，稍后再试或换一把额度充足的密钥。";
  if (status >= 500) return "上游服务临时故障，稍后重试。";
  return "";
}

console.log(C.b("SkillFuse 模型自检"));
console.log(C.dim(`  Base URL  ${baseUrl}`));
console.log(C.dim(`  模型      ${model}`));
console.log(C.dim(`  密钥      ${apiKey ? `${apiKey.slice(0, 7)}…（${apiKey.length} 字符）` : "（未提供）"}`));

/* ---------- 1. 可达性 ---------- */
step(1, "端点可达性");
try {
  const { res, ms } = await call("/models", { method: "GET" });
  const body = res.ok ? "" : await res.clone().text().catch(() => "");
  if (looksLikeEgressBlock(body)) {
    fail(
      `请求被中间的网络代理拦住了（HTTP ${res.status}）：${body.trim().slice(0, 160)}`,
      "这不是密钥或模型名的问题。把该域名加进出网白名单，或换一个能访问它的网络后重试。",
    );
    console.log(`\n${C.bad("自检中止：请求根本没到达模型服务。")}`);
    process.exit(1);
  }
  pass(`能连上（HTTP ${res.status}，${ms} ms）`);
  globalThis.__modelsRes = res;
  globalThis.__modelsBody = body;
} catch (err) {
  const msg = err?.name === "AbortError" ? `超时（> ${timeoutMs} ms）` : String(err?.cause?.code ?? err?.message ?? err);
  fail(`连不上 ${baseUrl}：${msg}`, "确认网络/代理可访问该域名，以及 Base URL 没写错。公司网络下可能需要设置 HTTPS_PROXY。");
  console.log(`\n${C.bad("自检中止：端点都连不上，后面的检查没有意义。")}`);
  process.exit(1);
}

/* ---------- 2. 鉴权 + 模型列表 ---------- */
step(2, "鉴权与模型列表");
{
  const res = globalThis.__modelsRes;
  if (res.ok) {
    const data = await res.json().catch(() => null);
    const ids = (Array.isArray(data?.data) ? data.data : []).map((m) => m?.id).filter(Boolean);
    if (ids.length > 0) {
      pass(`密钥有效，端点返回 ${ids.length} 个模型`);
      console.log(C.dim(`    ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? " …" : ""}`));
      if (!ids.includes(model)) {
        warn(`列表里没有「${model}」`, "如果厂商文档就是这个名字，可以忽略——有些端点的 /models 并不完整。");
      } else {
        pass(`「${model}」在可用列表中`);
      }
    } else {
      warn("端点没有返回模型列表", "不影响使用，手填模型名即可。");
    }
  } else {
    // /models 不可用不一定是致命的，交给第 3 步的对话请求定论
    warn(
      `GET /models 返回 HTTP ${res.status}`,
      explainStatus(res.status, globalThis.__modelsBody) || "部分端点不提供 /models，继续看对话请求是否正常。",
    );
  }
}

/* 推理型模型（kimi-for-coding、o 系列等）只接受默认温度，且会先把一部分预算
   花在思维链上——去掉温度重试一次，预算也给足，否则会拿到空回声。 */
async function chat(payload) {
  const first = await call("/chat/completions", { method: "POST", body: JSON.stringify(payload) });
  if (first.res.status !== 400) return { ...first, droppedTemperature: false };
  const body = await first.res.clone().text().catch(() => "");
  if (!/temperature/i.test(body)) return { ...first, droppedTemperature: false };
  const { temperature: _t, ...retry } = payload;
  const second = await call("/chat/completions", { method: "POST", body: JSON.stringify(retry) });
  return { ...second, droppedTemperature: true };
}

/* ---------- 3. 对话请求 ---------- */
step(3, "对话请求（真正要用的能力）");
let chatOk = false;
let chatBody = { model, messages: [{ role: "user", content: "只回复两个字：连通" }], temperature: 0, max_tokens: 256 };
try {
  const { res, ms, droppedTemperature } = await chat(chatBody);
  if (droppedTemperature) {
    const { temperature: _t, ...rest } = chatBody;
    chatBody = rest;
    warn("该模型只接受默认温度，已去掉 temperature 重试", "这是推理型模型的常见限制，网页端与生成的 llm_judge.py 都会自动兜底，不用手动改。");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(`HTTP ${res.status}：${body.slice(0, 200)}`, explainStatus(res.status, body));
  } else {
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && !content.trim() && data?.choices?.[0]?.finish_reason === "length") {
      fail("输出预算用尽，模型没有返回正文", "推理型模型会先消耗 token 在思维链上。网页里请把「最大输出 token」调大一些。");
    } else if (typeof content === "string") {
      chatOk = true;
      pass(`模型回声「${content.trim().slice(0, 30)}」（${ms} ms）`);
      const usage = data?.usage;
      if (usage) console.log(C.dim(`    token：prompt ${usage.prompt_tokens ?? "?"} / completion ${usage.completion_tokens ?? "?"}`));
    } else {
      fail("返回结构不是 OpenAI 兼容格式", "确认 Base URL 指向的是 OpenAI 兼容接口（通常以 /v1 结尾）。");
    }
  }
} catch (err) {
  fail(`请求失败：${err?.name === "AbortError" ? "超时" : String(err?.message ?? err)}`);
}

/* ---------- 4. 浏览器跨域 ---------- */
step(4, "浏览器能否直连（CORS）");
try {
  const { res } = await call("/chat/completions", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  const allow = res.headers.get("access-control-allow-origin");
  if (allow) {
    pass(`端点放行浏览器（Access-Control-Allow-Origin: ${allow}）——可以直连，不需要本地代理`);
  } else {
    warn("端点不返回 CORS 头，浏览器直连会被拦截", "在网页的「模型接入」里打开「本地代理转发」即可，由本机 vite 服务代发请求。");
  }
} catch {
  warn("无法判断 CORS（端点未响应 OPTIONS）", "多数情况下意味着不支持浏览器直连，打开「本地代理转发」最稳妥。");
}

/* ---------- 5. JSON 跟随能力 ---------- */
step(5, "JSON 跟随能力（补充条目 / LLM 评审依赖）");
if (!chatOk) {
  console.log(C.dim("  上一步没通过，跳过。"));
} else {
  try {
    const { res } = await chat({
      ...chatBody,
      messages: [{ role: "user", content: '只返回这个 JSON，不要任何其他内容：{"ok": true, "n": 2}' }],
      max_tokens: 512,
    });
    const data = await res.json().catch(() => null);
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed?.ok === true) pass("模型能按要求返回结构化 JSON");
    else warn(`模型返回的 JSON 不符合预期：${raw.slice(0, 120)}`, "补充条目和 LLM 评审依赖 JSON 输出，必要时换一个指令跟随更稳的模型。");
  } catch (err) {
    warn(`JSON 检查失败：${String(err?.message ?? err)}`);
  }
}

/* ---------- 汇总 ---------- */
console.log("");
if (failures === 0) {
  console.log(C.ok(C.b("✓ 模型可用。")) + ` ${warnings > 0 ? C.warn(`（${warnings} 条提醒见上）`) : ""}`);
  console.log(C.dim("下一步：npm run dev → 右上角「模型接入」填同样的 Base URL / 密钥 / 模型名。"));
  console.log(C.dim("如果第 4 步提示不支持跨域，记得打开「本地代理转发」。"));
} else {
  console.log(C.bad(C.b(`✗ ${failures} 项未通过`)) + C.dim("，按上面的「怎么办」逐条排查。"));
  process.exit(1);
}
