import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ModelConfig } from "@/core/types";

const KEY = "skillfuse.modelConfig";

export function loadModelConfig(): ModelConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as ModelConfig;
    return cfg.baseUrl && cfg.apiKey && cfg.model ? cfg : null;
  } catch {
    return null;
  }
}

export function ModelDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (cfg: ModelConfig | null) => void;
}) {
  const [cfg, setCfg] = useState<ModelConfig>({ baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" });

  useEffect(() => {
    if (open) {
      const saved = loadModelConfig();
      if (saved) setCfg(saved);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[16px] font-bold tracking-tight">Model settings</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
          Optional. Point SkillFuse at any OpenAI-compatible endpoint — your own model included — to
          augment dataset items and run the LLM judge in the browser. The key is stored only in this
          browser's localStorage.
        </p>
        <div className="space-y-3.5">
          <Field label="Base URL">
            <input
              className="w-full rounded-md border bg-white px-3 py-2 font-code text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              value={cfg.baseUrl}
              onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </Field>
          <Field label="API key">
            <input
              type="password"
              className="w-full rounded-md border bg-white px-3 py-2 font-code text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              placeholder="sk-..."
            />
          </Field>
          <Field label="Model">
            <input
              className="w-full rounded-md border bg-white px-3 py-2 font-code text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              placeholder="gpt-4o-mini / your-model-name"
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-between">
          <button
            onClick={() => {
              localStorage.removeItem(KEY);
              onSave(null);
              onClose();
            }}
            className="rounded-md px-3 py-2 text-[12.5px] font-medium text-muted-foreground hover:bg-muted"
          >
            Clear
          </button>
          <button
            onClick={() => {
              localStorage.setItem(KEY, JSON.stringify(cfg));
              onSave(cfg);
              onClose();
            }}
            className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-primary/90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
