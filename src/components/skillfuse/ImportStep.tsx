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
        if (!entry) throw new Error("No SKILL.md found inside the zip.");
        setLoaded({ markdown: await entry.async("string"), sourceName: entry.name });
      } else {
        setLoaded({ markdown: await file.text(), sourceName: file.name });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const analyze = () => {
    const source = loaded ?? (pasted.trim() ? { markdown: pasted, sourceName: "pasted-skill.md" } : null);
    if (source) onAnalyze(source);
  };

  return (
    <div>
      <StepHeading
        kicker="Guided pipeline"
        title="Import your Skill"
        sub="Add a SKILL.md file or a ZIP folder and we'll analyze it to generate Langfuse-ready datasets and scorers."
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
        <p className="mt-4 text-[15px] font-semibold">Drag and drop your SKILL.md or ZIP here</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Supports a single SKILL.md file or a .zip folder with your skill
        </p>
        {loaded && (
          <p className="mt-3 rounded-full bg-emerald-50 px-3 py-1 font-code text-[11.5px] font-medium text-emerald-700">
            ✓ {loaded.sourceName} — {loaded.markdown.length.toLocaleString()} chars
          </p>
        )}
        {error && <p className="mt-3 text-[12.5px] font-medium text-red-600">{error}</p>}
        <span className="my-4 text-[12px] text-muted-foreground">or</span>
        <button
          onClick={() => fileInput.current?.click()}
          className="rounded-lg border border-primary/40 bg-primary/5 px-5 py-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          Choose files
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
        <p className="mt-4 text-[11.5px] text-muted-foreground">SKILL.md, .zip up to 50 MB</p>
      </div>

      <div className="my-6 flex items-center gap-4 text-[12px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <div>
        <p className="mb-2 text-[13px] font-semibold">Paste a SKILL.md directly</p>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={"---\nname: my-skill\ndescription: ...\n---\n\n# My Skill\n..."}
          className="h-36 w-full resize-y rounded-lg border bg-white p-3.5 font-code text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={analyze}
          disabled={!loaded && !pasted.trim()}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-[14px] font-semibold text-white shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Analyze Skill <ArrowRight className="h-4 w-4" />
        </button>
        <button
          onClick={() => onAnalyze({ markdown: SAMPLE_SKILL, sourceName: "sample: weekly-report-writer" })}
          className="rounded-lg border bg-white px-5 py-3 text-[13.5px] font-medium transition-colors hover:bg-muted"
        >
          Use sample skill
        </button>
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="h-3.5 w-3.5" />
        Runs locally in your browser. Nothing is sent to external services unless you configure a model.
      </p>

      <div className="mt-8 flex items-start gap-2 rounded-lg border bg-white p-4 text-[12.5px] text-muted-foreground">
        <UploadCloud className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Prefer the terminal? The same engine ships as a CLI:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-code text-[11.5px] text-foreground">
            npx tsx cli/skillfuse.ts ./SKILL.md --out ./out
          </code>
        </p>
      </div>
    </div>
  );
}
