/** 模型配置的本地持久化——密钥只留在当前浏览器，不随任何请求外发。 */
import type { ModelConfig } from "./types";
import { findProvider, guessProvider } from "./providers";

const KEY = "skillfuse.modelConfig";

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  providerId: "openai",
  temperature: 0.3,
  maxTokens: 2048,
  timeoutMs: 60_000,
};

export function loadModelConfig(): ModelConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as ModelConfig;
    if (!cfg.baseUrl || !cfg.model) return null;
    // 本地推理端点（Ollama / vLLM）通常不需要密钥
    const provider = findProvider(cfg.providerId ?? guessProvider(cfg.baseUrl).id);
    if (provider.needsKey && !cfg.apiKey) return null;
    return { ...DEFAULT_MODEL_CONFIG, ...cfg };
  } catch {
    return null;
  }
}

export function saveModelConfig(cfg: ModelConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 隐私模式下写入失败不影响本次会话使用 */
  }
}

export function clearModelConfig(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}
