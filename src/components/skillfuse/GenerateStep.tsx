import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Package, Sparkles } from "lucide-react";
import JSZip from "jszip";
import type { Artifacts, DatasetItem, ModelConfig, SkillAnalysis } from "@/core/types";
import { augmentDatasetItems } from "@/core/llm";
import { CodeView, CopyButton, DownloadButton, downloadText } from "./CodeView";
import { StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

interface Tab {
  id: keyof Artifacts | "dataset_items_aug";
  file: string;
  lang: string;
}

const TABS: Tab[] = [
  { id: "datasetSchema", file: "dataset_schema.json", lang: "json" },
  { id: "datasetItems", file: "dataset_items.json", lang: "json" },
  { id: "ruleScorersPy", file: "rule_scorers.py", lang: "python" },
  { id: "ruleChecksJson", file: "rule_checks.json", lang: "json" },
  { id: "llmJudgePrompt", file: "llm_judge_prompt.md", lang: "markdown" },
  { id: "llmJudgePy", file: "llm_judge.py", lang: "python" },
  { id: "langfuseConfigPy", file: "langfuse_config.py", lang: "python" },
  { id: "envExample", file: ".env.example", lang: "env" },
  { id: "packReadme", file: "README.md", lang: "markdown" },
];

export function GenerateStep({
  analysis,
  artifacts,
  modelCfg,
  onAugmented,
  onBack,
  onNext,
}: {
  analysis: SkillAnalysis;
  artifacts: Artifacts;
  modelCfg: ModelConfig | null;
  onAugmented: (items: DatasetItem[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [active, setActive] = useState<Tab>(TABS[0]);
  const [augmenting, setAugmenting] = useState(false);
  const [augMsg, setAugMsg] = useState<string | null>(null);

  const content = artifacts[active.id as keyof Artifacts] ?? "";

  const itemCount = useMemo(() => {
    try {
      return (JSON.parse(artifacts.datasetItems) as DatasetItem[]).length;
    } catch {
      return 0;
    }
  }, [artifacts.datasetItems]);

  const augment = async () => {
    if (!modelCfg) return;
    setAugmenting(true);
    setAugMsg(null);
    try {
      const existing = JSON.parse(artifacts.datasetItems) as DatasetItem[];
      const extra = await augmentDatasetItems(modelCfg, analysis, existing, 3);
      onAugmented(extra);
      setAugMsg(`+${extra.length} items added by ${modelCfg.model}`);
    } catch (e) {
      setAugMsg(`Augmentation failed: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setAugmenting(false);
    }
  };

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder(`${analysis.skillName}-eval`)!;
    for (const t of TABS) {
      folder.file(t.file, artifacts[t.id as keyof Artifacts] ?? "");
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${analysis.skillName}-eval.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <StepHeading
        kicker="Step 3 · Generate"
        title="Your evaluation pack"
        sub={`${itemCount} dataset items and ${JSON.parse(artifacts.ruleChecksJson).length} rule checks generated for "${analysis.skillName}". Everything below is ready to drop into a Langfuse project.`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={downloadZip}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm hover:bg-primary/90"
        >
          <Package className="h-4 w-4" /> Download pack (.zip)
        </button>
        {modelCfg ? (
          <button
            onClick={augment}
            disabled={augmenting}
            className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2.5 text-[13px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            {augmenting ? "Asking your model…" : "Augment items with your model"}
          </button>
        ) : (
          <span className="text-[12px] text-muted-foreground">
            Tip: configure a model (top right) to augment dataset items with your own LLM.
          </span>
        )}
        {augMsg && <span className="font-code text-[11.5px] text-muted-foreground">{augMsg}</span>}
      </div>

      <div className="rounded-xl border bg-white">
        <div className="flex flex-wrap gap-0 border-b px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t)}
              className={cn(
                "rounded-t-md border-b-2 px-3 py-2 font-code text-[11.5px] font-medium transition-colors",
                active.id === t.id
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.file}
            </button>
          ))}
        </div>
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-code text-[12px] text-muted-foreground">{active.file}</p>
            <div className="flex gap-2">
              <CopyButton text={content} />
              <DownloadButton
                filename={active.file}
                content={content}
                label="Download"
              />
            </div>
          </div>
          <CodeView code={content} lang={active.lang} />
        </div>
      </div>

      <div className="mt-6 rounded-lg border bg-white p-4 text-[12.5px] leading-relaxed text-muted-foreground">
        <p className="mb-1 font-semibold text-foreground">Quick start with Langfuse</p>
        <code
          className="block cursor-pointer whitespace-pre rounded bg-muted p-2.5 font-code text-[11.5px] text-foreground"
          onClick={() => downloadText("quickstart.sh", QUICKSTART)}
        >
          {QUICKSTART}
        </code>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-lg border bg-white px-4 py-2.5 text-[13px] font-medium hover:bg-muted">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-[14px] font-semibold text-white shadow-sm hover:bg-primary/90"
        >
          Test the scorers <ArrowLeft className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const QUICKSTART = `pip install langfuse openai python-dotenv
cp .env.example .env   # fill in your Langfuse keys
python langfuse_config.py`;
