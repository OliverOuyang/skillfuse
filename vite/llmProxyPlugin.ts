/**
 * 开发/预览服务器里的模型请求中转。
 *
 * 浏览器直连大模型端点时，能不能成功取决于对方是否返回 CORS 头——
 * 绝大多数厂商（包括 Kimi、DeepSeek、通义等）都不为浏览器放行，
 * 于是「填了正确的密钥却一直连不上」。
 *
 * 这里在本机的 vite 服务上开一个中转：浏览器把目标地址放在 x-llm-target 头里，
 * 由 Node 侧发起真正的请求。请求仍然只在用户自己的机器上发出，密钥不经过任何第三方。
 * 仅 `npm run dev` / `npm run preview` 生效；纯静态部署下不存在该路径，
 * 前端会据此提示改用直连或本地运行。
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LLM_PROXY_HEADER, LLM_PROXY_PATH, LLM_TARGET_HEADER } from "../src/core/llmProxy";

type Next = (err?: unknown) => void;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fail(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader(LLM_PROXY_HEADER, "1");
  res.end(JSON.stringify({ error: { proxy: true, message } }));
}

async function handle(req: IncomingMessage, res: ServerResponse, next: Next) {
  if (!req.url?.startsWith(LLM_PROXY_PATH)) return next();

  const target = req.headers[LLM_TARGET_HEADER];
  if (typeof target !== "string" || !/^https?:\/\//i.test(target)) {
    return fail(res, 400, "缺少合法的 x-llm-target 目标地址");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = req.headers["authorization"];
  if (typeof auth === "string") headers.authorization = auth;

  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await readBody(req));

  try {
    const upstream = await fetch(target, { method: req.method ?? "POST", headers, body });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    res.setHeader(LLM_PROXY_HEADER, "1");
    res.end(buf);
  } catch (err) {
    // 到这里说明本机也连不上目标（DNS、网络策略、端口未开等）
    fail(res, 502, `本机无法连接到 ${target}：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function llmProxyPlugin(): Plugin {
  return {
    name: "skillfuse-llm-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}
