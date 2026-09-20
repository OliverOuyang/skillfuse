import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";

export function CodeView({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-[#14141c]">
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2">
        <span className="font-code text-[11px] font-medium uppercase tracking-wider text-white/50">{lang}</span>
      </div>
      <pre className="max-h-[460px] overflow-auto p-4 font-code text-[12px] leading-relaxed text-[#d6d6e0]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="flex items-center gap-1.5 rounded-md border bg-white px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "已复制" : label}
    </button>
  );
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DownloadButton({ filename, content, label }: { filename: string; content: string; label: string }) {
  return (
    <button
      onClick={() => downloadText(filename, content)}
      className="flex items-center gap-1.5 rounded-md border bg-white px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
    >
      <Download className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
