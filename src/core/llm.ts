import type { DatasetItem, ModelConfig, RuleCheck, SkillAnalysis } from "./types";
import { normalizeContract } from "./contract";
import { LLM_PROXY_HEADER, LLM_PROXY_PATH, LLM_TARGET_HEADER } from "./llmProxy";

const DEFAULT_TIMEOUT = 60_000;

/** 带上下文的模型调用错误——界面据此给出「下一步怎么办」。 */
export class LlmError extends Error {
  readonly kind:
    | "network"
    | "cors"
    | "timeout"
    | "auth"
    | "not_found"
    | "rate_limit"
    | "server"
    | "bad_response"
    | "proxy_unavailable"
    | "unknown";
  readonly status?: number;
  readonly hint?: string;
  readonly detail?: string;

  constructor(kind: LlmError["kind"], message: string, opts: { status?: number; hint?: string; detail?: string } = {}) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = opts.status;
    this.hint = opts.hint;
    this.detail = opts.detail;
  }
}

const trimBase = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, "");

function statusError(status: number, body: string): LlmError {
  const detail = body.slice(0, 400);
  if (status === 401 || status === 403) {
    return new LlmError("auth", `鉴权失败（HTTP ${status}）`, {
      status,
      hint: "检查 API key 是否正确、是否已过期，以及该 key 是否有权访问所填模型。",
      detail,
    });
  }
  if (status === 404) {
    return new LlmError("not_found", `端点或模型不存在（HTTP 404）`, {
      status,
      hint: "多数兼容端点的 Base URL 需要以 /v1 结尾；也请确认模型名拼写与该厂商一致。",
      detail,
    });
  }
  if (status === 429) {
    return new LlmError("rate_limit", "触发限流或额度不足（HTTP 429）", {
      status,
      hint: "稍后重试，或更换额度充足的 key。",
      detail,
    });
  }
  if (status >= 500) {
    return new LlmError("server", `服务端错误（HTTP ${status}）`, {
      status,
      hint: "多为上游服务临时故障，可稍后重试。",
      detail,
    });
  }
  return new LlmError("unknown", `请求失败（HTTP ${status}）`, { status, detail });
}

