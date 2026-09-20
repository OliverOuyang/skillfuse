import { useMemo, useState } from "react";
import { Check, Copy, Download, Search, WrapText } from "lucide-react";
import { downloadText } from "./download";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* 轻量高亮：只为 json / python / markdown / env 四种产物做词法着色，  */
/* 不引入几百 KB 的高亮库。                                            */
/* ------------------------------------------------------------------ */

type Token = { text: string; cls?: string };

const CLS = {
  str: "text-[#a5e3a0]",
  key: "text-[#8fb9ff]",
  num: "text-[#f0b775]",
  kw: "text-[#c792ea]",
  com: "text-[#6b7280] italic",
  punc: "text-[#8b8ba0]",
  head: "text-[#8fb9ff] font-semibold",
  em: "text-[#f0b775]",
};

const PY_KEYWORDS =
  /\b(def|class|return|import|from|as|if|elif|else|for|while|try|except|finally|with|lambda|None|True|False|and|or|not|in|is|raise|yield|pass|break|continue|global|assert|async|await)\b/;

const PATTERNS: Record<string, { re: RegExp; cls: (m: RegExpExecArray) => string | undefined }> = {
  json: {
    re: /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],:])/g,
    cls: (m) => (m[1] ? CLS.key : m[2] ? CLS.str : m[3] ? CLS.num : m[4] ? CLS.kw : CLS.punc),
  },
  python: {
    re: new RegExp(
      [
        /(#[^\n]*)/.source,
        /("""[\s\S]*?"""|'''[\s\S]*?''')/.source,
        /(r?"(?:[^"\\]|\\.)*"|r?'(?:[^'\\]|\\.)*')/.source,
        /(@\w+)/.source,
        PY_KEYWORDS.source,
        /(\b\d+(?:\.\d+)?\b)/.source,
      ].join("|"),
      "g",
    ),
    cls: (m) =>
      m[1] ? CLS.com : m[2] || m[3] ? CLS.str : m[4] ? CLS.em : m[5] ? CLS.kw : m[6] ? CLS.num : undefined,
  },
  markdown: {
    re: /(^#{1,6} .*$)|(\*\*[^*]+\*\*)|(`[^`\n]+`)|(^\s*[-*] )|(\[[^\]]+\]\([^)]+\))/gm,
    cls: (m) => (m[1] ? CLS.head : m[2] ? CLS.em : m[3] ? CLS.str : m[4] ? CLS.punc : CLS.key),
  },
  env: {
    re: /(^#[^\n]*$)|(^[A-Z0-9_]+(?==))|(=.*$)/gm,
    cls: (m) => (m[1] ? CLS.com : m[2] ? CLS.key : CLS.str),
  },
};

function tokenize(code: string, lang: string): Token[] {
  const spec = PATTERNS[lang];
  if (!spec) return [{ text: code }];
  const out: Token[] = [];
  let last = 0;
  spec.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = spec.re.exec(code))) {
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    out.push({ text: m[0], cls: spec.cls(m) });
    last = m.index + m[0].length;
    if (m[0].length === 0) spec.re.lastIndex++; // 防御空匹配导致的死循环
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}

export function CodeView({
  code,
  lang,
  maxHeight = 460,
  searchable = false,
}: {
  code: string;
  lang: string;
  maxHeight?: number;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);

  const lines = useMemo(() => code.split("\n"), [code]);
  const filtered = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return lines
      .map((text, i) => ({ text, n: i + 1 }))
      .filter((l) => l.text.toLowerCase().includes(q));
  }, [lines, query]);

  const rendered = useMemo(() => (filtered ? null : tokenize(code, lang)), [code, lang, filtered]);

  return (
    <div className="overflow-hidden rounded-lg border bg-code-bg">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3.5 py-2">
        <span className="font-code text-[11px] font-medium uppercase tracking-wider text-white/45">{lang}</span>
        <div className="flex items-center gap-2">
          {searchable && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/35" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="在文件内搜索"
                className="h-7 w-36 rounded-md border border-white/10 bg-white/5 pl-7 pr-2 font-code text-[11px] text-white/80 outline-none placeholder:text-white/30 focus:border-white/25 sm:w-48"
              />
            </div>
          )}
          <button
            onClick={() => setWrap((w) => !w)}
            title={wrap ? "关闭自动换行" : "开启自动换行"}
            className={cn(
              "rounded p-1 transition-colors hover:bg-white/10",
              wrap ? "text-white/80" : "text-white/35",
            )}
          >
            <WrapText className="h-3.5 w-3.5" />
          </button>
          <span className="font-code text-[11px] text-white/35">{lines.length} 行</span>
        </div>
      </div>

      <div className="overflow-auto scroll-slim" style={{ maxHeight }}>
        {filtered ? (
          filtered.length === 0 ? (
            <p className="p-4 font-code text-[12px] text-white/40">没有匹配「{query}」的行</p>
          ) : (
            <table className="w-full border-collapse font-code text-[12px] leading-relaxed text-code-fg">
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.n}>
                    <td className="w-12 select-none border-r border-white/5 px-2 text-right align-top text-white/25">
                      {l.n}
                    </td>
                    <td className={cn("px-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <pre
            className={cn(
              "p-4 font-code text-[12px] leading-relaxed text-code-fg",
              wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
            )}
          >
            <code>
              {rendered?.map((t, i) => (
                <span key={i} className={t.cls}>
                  {t.text}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "已复制" : label}
    </button>
  );
}

export function DownloadButton({ filename, content, label }: { filename: string; content: string; label: string }) {
  return (
    <button
      onClick={() => downloadText(filename, content)}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
    >
      <Download className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
