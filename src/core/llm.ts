import type { DatasetItem, ModelConfig, SkillAnalysis } from "./types";

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

function transportError(err: unknown, timedOut: boolean): LlmError {
  if (timedOut) {
    return new LlmError("timeout", "请求超时", {
      hint: "可在模型设置里调大超时时间，或换一个更快的模型。",
    });
  }
  return new LlmError("cors", "无法连接到该端点（网络或跨域被拦截）", {
    hint: "浏览器直连需要端点允许跨域（CORS）。本地服务请放开跨域；若厂商不支持浏览器直连，可改用 CLI 生成评测包。",
    detail: err instanceof Error ? err.message : String(err),
  });
}

/** 统一的 fetch 封装：超时中止 + 错误归类。 */
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

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
    const res = await fetch(`${trimBase(cfg.baseUrl)}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    if (!res.ok) throw statusError(res.status, await res.text().catch(() => ""));
    return res;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (signal?.aborted) throw new LlmError("network", "请求已取消");
    throw transportError(err, timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Call any OpenAI-compatible chat endpoint (the user's own model included). */
export async function chatCompletion(
  cfg: ModelConfig,
  prompt: string,
  opts: { signal?: AbortSignal; temperature?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    temperature: opts.temperature ?? cfg.temperature ?? 0.3,
  };
  if (cfg.maxTokens && cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;

  const res = await request(cfg, "/chat/completions", { method: "POST", body: JSON.stringify(body) }, opts.signal);
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmError("bad_response", "端点返回的结构不是 OpenAI 兼容格式", {
      hint: "确认 Base URL 指向的是 OpenAI 兼容接口（通常以 /v1 结尾）。",
      detail: JSON.stringify(data).slice(0, 300),
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
    { ...cfg, maxTokens: Math.min(cfg.maxTokens || 32, 32), timeoutMs: cfg.timeoutMs ?? 20_000 },
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

/** Ask the user's model for extra dataset items; returns parsed items or throws. */
export async function augmentDatasetItems(
  cfg: ModelConfig,
  a: SkillAnalysis,
  existing: DatasetItem[],
  count = 3,
  opts: { signal?: AbortSignal; difficulty?: string } = {},
): Promise<DatasetItem[]> {
  const prompt = `You are helping build a Langfuse evaluation dataset for an AI skill.

Skill name: ${a.skillName}
Skill description: ${a.description}
Detected output formats: ${a.formats.join(", ") || "free text"}
Hard constraints:
${a.constraints.map((c) => `- ${c}`).join("\n") || "- none"}

Existing dataset items (do not duplicate):
${JSON.stringify(existing.map((i) => i.input), null, 2)}

Propose ${count} NEW, diverse dataset items${
    opts.difficulty && opts.difficulty !== "mixed" ? ` at "${opts.difficulty}" difficulty` : " (mix of happy-path and edge cases)"
  }.
Write every natural-language field in the same language as the skill description.
Return a JSON array only, each element:
{ "input": { "task": string, "context": object },
  "expectedOutput": { "must_include": string[], "format": string, "notes": string },
  "metadata": { "source": "llm-augmented", "section": string, "tags": string[], "difficulty": "basic|intermediate|edge" } }`;

  const raw = await chatCompletion(cfg, prompt, { signal: opts.signal, temperature: 0.7 });
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
  return (parsed as DatasetItem[]).map((item) => ({
    input: item.input ?? {},
    expectedOutput: item.expectedOutput,
    metadata: { ...(item.metadata ?? {}), source: "llm-augmented", model: cfg.model },
  }));
}

/** Run the generated judge prompt against one input/output pair using the user's model. */
export async function runJudge(
  cfg: ModelConfig,
  judgePrompt: string,
  input: string,
  output: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ score: number; reasoning: string; raw: string }> {
  const prompt = judgePrompt.replace("{{input}}", input).replace("{{output}}", output);
  const raw = await chatCompletion(cfg, prompt, { signal: opts.signal, temperature: 0 });
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const data = JSON.parse(match ? match[0] : raw);
    return {
      score: Math.max(0, Math.min(1, Number(data.score ?? 0))),
      reasoning: String(data.reasoning ?? "").slice(0, 500),
      raw,
    };
  } catch {
    return { score: 0, reasoning: "评审结果解析失败（模型未按要求返回 JSON）", raw };
  }
}

/** 把任意异常整理成「一句话 + 怎么办」，供界面直接展示。 */
export function describeError(err: unknown): { message: string; hint?: string; detail?: string } {
  if (err instanceof LlmError) return { message: err.message, hint: err.hint, detail: err.detail };
  return { message: err instanceof Error ? err.message : String(err) };
}
