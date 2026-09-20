import { useCallback, useRef, useState } from "react";
import { ArrowRight, FileText, FolderOpen, Lock, UploadCloud } from "lucide-react";
import JSZip from "jszip";
import { SAMPLE_SKILL } from "@/core/sampleSkill";
import { buildSkillPackage, isReadableSize } from "@/core/package";
import type { SkillPackage } from "@/core/types";
import { StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

export interface ImportedSkill {
  pkg: SkillPackage;
}

export function ImportStep({ onAnalyze }: { onAnalyze: (s: ImportedSkill) => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [pasted, setPasted] = useState("");
  const [loaded, setLoaded] = useState<SkillPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const loadPackage = useCallback(
    async (files: { path: string; content: string }[], sourceName: string) => {
      setError(null);
      try {
        setLoaded(buildSkillPackage(files, sourceName));
      } catch (e) {
        setLoaded(null);
        setError((e as Error).message);
      }
    },
    [],
  );

  const handleZip = useCallback(
    async (file: File) => {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter((f) => !f.dir).slice(0, 300);
      const files = await Promise.all(
        entries.map(async (f) => ({ path: f.name, content: await f.async("string") })),
      );
      await loadPackage(files, file.name);
    },
    [loadPackage],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        if (/\.zip$/i.test(file.name)) {
          await handleZip(file);
        } else {
          await loadPackage([{ path: file.name, content: await file.text() }], file.name);
        }
      } catch (e) {
        setLoaded(null);
        setError((e as Error).message);
      }
    },
    [handleZip, loadPackage],
  );

  const analyze = () => {
    if (loaded) {
      onAnalyze({ pkg: loaded });
    } else if (pasted.trim()) {
      onAnalyze({ pkg: buildSkillPackage([{ path: "SKILL.md", content: pasted }], "粘贴的 SKILL.md") });
    }
  };

  const analyzeSample = () => {
    onAnalyze({ pkg: buildSkillPackage([{ path: "SKILL.md", content: SAMPLE_SKILL }], "内置示例：周报写作助手") });
  };

  const totalSize = loaded ? loaded.files.reduce((n, f) => n + f.size, 0) : 0;

  return (
    <div>
      <StepHeading
        kicker="引导式流程"
        title="导入你的 Skill"
        sub="添加整个 skill 目录或压缩包（SKILL.md + scripts/ + references/ + tests/…），导入时会对全部文件做企业级规范检查。"
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
          支持单个 SKILL.md、skill 目录，或包含完整 skill 的 .zip 压缩包
        </p>

        {loaded && (
          <div className="mt-4 w-full max-w-md rounded-lg border bg-muted/40 p-3 text-left">
            <p className="mb-2 flex items-center gap-1.5 font-code text-[11.5px] font-medium text-emerald-700">
              ✓ {loaded.sourceName} — {loaded.files.length} 个文件 · {(totalSize / 1024).toFixed(1)} KB
            </p>
            <ul className="max-h-36 space-y-0.5 overflow-y-auto font-code text-[11px] text-muted-foreground">
              {loaded.files.map((f) => (
                <li key={f.path} className="flex justify-between gap-3">
                  <span className="truncate">{f.path}</span>
                  <span className="shrink-0">{(f.size / 1024).toFixed(1)} KB</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="mt-3 text-[12.5px] font-medium text-red-600">{error}</p>}

        <span className="my-4 text-[12px] text-muted-foreground">或</span>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <button
            onClick={() => fileInput.current?.click()}
            className="rounded-lg border border-primary/40 bg-primary/5 px-5 py-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/10"
          >
            选择文件
          </button>
          <button
            onClick={() => dirInput.current?.click()}
            className="flex items-center gap-1.5 rounded-lg border bg-white px-5 py-2.5 text-[13px] font-semibold transition-colors hover:bg-muted"
          >
            <FolderOpen className="h-4 w-4" /> 选择 skill 文件夹
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,.zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={dirInput}
          type="file"
          // @ts-expect-error 非标准属性：启用目录选择
          webkitdirectory=""
          className="hidden"
          onChange={async (e) => {
            const list = Array.from(e.target.files ?? []);
            if (list.length > 0) {
              const files = await Promise.all(
                list
                  .filter((f) => isReadableSize(f.size))
                  .map(async (f) => ({
                    path: f.webkitRelativePath || f.name,
                    content: await f.text(),
                  })),
              );
              await loadPackage(files, list[0].name.split("/")[0] || "skill 目录");
            }
            e.target.value = "";
          }}
        />
        <p className="mt-4 text-[11.5px] text-muted-foreground">
          支持 SKILL.md、skill 文件夹、.zip；单文件 ≤ 2 MB，最多 300 个文件
        </p>
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
        {pasted.trim() && (
          <p className="mt-1.5 text-[11.5px] text-amber-700">
            仅粘贴 SKILL.md 时，目录结构类检查（tests/、scripts/ 等）将受限。
          </p>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={analyze}
          disabled={!loaded && !pasted.trim()}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-[14px] font-semibold text-white shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          导入并检查 <ArrowRight className="h-4 w-4" />
        </button>
        <button
          onClick={analyzeSample}
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
            npx tsx cli/skillfuse.ts ./my-skill --out ./out
          </code>
        </p>
      </div>
    </div>
  );
}
