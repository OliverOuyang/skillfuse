import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Eye, EyeOff, Loader2, RefreshCw, Shuffle, TriangleAlert, Zap } from "lucide-react";
import type { ModelConfig } from "@/core/types";
import { LlmError, describeError, listModels, testConnection } from "@/core/llm";
import { PROVIDERS, findProvider, guessProvider } from "@/core/providers";
import { DEFAULT_MODEL_CONFIG, clearModelConfig, loadModelConfig, saveModelConfig } from "@/core/modelStore";
import { Badge, Button, Modal, SectionLabel, Toggle } from "@/components/ui";
import { cn } from "@/lib/utils";

type Probe =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; latencyMs: number; reply: string }
  | { status: "error"; message: string; hint?: string; suggestProxy?: boolean };

/** 仅在打开时挂载（由 App 控制），因此配置可以直接在初始化时读取。 */
export function ModelDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (cfg: ModelConfig | null) => void;
}) {
  const [cfg, setCfg] = useState<ModelConfig>(() => {
    const saved = loadModelConfig();
    return saved
      ? { ...DEFAULT_MODEL_CONFIG, ...saved, providerId: saved.providerId ?? guessProvider(saved.baseUrl).id }
      : DEFAULT_MODEL_CONFIG;
  });
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [probe, setProbe] = useState<Probe>({ status: "idle" });
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const provider = useMemo(() => findProvider(cfg.providerId), [cfg.providerId]);

  // 卸载时中止仍在跑的连接测试，避免结果回写到已卸载的界面
  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = useCallback((p: Partial<ModelConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    setProbe({ status: "idle" });
  }, []);

  const pickProvider = (id: string) => {
    const p = findProvider(id);
    setCfg((c) => ({
      ...c,
      providerId: id,
      baseUrl: p.baseUrl || c.baseUrl,
      model: p.models[0] ?? (id === "custom" ? c.model : ""),
      apiKey: p.needsKey ? c.apiKey : "",
    }));
    setModels(null);
    setProbe({ status: "idle" });
  };

  const ready = Boolean(cfg.baseUrl.trim() && cfg.model.trim() && (!provider.needsKey || cfg.apiKey.trim()));

  const runTest = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setProbe({ status: "running" });
    try {
      const r = await testConnection(cfg, ac.signal);
      setProbe({ status: "ok", latencyMs: r.latencyMs, reply: r.reply });
    } catch (e) {
      const d = describeError(e);
      setProbe({
        status: "error",
        message: d.message,
        hint: d.hint,
        // 跨域被拦是浏览器直连最常见的失败，直接给一个「开代理再试」的按钮
        suggestProxy: e instanceof LlmError && e.kind === "cors" && !cfg.useProxy,
      });
    }
  };

  const retryViaProxy = async () => {
    const next = { ...cfg, useProxy: true };
    setCfg(next);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setProbe({ status: "running" });
    try {
      const r = await testConnection(next, ac.signal);
      setProbe({ status: "ok", latencyMs: r.latencyMs, reply: r.reply });
    } catch (e) {
      const d = describeError(e);
      setProbe({ status: "error", message: d.message, hint: d.hint });
    }
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      setModels(await listModels(cfg));
    } catch (e) {
      const d = describeError(e);
      setProbe({ status: "error", message: `拉取模型列表失败：${d.message}`, hint: d.hint ?? "手填模型名同样可用。" });
      setModels(null);
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title="模型接入"
      sub={
        <>
          接入任意 OpenAI 兼容端点，用于<strong className="font-semibold text-foreground">补充数据集条目</strong>与
          <strong className="font-semibold text-foreground">运行 LLM 评审</strong>。
          密钥只写入当前浏览器的 localStorage，不会上传到任何服务器。
        </>
      }
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearModelConfig();
              onSave(null);
              onClose();
            }}
          >
            清除配置
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={runTest} disabled={!ready || probe.status === "running"}>
              {probe.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              测试连接
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => {
                saveModelConfig(cfg);
                onSave(cfg);
                onClose();
              }}
            >
              保存
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <SectionLabel className="mb-2">选择服务商</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => pickProvider(p.id)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                  cfg.providerId === p.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {provider.hint && <p className="mt-2 text-[11.5px] text-muted-foreground">{provider.hint}</p>}
        </div>

        <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3">
          <div className="pt-0.5">
            <Toggle
              checked={cfg.useProxy === true}
              onChange={(v) => patch({ useProxy: v })}
              label="本地代理转发"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold">
              <Shuffle className="h-3.5 w-3.5 text-primary" /> 本地代理转发
            </p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
              由本机的开发服务器代发请求，绕开厂商端点不给浏览器放行跨域的问题（Kimi、DeepSeek、通义等多数端点都需要）。
              请求仍然只从你自己的机器发出，密钥不经过第三方。仅 <code className="font-code">npm run dev</code> /{" "}
              <code className="font-code">npm run preview</code> 下可用。
            </p>
          </div>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Base URL" className="sm:col-span-2">
            <input
              className={inputCls}
              value={cfg.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              aria-label="Base URL"
              spellCheck={false}
            />
          </Field>

          <Field
            label="API key"
            className="sm:col-span-2"
            aside={
              provider.keyUrl ? (
                <a
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                >
                  获取密钥 <ExternalLink className="h-3 w-3" />
                </a>
              ) : undefined
            }
          >
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                className={cn(inputCls, "pr-10")}
                value={cfg.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                aria-label="API key"
                placeholder={provider.needsKey ? "sk-..." : "本地端点通常留空即可"}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                type="button"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </Field>

          <Field
            label="模型"
            className="sm:col-span-2"
            aside={
              <button
                onClick={fetchModels}
                disabled={loadingModels || !cfg.baseUrl.trim()}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
                type="button"
              >
                {loadingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                从端点拉取
              </button>
            }
          >
            <input
              className={inputCls}
              value={cfg.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="gpt-4o-mini / your-model-name"
              aria-label="模型"
              spellCheck={false}
              list="skillfuse-model-options"
            />
            <datalist id="skillfuse-model-options">
              {(models ?? provider.models).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {(models ?? provider.models).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(models ?? provider.models).slice(0, 12).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patch({ model: m })}
                    className={cn(
                      "rounded-md border px-2 py-1 font-code text-[11px] transition-colors",
                      cfg.model === m
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
                {models && models.length > 12 && (
                  <span className="self-center text-[11px] text-muted-foreground">等 {models.length} 个模型</span>
                )}
              </div>
            )}
          </Field>
        </div>

        <div>
          <button
            onClick={() => setAdvanced((a) => !a)}
            className="text-[12px] font-medium text-muted-foreground hover:text-foreground"
            type="button"
          >
            {advanced ? "收起高级参数" : "高级参数（温度 / 最大 token / 超时）"}
          </button>
          {advanced && (
            <div className="mt-3 grid gap-3.5 sm:grid-cols-3">
              <Field label={`温度 ${(cfg.temperature ?? 0.3).toFixed(1)}`}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={cfg.temperature ?? 0.3}
                  onChange={(e) => patch({ temperature: Number(e.target.value) })}
                  aria-label="温度"
                  className="w-full accent-[hsl(var(--primary))]"
                />
              </Field>
              <Field label="最大输出 token">
                <input
                  type="number"
                  min={0}
                  step={256}
                  className={inputCls}
                  value={cfg.maxTokens ?? 0}
                  onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
                  aria-label="最大输出 token"
                />
              </Field>
              <Field label="超时（秒）">
                <input
                  type="number"
                  min={5}
                  step={5}
                  className={inputCls}
                  aria-label="超时秒数"
                  value={Math.round((cfg.timeoutMs ?? 60_000) / 1000)}
                  onChange={(e) => patch({ timeoutMs: Math.max(5, Number(e.target.value)) * 1000 })}
                />
              </Field>
            </div>
          )}
        </div>

        {probe.status === "ok" && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            <div className="text-[12.5px]">
              <p className="font-semibold text-emerald-600 dark:text-emerald-400">
                连接成功 <Badge tone="success" className="ml-1">{probe.latencyMs} ms</Badge>
                <Badge tone="neutral" className="ml-1">
                  {cfg.useProxy ? "经本地代理" : "浏览器直连"}
                </Badge>
              </p>
              <p className="mt-0.5 text-muted-foreground">
                模型回声：<span className="font-code">{probe.reply || "（空）"}</span>
              </p>
            </div>
          </div>
        )}
        {probe.status === "error" && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-[12.5px]">
              <p className="font-semibold text-destructive">{probe.message}</p>
              {probe.hint && <p className="mt-0.5 leading-relaxed text-muted-foreground">{probe.hint}</p>}
              {probe.suggestProxy && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={retryViaProxy}>
                  <Shuffle className="h-3.5 w-3.5" /> 开启本地代理并重试
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

const inputCls =
  "w-full rounded-md border bg-card px-3 py-2 font-code text-[12.5px] outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20";

function Field({
  label,
  aside,
  className,
  children,
}: {
  label: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("block", className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {aside}
      </div>
      {children}
    </div>
  );
}
