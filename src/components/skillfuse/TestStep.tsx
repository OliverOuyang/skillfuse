import { useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, FlaskConical, RotateCcw, Sparkles, XCircle } from "lucide-react";
import type { Artifacts, ModelConfig, RuleCheck, RuleResult } from "@/core/types";
import { aggregate, runRuleChecks } from "@/core/runRules";
import { runJudge } from "@/core/llm";
import { StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

export function TestStep({
  artifacts,
  modelCfg,
  onBack,
  onRestart,
}: {
  artifacts: Artifacts;
  modelCfg: ModelConfig | null;
  onBack: () => void;
  onRestart: () => void;
}) {
  const rules = useMemo(() => JSON.parse(artifacts.ruleChecksJson) as RuleCheck[], [artifacts]);
  const [sample, setSample] = useState("");
  const [results, setResults] = useState<RuleResult[] | null>(null);
  const [judgeState, setJudgeState] = useState<
    { status: "idle" } | { status: "running" } | { status: "done"; score: number; reasoning: string } | { status: "error"; message: string }
  >({ status: "idle" });

  const score = results ? aggregate(results) : 0;

  const runRules = () => setResults(runRuleChecks(rules, sample));

  const runLlmJudge = async () => {
    if (!modelCfg) return;
    setJudgeState({ status: "running" });
    try {
      const r = await runJudge(modelCfg, artifacts.llmJudgePrompt, "(browser test run)", sample);
      setJudgeState({ status: "done", score: r.score, reasoning: r.reasoning });
    } catch (e) {
      setJudgeState({ status: "error", message: (e as Error).message.slice(0, 140) });
    }
  };

  return (
    <div>
      <StepHeading
        kicker="Step 4 · Test"
        title="Run and validate"
        sub="Paste any model output below to dry-run the deterministic rule scorers in your browser — the same checks ship as rule_scorers.py. If a model is configured, you can also fire the LLM judge."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* left: input */}
        <div>
          <p className="mb-2 font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sample model output
          </p>
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Paste a real (or draft) output from running your skill here…"
            className="h-[340px] w-full resize-y rounded-lg border bg-white p-3.5 font-code text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
          <div className="mt-3 flex gap-2.5">
            <button
              onClick={runRules}
              disabled={!sample.trim()}
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-primary/90 disabled:opacity-40"
            >
              <FlaskConical className="h-4 w-4" /> Run rule scorers
            </button>
            {modelCfg && (
              <button
                onClick={runLlmJudge}
                disabled={!sample.trim() || judgeState.status === "running"}
                className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2.5 text-[13px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                {judgeState.status === "running" ? "Judging…" : "Run LLM judge"}
              </button>
            )}
          </div>
        </div>

        {/* right: results */}
        <div>
          <p className="mb-2 font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Results
          </p>
          {!results && judgeState.status !== "done" ? (
            <div className="flex h-[340px] flex-col items-center justify-center rounded-lg border border-dashed bg-white text-center">
              <FlaskConical className="h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 text-[13px] text-muted-foreground">
                {rules.length} rule checks ready — paste an output and run them.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {results && (
                <div className="rounded-lg border bg-white p-4">
                  <div className="mb-3 flex items-end justify-between">
                    <div>
                      <p className="text-[26px] font-extrabold tracking-tight">
                        {(score * 100).toFixed(0)}
                        <span className="text-[14px] font-semibold text-muted-foreground"> / 100</span>
                      </p>
                      <p className="font-code text-[10.5px] uppercase tracking-wider text-muted-foreground">
                        weighted rule score
                      </p>
                    </div>
                    <p className="text-[12px] text-muted-foreground">
                      {results.filter((r) => r.passed).length}/{results.length} passed
                    </p>
                  </div>
                  <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full transition-all", score >= 0.8 ? "bg-emerald-500" : score >= 0.5 ? "bg-amber-400" : "bg-red-500")}
                      style={{ width: `${score * 100}%` }}
                    />
                  </div>
                  <ul className="space-y-2">
                    {results.map((r) => (
                      <li key={r.id} className="flex items-start gap-2.5 text-[12.5px]">
                        {r.passed ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                        ) : (
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                        )}
                        <div>
                          <p className="font-medium leading-snug">{r.name}</p>
                          <p className="font-code text-[11px] text-muted-foreground">{r.comment}</p>
                        </div>
                        <span className="ml-auto shrink-0 font-code text-[10.5px] text-muted-foreground">w{r.weight}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {judgeState.status === "done" && (
                <div className="rounded-lg border border-primary/25 bg-primary/5 p-4">
                  <p className="text-[20px] font-extrabold tracking-tight text-primary">
                    {judgeState.score.toFixed(2)}
                    <span className="ml-1.5 text-[12px] font-semibold text-muted-foreground">LLM judge score</span>
                  </p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/80">{judgeState.reasoning}</p>
                </div>
              )}
              {judgeState.status === "error" && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3.5 text-[12.5px] text-red-700">
                  LLM judge failed: {judgeState.message}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-lg border bg-white px-4 py-2.5 text-[13px] font-medium hover:bg-muted">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <button
          onClick={onRestart}
          className="flex items-center gap-1.5 rounded-lg border bg-white px-4 py-2.5 text-[13px] font-medium hover:bg-muted"
        >
          <RotateCcw className="h-4 w-4" /> Import another skill
        </button>
      </div>
    </div>
  );
}
