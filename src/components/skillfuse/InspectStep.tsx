import { AlertTriangle, ArrowLeft, ArrowRight } from "lucide-react";
import type { ParsedSkill, SkillAnalysis } from "@/core/types";
import { StepHeading } from "./chrome";

export function InspectStep({
  skill,
  analysis,
  onBack,
  onNext,
}: {
  skill: ParsedSkill;
  analysis: SkillAnalysis;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <StepHeading
        kicker="Step 2 · Inspect"
        title={analysis.displayName}
        sub={analysis.description || "No description found in frontmatter — the generator will lean on section structure."}
      />

      {/* stat row */}
      <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sections" value={skill.sections.length} />
        <Stat label="Constraints" value={analysis.constraints.length} />
        <Stat label="Workflow steps" value={analysis.steps.length} />
        <Stat label="Examples" value={analysis.examples.length} />
      </div>

      {analysis.warnings.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> Things to know
          </p>
          <ul className="space-y-1">
            {analysis.warnings.map((w) => (
              <li key={w} className="text-[12.5px] text-amber-700">· {w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Detected output formats" items={analysis.formats} empty="No explicit formats detected" mono />
        <Panel title="Inputs the skill expects" items={analysis.inputs} empty="No input kinds detected" />
        <Panel title="Hard constraints (must / never)" items={analysis.constraints} empty="None detected" />
        <Panel title="Quality criteria" items={analysis.qualityCriteria} empty="None detected" />
        <Panel title="Workflow" items={analysis.steps} numbered empty="No numbered workflow found" />
        <Panel title="Tools & references" items={analysis.tools} empty="None detected" mono />
      </div>

      {analysis.triggerKeywords.length > 0 && (
        <div className="mt-4 rounded-lg border bg-white p-4">
          <p className="mb-2 font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Trigger keywords
          </p>
          <div className="flex flex-wrap gap-1.5">
            {analysis.triggerKeywords.map((t) => (
              <span key={t} className="rounded-full bg-primary/8 bg-primary/10 px-2.5 py-1 text-[12px] font-medium text-primary">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8 flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-lg border bg-white px-4 py-2.5 text-[13px] font-medium hover:bg-muted">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-[14px] font-semibold text-white shadow-sm hover:bg-primary/90"
        >
          Generate dataset & scorers <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-3.5">
      <p className="text-[26px] font-extrabold tracking-tight text-foreground">{value}</p>
      <p className="font-code text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}

function Panel({
  title,
  items,
  empty,
  numbered,
  mono,
}: {
  title: string;
  items: string[];
  empty: string;
  numbered?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <p className="mb-2.5 font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {items.length === 0 ? (
        <p className="text-[12.5px] italic text-muted-foreground/70">{empty}</p>
      ) : (
        <ul className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-foreground/90">
              <span className="mt-0.5 shrink-0 font-code text-[11px] text-primary/70">
                {numbered ? `${i + 1}.` : "·"}
              </span>
              <span className={mono ? "font-code text-[11.5px]" : undefined}>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
