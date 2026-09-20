/**
 * 常见 OpenAI 兼容端点的预设。
 * 只存 Base URL 与常用模型名——密钥永远只留在用户浏览器里。
 */

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** 常用模型，填入输入框的候选 */
  models: string[];
  /** 密钥获取地址，方便用户直接跳转 */
  keyUrl?: string;
  /** 该端点是否需要密钥（本地推理通常不需要） */
  needsKey: boolean;
  hint?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
  },
  {
    id: "kimi-coding",
    label: "Kimi for Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    models: ["kimi-for-coding"],
    keyUrl: "https://www.kimi.com/coding",
    needsKey: true,
    hint: "Kimi for Coding 订阅端点，K2.8 Preview 对应模型名 kimi-for-coding。该端点不向浏览器放行跨域，请开启下方的「本地代理转发」。",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-0905-preview"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    needsKey: true,
  },
  {
    id: "dashscope",
    label: "通义千问（DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    keyUrl: "https://bailian.console.aliyun.com/",
    needsKey: true,
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    keyUrl: "https://bigmodel.cn/usercenter/apikeys",
    needsKey: true,
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V3"],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    needsKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001"],
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5:7b", "llama3.1:8b"],
    needsKey: false,
    hint: "需以 OLLAMA_ORIGINS=* 启动，浏览器才能跨域访问本地服务。",
  },
  {
    id: "vllm",
    label: "本地 vLLM / LM Studio",
    baseUrl: "http://localhost:8000/v1",
    models: ["your-local-model"],
    needsKey: false,
    hint: "自建推理服务需要放开 CORS，否则浏览器会拦截请求。",
  },
  {
    id: "custom",
    label: "自定义端点",
    baseUrl: "",
    models: [],
    needsKey: true,
    hint: "任何兼容 /chat/completions 的端点都可以接入。",
  },
];

export function findProvider(id: string | undefined): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

/** 根据 Base URL 反查预设（老配置没有 providerId 时使用）。 */
export function guessProvider(baseUrl: string): ProviderPreset {
  const normalized = baseUrl.replace(/\/+$/, "");
  return (
    PROVIDERS.find((p) => p.baseUrl && normalized.startsWith(p.baseUrl.replace(/\/+$/, ""))) ??
    PROVIDERS[PROVIDERS.length - 1]
  );
}