function transportError(err: unknown, timedOut: boolean, viaProxy: boolean): LlmError {
  if (timedOut) {
    return new LlmError("timeout", "请求超时", {
      hint: "可在模型设置里调大超时时间，或换一个更快的模型。",
    });
  }
  if (viaProxy) {
    return new LlmError("network", "本地代理没有响应", {
      hint: "确认页面是通过 npm run dev / npm run preview 打开的；纯静态部署下没有本地代理。",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  return new LlmError("cors", "无法连接到该端点（浏览器跨域被拦截或网络不通）", {
    hint: "多数厂商端点（Kimi、DeepSeek、通义等）不向浏览器放行跨域。请在模型设置里开启「本地代理转发」，由本机转发请求。",
    detail: err instanceof Error ? err.message : String(err),
  });
}

/** 代理转发时，上游错误由本机中转层包装成 { error: { proxy: true, message } }。 */
async function proxyError(res: Response): Promise<LlmError | null> {
  const body = await res.clone().text().catch(() => "");
  try {
    const data = JSON.parse(body);
    if (data?.error?.proxy) {
      return new LlmError("network", String(data.error.message), {
        status: res.status,
        hint: "本机也连不上该地址时，先确认网络可达、地址拼写正确（多数端点以 /v1 结尾）。",
      });
    }
  } catch {
    /* 上游原样返回的错误交给 statusError 处理 */
  }
  return null;
}

/** 统一的 fetch 封装：超时中止 + 可选本地代理 + 错误归类。 */
async function request(
  cfg: ModelConfig,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs ?? DEFAULT_TIMEOUT);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort);

  const viaProxy = cfg.useProxy === true;
  const target = `${trimBase(cfg.baseUrl)}${path}`;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
    if (viaProxy) headers[LLM_TARGET_HEADER] = target;

    const res = await fetch(viaProxy ? `${LLM_PROXY_PATH}${path}` : target, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });

    // 静态部署下没有中转路径，返回的会是 index.html 或 404——据此给出明确提示
    if (viaProxy && res.headers.get(LLM_PROXY_HEADER) !== "1") {
      throw new LlmError("proxy_unavailable", "当前页面没有本地代理", {
        hint: "本地代理只在 npm run dev / npm run preview 下可用。在线预览请关掉「本地代理转发」直连（需端点支持跨域），或在本机运行。",
      });
    }
    if (!res.ok) {
      throw (viaProxy ? await proxyError(res) : null) ?? statusError(res.status, await res.text().catch(() => ""));
    }
    return res;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (signal?.aborted) throw new LlmError("network", "请求已取消");
    throw transportError(err, timedOut, viaProxy);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 端点是否因为 temperature 参数本身而拒绝了请求。 */
function rejectsTemperature(err: unknown): boolean {
  if (!(err instanceof LlmError) || err.status !== 400) return false;
  return /temperature/i.test(`${err.message} ${err.detail ?? ""}`);
}

/** Call any OpenAI-compatible chat endpoint (the user's own model included). */
export async function chatCompletion(
  cfg: ModelConfig,
  prompt: string,
  opts: { signal?: AbortSignal; temperature?: number; requireComplete?: boolean } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    temperature: opts.temperature ?? cfg.temperature ?? 0.3,
  };
  if (cfg.maxTokens && cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;

  const post = (payload: Record<string, unknown>) =>
    request(cfg, "/chat/completions", { method: "POST", body: JSON.stringify(payload) }, opts.signal);

  let res: Response;
  try {
    res = await post(body);
  } catch (err) {
    // 部分推理型模型（如 kimi-for-coding）只接受默认温度，去掉该参数重试一次
    if (!rejectsTemperature(err)) throw err;
    const withoutTemperature = { ...body };
    delete withoutTemperature.temperature;
    res = await post(withoutTemperature);
  }
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmError("bad_response", "端点返回的结构不是 OpenAI 兼容格式", {
      hint: "确认 Base URL 指向的是 OpenAI 兼容接口（通常以 /v1 结尾）。",
      detail: JSON.stringify(data).slice(0, 300),
    });
  }
  // 推理型模型会先花掉一部分预算在思维链上：预算不够时正文为空，或者结构化输出被从中间截断
  if (data?.choices?.[0]?.finish_reason === "length" && (!content.trim() || opts.requireComplete)) {
    throw new LlmError("bad_response", content.trim() ? "输出被截断，结果不完整" : "输出预算用尽，模型没有返回正文", {
      hint: "推理型模型会先消耗一部分 token 在思维链上。请在模型设置里调大「最大输出 token」（建议 ≥ 4096）后重试。",
      detail: content.slice(-200),
    });
  }
  return content;
}

export interface ConnectionResult {
  ok: true;
  latencyMs: number;
  /** 端点回声，用于让用户确认「确实是这个模型在回答」 */
  reply: string;
}

/** 连接测试：发一条极小的请求，验证 Base URL、密钥与模型名三者都对。 */
export async function testConnection(cfg: ModelConfig, signal?: AbortSignal): Promise<ConnectionResult> {
  const started = performance.now();
  const reply = await chatCompletion(
    // 推理型模型（kimi-for-coding、o 系列等）会先花掉一部分预算在思维链上，
    // 预算给太小会拿到空回声，所以这里留 256。
    { ...cfg, maxTokens: Math.min(cfg.maxTokens || 256, 256), timeoutMs: cfg.timeoutMs ?? 20_000 },
    "只回复两个字：连通",
    { signal, temperature: 0 },
  );
  return { ok: true, latencyMs: Math.round(performance.now() - started), reply: reply.trim().slice(0, 40) };
}

