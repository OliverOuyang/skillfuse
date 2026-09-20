import { useCallback, useRef, useState } from "react";
import { ArrowRight, FileText, FolderOpen, Loader2, Lock, Sparkles, Terminal, Trash2, UploadCloud } from "lucide-react";
import JSZip from "jszip";
import { SAMPLE_SKILL } from "@/core/sampleSkill";
import { buildSkillPackage, isReadableSize } from "@/core/package";
import type { SkillPackage } from "@/core/types";
import { Badge, Button, Card, SectionLabel } from "@/components/ui";
import { useToast } from "@/components/ui/toast-context";
import { StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

export interface ImportedSkill {
  pkg: SkillPackage;
}

export function ImportStep({ onAnalyze }: { onAnalyze: (s: ImportedSkill) => void }) {
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [loaded, setLoaded] = useState<SkillPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const loadPackage = useCallback(
    async (files: { path: string; content: string }[], sourceName: string) => {
      setError(null);
      try {
        const pkg = buildSkillPackage(files, sourceName);
        setLoaded(pkg);
        toast({ kind: "success", message: `已读取 ${pkg.files.length} 个文件`, detail: pkg.sourceName });
      } catch (e) {
        setLoaded(null);
        setError((e as Error).message);
      }
    },
    [toast],
  );

  const handleZip = useCallback(
    async (file: File) => {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files)
        .filter((f) => !f.dir)
        .slice(0, 300);
      const files = await Promise.all(entries.map(async (f) => ({ path: f.name, content: await f.async("string") })));
      await loadPackage(files, file.name);
    },
    [loadPackage],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      try {
        if (/\.zip$/i.test(file.name)) {
          await handleZip(file);
        } else {
          await loadPackage([{ path: file.name, content: await file.text() }], file.name);
        }
      } catch (e) {
        setLoaded(null);
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [handleZip, loadPackage],
  );

  const analyze = () => {
    if (loaded) onAnalyze({ pkg: loaded });
    else if (pasted.trim())
      onAnalyze({ pkg: buildSkillPackage([{ path: "SKILL.md", content: pasted }], "粘贴的 SKILL.md") });
  };

  const analyzeSample = () =>
    onAnalyze({ pkg: buildSkillPackage([{ path: "SKILL.md", content: SAMPLE_SKILL }], "内置示例：周报写作助手") });

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
          "flex flex-col items-center rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        {busy ? (
          <Loader2 className="h-10 w-10 animate-spin text-primary/70" strokeWidth={1.4} />
        ) : (
          <FileText className="h-10 w-10 text-primary/70" strokeWidth={1.4} />
        )}
        <p className="mt-4 text-[15px] font-semibold">{busy ? "正在读取…" : "把 SKILL.md 或 ZIP 拖到这里"}</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          支持单个 SKILL.md、skill 目录，或包含完整 skill 的 .zip 压缩包
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <Button variant="subtle" onClick={() => fileInput.current?.click()}>
            <UploadCloud className="h-4 w-4" /> 选择文件
          </Button>
          <Button variant="secondary" onClick={() => dirInput.current?.click()}>
            <FolderOpen className="h-4 w-4" /> 选择 skill 文件夹
          </Button>
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
            if (list.length === 0) return;
            setBusy(true);
            try {
              const files = await Promise.all(
                list
                  .filter((f) => isReadableSize(f.size))
                  .map(async (f) => ({ path: f.webkitRelativePath || f.name, content: await f.text() })),
              );
              await loadPackage(files, list[0].webkitRelativePath?.split("/")[0] || "skill 目录");
            } finally {
              setBusy(false);
              e.target.value = "";
            }
          }}
        />
        <p className="mt-4 text-[11.5px] text-muted-foreground">
          单文件 ≤ 2 MB，最多 300 个文件 · 只读取文本内容
        </p>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] font-medium text-destructive">
          {error}
        </p>
      )}

      {loaded && (
        <Card className="mt-3 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <Badge tone="success">已载入</Badge>
            <span className="truncate text-[13px] font-semibold">{loaded.sourceName}</span>
            <span className="font-code text-[11.5px] text-muted-foreground">
              {loaded.files.length} 个文件 · {(totalSize / 1024).toFixed(1)} KB
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground hover:text-destructive"
              onClick={() => setLoaded(null)}
            >
              <Trash2 className="h-3.5 w-3.5" /> 移除
            </Button>
          </div>
          <ul className="max-h-44 space-y-0.5 overflow-y-auto px-4 py-2.5 font-code text-[11.5px] text-muted-foreground scroll-slim">
            {loaded.files.map((f) => (
              <li key={f.path} className="flex justify-between gap-3">
                <span className={cn("truncate", f.path === loaded.skillMd.path && "font-semibold text-primary")}>
                  {f.path}
                </span>
                <span className="shrink-0">{(f.size / 1024).toFixed(1)} KB</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="my-6 flex items-center gap-4 text-[12px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />或<span className="h-px flex-1 bg-border" />
      </div>

      <div>
        <SectionLabel className="mb-2">直接粘贴 SKILL.md 内容</SectionLabel>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={"---\nname: my-skill\ndescription: ...\n---\n\n# 我的 Skill\n..."}
          className="h-36 w-full resize-y rounded-lg border bg-card p-3.5 font-code text-[12px] leading-relaxed outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        {pasted.trim() && !loaded && (
          <p className="mt-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">
            仅粘贴 SKILL.md 时，目录结构类检查（tests/、scripts/ 等）将受限。
          </p>
        )}
        {pasted.trim() && loaded && (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">已载入文件包，粘贴内容将被忽略。</p>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={analyze} disabled={busy || (!loaded && !pasted.trim())}>
          导入并检查 <ArrowRight className="h-4 w-4" />
        </Button>
        <Button variant="secondary" onClick={analyzeSample}>
          <Sparkles className="h-4 w-4" /> 使用示例 skill
        </Button>
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="h-3.5 w-3.5" />
        全部在你的浏览器本地运行。除非你配置了模型，否则不会发送到任何外部服务。
      </p>

      <Card className="mt-8 flex items-start gap-2 p-4 text-[12.5px] text-muted-foreground">
        <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          更习惯用终端？同一套引擎也提供命令行版本：{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-code text-[11.5px] text-foreground">
            npx tsx cli/skillfuse.ts ./my-skill --out ./out
          </code>
        </p>
      </Card>
    </div>
  );
}
