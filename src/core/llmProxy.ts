/**
 * 本机中转的路径常量。
 * 前端（llm.ts）与 vite 插件共用，避免两边写死的字符串对不上。
 */
export const LLM_PROXY_PATH = "/__llm-proxy";

/** 中转响应会带上这个头，前端据此判断「本地代理是否真的存在」。 */
export const LLM_PROXY_HEADER = "x-llm-proxy";

/** 目标地址通过这个请求头传给中转层。 */
export const LLM_TARGET_HEADER = "x-llm-target";