/** 拉取端点上可用的模型列表（部分端点不提供 /models，失败时由调用方降级为手填）。 */
export async function listModels(cfg: ModelConfig, signal?: AbortSignal): Promise<string[]> {
  const res = await request(cfg, "/models", { method: "GET" }, signal);
  const data = await res.json().catch(() => null);
  const rows: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const ids = rows
    .map((r) => (typeof r === "string" ? r : (r as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    throw new LlmError("bad_response", "该端点没有返回模型列表", { hint: "手动填写模型名即可正常使用。" });
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ */
/* 模型定制的规则评分器                                                */
/* ------------------------------------------------------------------ */

/** 允许模型产出的规则类型——必须与 runRules.ts / rule_scorers.py 支持的完全一致。 */
const LLM_RULE_KINDS: RuleCheck["kind"][] = [
  "contains_any",
  "contains_all",
  "not_contains",
  "min_length",
  "max_length",
  "has_heading",
  "has_table",
  "has_code_block",
  "valid_json",
  "no_emoji",
  "non_empty",
];

/** 只保留该规则类型真正会用到的参数，避免模型塞进解释不了的字段。 */
function sanitizeParams(kind: RuleCheck["kind"], raw: Record<string, unknown>): Record<string, unknown> {
  const terms = Array.isArray(raw.terms)
    ? raw.terms.map((t) => String(t)).filter((t) => t.trim().length > 0).slice(0, 12)
    : [];
  switch (kind) {
    case "contains_any":
      return { terms, min_match: Math.max(1, Math.min(terms.length || 1, Number(raw.min_match ?? 1))) };
    case "contains_all":
      return { terms };
    case "not_contains":
      return typeof raw.regex === "string" ? { regex: raw.regex, flags: String(raw.flags ?? "") } : { terms };
    case "min_length":
      return { min: Math.max(1, Number(raw.min ?? 100)) };
    case "max_length":
      return { max: Math.max(1, Number(raw.max ?? 20_000)) };
    default:
      return {};
  }
}

/**
 * 整集优化要一次吐出所有规则 / 条目，输出比普通请求长得多；
 * 推理型模型还会先花掉一大截预算在思维链上，预算不够就会从 JSON 中间截断。
 */
const OPTIMIZE_MIN_TOKENS = 6144;
const withOptimizeBudget = (cfg: ModelConfig): ModelConfig => ({
  ...cfg,
  maxTokens: Math.max(cfg.maxTokens ?? 0, OPTIMIZE_MIN_TOKENS),
  timeoutMs: Math.max(cfg.timeoutMs ?? 0, 180_000),
});

/** 一次优化里对单个对象做了什么。 */
export type ChangeAction = "keep" | "modify" | "add" | "drop";

export interface OptimizeResult<T> {
  /** 优化后的完整集合（已按模型的保留 / 修改 / 新增结果组装） */
  next: T[];
  /** 每条改动一句话，用于界面展示「改了什么」 */
  changes: { action: ChangeAction; label: string; reason: string }[];
}

const ACTION_LABEL: Record<ChangeAction, string> = {
  keep: "保留",
  modify: "修改",
  add: "新增",
  drop: "删除",
};

/** 把模型给出的 action 收敛到四种已知取值。 */
function toAction(v: unknown): ChangeAction {
  const s = String(v ?? "keep").toLowerCase();
  return s === "modify" || s === "add" || s === "drop" ? s : "keep";
}

/** 让模型通盘优化当前规则集：可调权重、改关键词、删冗余、补缺口（不是简单追加）。 */
export async function optimizeRuleChecks(
  cfg: ModelConfig,
  a: SkillAnalysis,
  current: RuleCheck[],
  opts: { signal?: AbortSignal } = {},
): Promise<OptimizeResult<RuleCheck>> {
  const prompt = `You are improving the deterministic scorer set of an AI skill's evaluation pack.

Skill name: ${a.skillName}
Skill description: ${a.description}
Declared output formats: ${a.formats.join(", ") || "free text"}
Expected output sections: ${a.outputSections.join(" / ") || "unknown"}
Required deliverable fields: ${a.outputFields.join(" / ") || "unknown"}
Hard constraints:
${a.constraints.map((c) => `- ${c}`).join("\n") || "- none"}
Quality criteria:
${a.qualityCriteria.map((c) => `- ${c}`).join("\n") || "- none"}

Current rule set (JSON):
${JSON.stringify(
  current.map((r) => ({ id: r.id, name: r.name, kind: r.kind, params: r.params, weight: r.weight })),
  null,
  2,
)}

Review the WHOLE set and return an improved one. For every existing rule decide:
- "keep"   — good as is
- "modify" — same id, but better params / weight / wording (e.g. keywords that never match real
             output, a threshold that is too strict, a weight that misrepresents importance)
- "drop"   — redundant, unmeasurable, or wrong for this skill
And add new rules that cover real failure modes of THIS skill that the current set misses.
Rebalance weights so the important checks dominate (1-5, reserve 4-5 for hard constraints).
Aim for 6-12 rules in total — drop as readily as you add.

Every check runs locally against the model output text only. Allowed "kind" values and their params:
- contains_any  { "terms": string[], "min_match": number }
- contains_all  { "terms": string[] }
- not_contains  { "terms": string[] }   // forbidden wording
- min_length    { "min": number }       // weighted length, CJK counts double
- max_length    { "max": number }
- has_heading | has_table | has_code_block | valid_json | no_emoji | non_empty  { }

For HTML deliverables, preserve or add these two concrete safeguards when applicable:
- html_skeleton: contains_all with ["<html", "<body"], requiring a complete HTML document.
- no_external_script: not_contains with a regex matching remote script src, keeping the report offline-safe.

Write name/description/reason in the same language as the skill description.
Return a JSON array only, each element:
{ "action": "keep|modify|add|drop", "id": string, "name": string, "description": string,
  "kind": string, "params": object, "weight": 1-5, "reason": "one sentence on why" }
For "keep"/"drop" the id must be an existing id.`;

  const raw = await chatCompletion(withOptimizeBudget(cfg), prompt, {
    signal: opts.signal,
    temperature: 0.3,
    requireComplete: true,
  });
  const rows = parseJsonArray(raw);

  const byId = new Map(current.map((r) => [r.id, r]));
  const next: RuleCheck[] = [];
  const changes: OptimizeResult<RuleCheck>["changes"] = [];
  const taken = new Set<string>();
  const seen = new Set<string>();

  for (const row of rows as Record<string, unknown>[]) {
    const action = toAction(row.action);
    const id = String(row.id ?? "").trim();
    const existing = byId.get(id);
    const reason = String(row.reason ?? "").slice(0, 160);

    if (action === "drop" && existing) {
      seen.add(id);
      changes.push({ action, label: existing.name, reason });
      continue;
    }
    if (action === "keep" && existing) {
      seen.add(id);
      taken.add(existing.id);
      next.push(existing);
      continue;
    }

    const kind = String(row.kind ?? existing?.kind ?? "") as RuleCheck["kind"];
    if (!LLM_RULE_KINDS.includes(kind)) continue;
    const params = sanitizeParams(kind, (row.params as Record<string, unknown>) ?? {});
    if ("terms" in params && (params.terms as string[]).length === 0) continue;

    const weight = Math.max(1, Math.min(5, Math.round(Number(row.weight ?? existing?.weight ?? 2)) || 2));
    const rule: RuleCheck = {
      id: existing ? existing.id : uniqueId(`llm_${slug(id || kind)}`, taken),
      name: String(row.name ?? existing?.name ?? id).slice(0, 40),
      description: String(row.description ?? existing?.description ?? "").slice(0, 200),
      kind,
      params,
      weight,
      source: existing ? `${existing.source} · 模型优化` : `模型优化（${cfg.model}）`,
      enabled: existing?.enabled,
    };
    taken.add(rule.id);
    if (existing) seen.add(existing.id);
    next.push(rule);
    changes.push({ action: existing ? "modify" : "add", label: rule.name, reason });
  }

  // 模型漏提的规则保持原样，绝不因为「没提到」就悄悄丢掉
  for (const r of current) {
    if (!seen.has(r.id) && !taken.has(r.id)) next.push(r);
  }
  if (next.length === 0) {
    throw new LlmError("bad_response", "优化后没有剩下任何可执行的规则", {
      hint: "模型返回的规则类型或参数不在本地引擎支持的范围内，已放弃本次优化。",
      detail: raw.slice(0, 300),
    });
  }
  return { next, changes };
}

/** 让模型通盘优化数据集：改写模糊任务、删重复条目、补缺失的边界场景。 */
export async function optimizeDatasetItems(
  cfg: ModelConfig,
  a: SkillAnalysis,
  current: DatasetItem[],
  opts: { signal?: AbortSignal } = {},
): Promise<OptimizeResult<DatasetItem>> {
  const prompt = `You are improving the evaluation dataset of an AI skill.

Skill name: ${a.skillName}
Skill description: ${a.description}
Declared output formats: ${a.formats.join(", ") || "free text"}
Hard constraints:
${a.constraints.map((c) => `- ${c}`).join("\n") || "- none"}

Current dataset items (JSON, index = position):
${JSON.stringify(current.map((it, i) => ({ index: i, input: it.input, expectedOutput: it.expectedOutput })), null, 2)}

Review the WHOLE dataset and return an improved one. For every existing item decide:
- "keep"   — already a good test case
- "modify" — same index, but a sharper task (concrete inputs instead of a bare trigger word),
             or a more checkable expectedOutput
- "drop"   — duplicated, vague, or untestable
And add the missing coverage: realistic happy paths,边界 / 异常 inputs, and adversarial cases that
probe the hard constraints. Aim for 5-10 items in total — quality over quantity.

Write every natural-language field in the same language as the skill description.
SkillFuse does not know business truth. NEVER invent, estimate, infer, copy, or fabricate metric values.
SkillFuse 不知道业务真值，严禁编造、估算、推断或复制任何指标数值。
Every generated fact MUST use value: null and status: "pending". Only a human may later confirm a value.
自动生成的每条 fact 都必须是 value: null、status: "pending"，只有人工才能确认数值。
Return a JSON array only, each element:
{ "action": "keep|modify|add|drop", "index": number|null,
  "input": { "task": string, "context": object },
  "expectedOutput": { "format": "markdown|html|json|text", "verification_level": "structure",
    "required_sections": string[], "required_tables": [{ "columns": string[] }],
    "facts": [{ "name": string, "value": null, "tolerance": number, "unit": string, "status": "pending" }],
    "required_statements": string[], "must_include": string[], "must_not_include": string[],
    "forbid_external_scripts": boolean, "notes": string },
  "metadata": { "section": string, "tags": string[], "difficulty": "basic|intermediate|edge" },
  "reason": "one sentence on why" }
"index" is required for keep/modify/drop and must refer to an existing item.`;

  const raw = await chatCompletion(withOptimizeBudget(cfg), prompt, {
    signal: opts.signal,
    temperature: 0.5,
    requireComplete: true,
  });
  const rows = parseJsonArray(raw);

  const next: DatasetItem[] = [];
  const changes: OptimizeResult<DatasetItem>["changes"] = [];
  const seen = new Set<number>();

  for (const row of rows as Record<string, unknown>[]) {
    const action = toAction(row.action);
    const idx = Number(row.index);
    const existing = Number.isInteger(idx) ? current[idx] : undefined;
    const reason = String(row.reason ?? "").slice(0, 160);
    const label = String(
      ((row.input as Record<string, unknown>)?.task ?? taskOfItem(existing) ?? "条目") as string,
    ).slice(0, 48);

    if (action === "drop" && existing) {
      seen.add(idx);
      changes.push({ action, label: taskOfItem(existing).slice(0, 48), reason });
      continue;
    }
    if (action === "keep" && existing) {
      seen.add(idx);
      next.push(existing);
      continue;
    }

    const input = (row.input as Record<string, unknown>) ?? existing?.input ?? {};
    if (!String((input as { task?: unknown }).task ?? "").trim()) continue;
    if (existing) seen.add(idx);
    const generatedExpected = row.expectedOutput && typeof row.expectedOutput === "object"
      ? row.expectedOutput as Record<string, unknown>
      : null;
    const expectedOutput = generatedExpected
      ? normalizeContract({
          ...generatedExpected,
          verification_level: "structure",
          facts: Array.isArray(generatedExpected.facts)
            ? generatedExpected.facts.map((fact) => ({
                ...(fact && typeof fact === "object" ? fact : {}),
                value: null,
                status: "pending",
              }))
            : [],
        })
      : existing?.expectedOutput;
    next.push({
      input,
      expectedOutput,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...((row.metadata as Record<string, unknown>) ?? {}),
        source: existing ? "llm-optimized" : "llm-augmented",
        model: cfg.model,
      },
    });
    changes.push({ action: existing ? "modify" : "add", label, reason });
  }

  for (let i = 0; i < current.length; i++) {
    if (!seen.has(i) && !next.includes(current[i])) next.push(current[i]);
  }
  if (next.length === 0) {
    throw new LlmError("bad_response", "优化后没有剩下任何数据集条目", {
      hint: "模型返回的条目缺少 task 字段，已放弃本次优化。",
      detail: raw.slice(0, 300),
    });
  }
  return { next, changes };
}

/** 把一次优化的改动压成一行摘要，供 toast 展示。 */
export function summarizeChanges(changes: { action: ChangeAction }[]): string {
  const n = (a: ChangeAction) => changes.filter((c) => c.action === a).length;
  return (["add", "modify", "drop", "keep"] as ChangeAction[])
    .filter((a) => n(a) > 0)
    .map((a) => `${ACTION_LABEL[a]} ${n(a)}`)
    .join(" · ");
}

const slug = (s: string) => s.replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "rule";

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

function taskOfItem(item: DatasetItem | undefined): string {
  const task = (item?.input as { task?: unknown } | undefined)?.task;
  return typeof task === "string" ? task : "";
}

function parseJsonArray(raw: string): unknown[] {
  const match = raw.match(/\[[\s\S]*\]/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    throw new LlmError("bad_response", "模型没有返回可解析的 JSON 数组", {
      hint: "换一个指令跟随更稳的模型，或稍后重试。",
      detail: raw.slice(0, 300),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new LlmError("bad_response", "模型返回的不是 JSON 数组", { detail: raw.slice(0, 300) });
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* 直接用配置的模型跑一遍需求                                          */
/* ------------------------------------------------------------------ */

/** 让配置的模型扮演被测 skill 跑一条需求，产出可以直接送去评分的交付物。 */
export async function runSkillTask(
  cfg: ModelConfig,
  a: SkillAnalysis,
  task: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const prompt = `你是严格按照下面这个 skill 执行任务的助手。请直接产出交付物本身，
不要写「我将要做什么」之类的说明，也不要对 skill 本身做评论。

## Skill：${a.displayName}

${a.description}

${a.steps.length ? `### 工作流程\n${a.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n` : ""}
${a.constraints.length ? `### 硬约束（必须遵守）\n${a.constraints.map((c) => `- ${c}`).join("\n")}\n` : ""}
${a.outputSections.length ? `### 预期输出结构\n${a.outputSections.map((s) => `- ${s}`).join("\n")}\n` : ""}
${a.formats.length ? `### 输出格式\n${a.formats.join("、")}\n` : ""}
## 本次需求

${task}`;

  return (await chatCompletion(cfg, prompt, { signal: opts.signal })).trim();
}

/** 评审 rubric 的四个维度，与 llm_judge_prompt.md 中的字段一一对应。 */
export const JUDGE_DIMENSIONS = [
  { key: "task_completion", label: "任务完成度" },
  { key: "instruction_adherence", label: "指令遵循度" },
  { key: "quality", label: "质量标准" },
  { key: "format_compliance", label: "格式合规性" },
] as const;

export interface JudgeResult {
  score: number;
  reasoning: string;
  /** 各维度 1–5 分，模型未给出时为 undefined */
  dimensions: Record<string, number | undefined>;
  constraintViolation: boolean;
  parsed: boolean;
  raw: string;
}

/** Run the generated judge prompt against one input/output pair using the user's model. */
export async function runJudge(
  cfg: ModelConfig,
  judgePrompt: string,
  input: string,
  output: string,
  opts: { signal?: AbortSignal } = {},
): Promise<JudgeResult> {
  const prompt = judgePrompt.replace("{{input}}", input).replace("{{output}}", output);
  const raw = await chatCompletion(cfg, prompt, { signal: opts.signal, temperature: 0 });
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const data = JSON.parse(match ? match[0] : raw);
    const dimensions: Record<string, number | undefined> = {};
    for (const d of JUDGE_DIMENSIONS) {
      const v = Number(data[d.key]);
      dimensions[d.key] = Number.isFinite(v) ? Math.max(1, Math.min(5, v)) : undefined;
    }
    return {
      score: Math.max(0, Math.min(1, Number(data.score ?? 0))),
      reasoning: String(data.reasoning ?? "").slice(0, 800),
      dimensions,
      constraintViolation: data.constraint_violation === true,
      parsed: true,
      raw,
    };
  } catch {
    return {
      score: 0,
      reasoning: "评审结果解析失败：模型没有按 rubric 返回 JSON。可换一个指令跟随更稳的模型，或调低温度重试。",
      dimensions: {},
      constraintViolation: false,
      parsed: false,
      raw,
    };
  }
}

/** 把任意异常整理成「一句话 + 怎么办」，供界面直接展示。 */
export function describeError(err: unknown): { message: string; hint?: string; detail?: string } {
  if (err instanceof LlmError) return { message: err.message, hint: err.hint, detail: err.detail };
  return { message: err instanceof Error ? err.message : String(err) };
}
