import { useCallback, useRef, useState } from "react";
import { ArrowRight, FileText, Lock, UploadCloud } from "lucide-react";
import JSZip from "jszip";
import { SAMPLE_SKILL } from "@/core/sampleSkill";
import { StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

export interface ImportedSkill {
  markdown: string;
  sourceName: string;
}

export function ImportStep({ onAnalyze }: { onAnalyze: (s: ImportedSkill) => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [pasted, setPasted] = useState("");
  const [loaded, setLoaded] = useState<ImportedSkill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      if (/\.zip$/i.test(file.name)) {
        const zip = await JSZip.loadAsync(file);
        const entry = Object.values(zip.files).find((f) => /(^|\/)SKILL\.md$/i.test(f.name));
        if (!entry) throw new Error("压缩包里没有找到 SKILL.md。");
        setLoaded({ markdown: await entry.async("string"), sourceName: entry.name });
      } else {
        setLoaded({ markdown: await file.text(), sourceName: file.name });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const analyze = () => {
    const source = loaded ?? (pasted.trim() ? { markdown: pasted, sourceName: "粘贴的-skill.md" } : null);
    if (source) onAnalyze(source);
  };

  return (
    <div>
      <StepHeading
        kicker="引导式流程"
        title="导入你的 Skill"
        sub="添加一个 SKILL.md 文件或 ZIP 压缩包，我们会分析它，并生成 Langfuse 可用的数据集与评分器。"
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className={cn(
          "flex flex-col items-center rounded-xl border-2 border-dashed bg-white px-6 py-12 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        <FileText className="h-10 w-10 text-primary/70" strokeWidth={1.4} />
        <p className="mt-4 text-[15px] font-semibold">把 SKILL.md 或 ZIP 拖到这里</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          支持单个 SKILL.md 文件，或包含 skill 的 .zip 压缩包
        </p>
        {loaded && (
          <p className="mt-3 rounded-full bg-emerald-50 px-3 py-1 font-code text-[11.5px] font-medium text-emerald-700">
            ✓ {loaded.sourceName} — {loaded.markdown.length.toLocaleString()} 字符
          </p>
        )}
        {error && <p className="mt-3 text-[12.5px] font-medium text-red-600">{error}</p>}
        <span className="my-4 text-[12px] text-muted-foreground">或</span>
        <button
          onClick={() => fileInput.current?.click()}
          className="rounded-lg border border-primary/40 bg-primary/5 px-5 py-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          选择文件
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,.zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <p className="mt-4 text-[11.5px] text-muted-foreground">支持 SKILL.md、.zip，最大 50 MB</p>
      </div>

      <div className="my-6 flex items-center gap-4 text-[12px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        或
        <span className="h-px flex-1 bg-border" />
      </div>

      <div>
        <p className="mb-2 text-[13px] font-semibold">直接粘贴 SKILL.md 内容</p>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={"---\nname: my-skill\ndescription: ...\n---\n\n# 我的 Skill\n..."}
          className="h-36 w-full resize-y rounded-lg border bg-white p-3.5 font-code text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={analyze}
          disabled={!loaded && !pasted.trim()}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-[14px] font-semibold text-white shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          开始分析 <ArrowRight className="h-4 w-4" />
        </button>
        <button
          onClick={() => onAnalyze({ markdown: SAMPLE_SKILL, sourceName: "内置示例：周报写作助手" })}
          className="rounded-lg border bg-white px-5 py-3 text-[13.5px] font-medium transition-colors hover:bg-muted"
        >
          使用示例 skill
        </button>
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="h-3.5 w-3.5" />
        全部在你的浏览器本地运行。除非你配置了模型，否则不会发送到任何外部服务。
      </p>

      <div className="mt-8 flex items-start gap-2 rounded-lg border bg-white p-4 text-[12.5px] text-muted-foreground">
        <UploadCloud className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          更习惯用终端？同一套引擎也提供命令行版本：{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-code text-[11.5px] text-foreground">
            npx tsx cli/skillfuse.ts ./SKILL.md --out ./out
          </code>
        </p>
      </div>
    </div>
  );
}
