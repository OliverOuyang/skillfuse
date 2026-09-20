import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Eraser,
  FlaskConical,
  History,
  Loader2,
  RotateCcw,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { Artifacts, DatasetItem, ModelConfig, RuleCheck, RuleResult, SkillAnalysis } from "@/core/types";
import { aggregate, ruleFixHint, runRuleChecks } from "@/core/runRules";
import { JUDGE_DIMENSIONS, type JudgeResult, describeError, runJudge } from "@/core/llm";
import { Badge, Button, Card, Collapsible, EmptyState, ScoreRing, SectionLabel, Toggle } from "@/components/ui";
import { useToast } from "@/components/ui/toast-context";
import { downloadText } from "./download";
import { StepFooter, StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

interface RunRecord {
  at: number;
  ruleScore: number;
  judgeScore?: number;
  passed: number;
  total: number;
  sample: string;
}

type JudgeState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: JudgeResult }
  | { status: "error"; message: string; hint?: string };

export function TestStep({
  artifacts,
  analysis,
  items,
  modelCfg,
  onBack,
  onRestart,
  onOpenModelSettings,
}: {
  artifacts: Artifacts;
  analysis: SkillAnalysis | null;
  items: DatasetItem[];
  modelCfg: ModelConfig | null;
  onBack: () => void;
  onRestart: () => void;
  onOpenModelSettings: () => void;
}) {
  const toast = useToast();
  const rules = useMemo(() => JSON.parse(artifacts.ruleChecksJson) as RuleCheck[], [artifacts]);

  const [sample, setSample] = useState("");
  const [live, setLive] = useState(true);
  const [manualResults, setManualResults] = useState<RuleResult[] | null>(null);
  const [judge, setJudge] = useState<JudgeState>({ status: "idle" });
  const [itemIdx, setItemIdx] = useState(0);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  /* 规则跑一次只是几个正则，够快，实时模式直接推导即可——不需要 effect 同步状态 */
  const results = useMemo(
    () => (live ? (sample.trim() ? runRuleChecks(rules, sample) : null) : manualResults),
    [live, sample, rules, manualResults],
  );
  const score = results ? aggregate(results) : 0;
  const judgeInput = useMemo(() => taskOf(items[itemIdx]) || "（未选择数据集条目）", [items, itemIdx]);

  const record = useCallback(
    (res: RuleResult[], judgeScore?: number) =>
      setHistory((h) =>
        [
          {
            at: Date.now(),
            ruleScore: aggregate(res),
            judgeScore,
            passed: res.filter((r) => r.passed).length,
            total: res.length,
            sample,
          },
          ...h,
        ].slice(0, 6),
      ),
    [sample],
  );

  const runRules = () => {
    const res = runRuleChecks(rules, sample);
    setManualResults(res);
    record(res);
  };

  const runLlmJudge = async () => {
    if (!modelCfg) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setJudge({ status: "running" });
    try {
      const r = await runJudge(modelCfg, artifacts.llmJudgePrompt, judgeInput, sample, { signal: ac.signal });
      setJudge({ status: "done", result: r });
      const res = results ?? runRuleChecks(rules, sample);
      setManualResults(res);
      record(res, r.score);
      if (!r.parsed) toast({ kind: "error", message: "评审返回的不是合法 JSON", detail: "已展示原始回复供排查" });
    } catch (e) {
      const d = describeError(e);
      setJudge({ status: "error", message: d.message, hint: d.hint });
      toast({ kind: "error", message: `LLM 评审失败：${d.message}`, detail: d.hint });
    }
  };

  const fillFromExample = () => {
    const code = analysis?.examples[0]?.code;
    if (code) {
      setSample(code);
      toast({ kind: "info", message: "已填入 skill 正文里的示例输出" });
    }
  };

  const fillSkeleton = () => {
    setSample(buildSkeleton(analysis));
    toast({ kind: "info", message: "已按预期结构生成骨架", detail: "改成真实输出后再跑分更有意义" });
  };

  const exportReport = () => {
    if (!results) return;
    downloadText(
      `${analysis?.skillName ?? "skill"}-dryrun.md`,
      buildReport(analysis?.skillName ?? "skill", results, score, judge, sample),
      "text/markdown",
    );
    toast({ kind: "success", message: "试运行报告已导出" });
  };

  const failed = results?.filter((r) => !r.passed) ?? [];

  return (
    <div>
      <StepHeading
        kicker="第 4 步 · 试运行"
        title="验证评分器"
        sub="把任意模型输出粘到左边，右边即时给出确定性规则得分——与生成的 rule_scorers.py 是同一套逻辑、同一个分数。接入模型后还能直接跑 LLM 评审。"
        right={
          results && (
            <Button variant="secondary" size="sm" onClick={exportReport}>
              <Download className="h-3.5 w-3.5" /> 导出试运行报告
            </Button>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- 输入 ---------- */}
        <div className="space-y-3">
          <Card className="p-3.5">
            <SectionLabel className="mb-1.5">评审输入（作为 judge 的 input）</SectionLabel>
            {items.length > 0 ? (
              <select
                value={itemIdx}
                onChange={(e) => setItemIdx(Number(e.target.value))}
                className="h-9 w-full rounded-lg border bg-card px-2 text-[12.5px] outline-none focus:border-primary"
              >
                {items.map((it, i) => (
                  <option key={i} value={i}>
                    #{i + 1} · {taskOf(it).slice(0, 60) || "（空任务）"}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">没有数据集条目，评审将只看输出本身。</p>
            )}
          </Card>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <SectionLabel>模型输出示例</SectionLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                {analysis?.examples.length ? (
                  <Button variant="ghost" size="sm" onClick={fillFromExample}>
                    <Wand2 className="h-3.5 w-3.5" /> 填入 skill 示例
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={fillSkeleton}>
                  <Wand2 className="h-3.5 w-3.5" /> 生成结构骨架
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSample("")} disabled={!sample}>
                  <Eraser className="h-3.5 w-3.5" /> 清空
                </Button>
              </div>
            </div>
            <textarea
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder="把跑 skill 得到的真实（或草稿）输出粘贴到这里…"
              className="h-[320px] w-full resize-y rounded-lg border bg-card p-3.5 font-code text-[12px] leading-relaxed outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
            <div className="mt-1.5 flex items-center justify-between text-[11.5px] text-muted-foreground">
              <span className="font-code">
                {sample.length} 字符 · 加权长度 {weightedLength(sample)}
              </span>
              <label className="flex items-center gap-2">
                实时评分
                <Toggle checked={live} onChange={setLive} label="实时评分" />
              </label>
            </div>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <Button variant="primary" onClick={runRules} disabled={!sample.trim()}>
              <FlaskConical className="h-4 w-4" /> 运行规则评分
            </Button>
            {modelCfg ? (
              <>
                <Button
                  variant="subtle"
                  onClick={runLlmJudge}
                  disabled={!sample.trim() || judge.status === "running"}
                >
                  {judge.status === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {judge.status === "running" ? "评审中…" : "运行 LLM 评审"}
                </Button>
                {judge.status === "running" && (
                  <Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                    取消
                  </Button>
                )}
              </>
            ) : (
              <Button variant="secondary" onClick={onOpenModelSettings}>
                <Sparkles className="h-4 w-4" /> 接入模型以运行评审
              </Button>
            )}
          </div>
        </div>

        {/* ---------- 结果 ---------- */}
        <div className="space-y-3">
          <SectionLabel>结果</SectionLabel>
          {!results && judge.status === "idle" ? (
            <EmptyState
              icon={FlaskConical}
              title={`${rules.length} 条规则检查已就绪`}
              sub="粘贴一段输出，或用上方按钮生成一份结构骨架试试。"
            />
          ) : (
            <>
              {results && (
                <Card className="p-4">
                  <div className="flex items-center gap-5">
                    <ScoreRing
                      value={score * 100}
                      size={92}
                      tone={score >= 0.8 ? "success" : score >= 0.5 ? "warning" : "danger"}
                      caption="加权规则得分"
                    />
                    {judge.status === "done" && (
                      <ScoreRing
                        value={judge.result.score * 100}
                        size={92}
                        tone={
                          judge.result.score >= 0.8 ? "success" : judge.result.score >= 0.5 ? "warning" : "danger"
                        }
                        caption="LLM 评审得分"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold">
                        {results.filter((r) => r.passed).length}/{results.length} 条规则通过
                      </p>
                      {failed.length > 0 ? (
                        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                          未通过：{failed.map((f) => f.name).join("、")}
                        </p>
                      ) : (
                        <p className="mt-1 text-[12.5px] text-emerald-600 dark:text-emerald-400">
                          全部规则通过。
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {results && (
                <div className="space-y-2">
                  {results.map((r) => (
                    <RuleResultRow key={r.id} result={r} rule={rules.find((x) => x.id === r.id)} />
                  ))}
                </div>
              )}

              {judge.status === "done" && <JudgeCard result={judge.result} />}
              {judge.status === "error" && (
                <Card className="border-destructive/30 bg-destructive/5 p-3.5 text-[12.5px] leading-relaxed">
                  <p className="font-semibold text-destructive">LLM 评审失败：{judge.message}</p>
                  {judge.hint && <p className="mt-1 text-muted-foreground">{judge.hint}</p>}
                  <Button variant="secondary" size="sm" className="mt-2" onClick={onOpenModelSettings}>
                    打开模型设置
                  </Button>
                </Card>
              )}
            </>
          )}

          {history.length > 0 && (
            <Collapsible title="试运行历史" subtitle={`最近 ${history.length} 次`} right={<History className="h-3.5 w-3.5 text-muted-foreground" />}>
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.at} className="flex items-center gap-2 text-[12px]">
                    <span className="font-code text-muted-foreground">
                      {new Date(h.at).toLocaleTimeString("zh-CN", { hour12: false })}
                    </span>
                    <Badge tone={h.ruleScore >= 0.8 ? "success" : h.ruleScore >= 0.5 ? "warning" : "danger"}>
                      规则 {(h.ruleScore * 100).toFixed(0)}
                    </Badge>
                    {h.judgeScore !== undefined && <Badge tone="primary">评审 {h.judgeScore.toFixed(2)}</Badge>}
                    <span className="text-muted-foreground">
                      {h.passed}/{h.total} 通过
                    </span>
                    <button
                      onClick={() => setSample(h.sample)}
                      className="ml-auto shrink-0 font-medium text-primary hover:underline"
                    >
                      恢复这次输入
                    </button>
                  </li>
                ))}
              </ul>
            </Collapsible>
          )}
        </div>
      </div>

      <StepFooter>
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> 上一步
        </Button>
        <Button variant="secondary" onClick={onRestart}>
          <RotateCcw className="h-4 w-4" /> 导入另一个 skill
        </Button>
      </StepFooter>
    </div>
  );
}

/* ---------------- 单条规则结果 ---------------- */

function RuleResultRow({ result, rule }: { result: RuleResult; rule?: RuleCheck }) {
  const [open, setOpen] = useState(false);
  const hint = rule && !result.passed ? ruleFixHint(rule) : "";

  return (
    <Card className={cn("overflow-hidden", !result.passed && "border-destructive/30")}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left">
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
            result.passed ? "bg-emerald-500" : "bg-destructive",
          )}
        >
          {result.passed ? "✓" : "✕"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium leading-snug">{result.name}</span>
          <span className="block font-code text-[11px] text-muted-foreground">{result.comment}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Badge tone="neutral">w{result.weight}</Badge>
          {(hint || rule) && (
            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          )}
        </span>
      </button>
      {open && (
        <div className="border-t bg-muted/40 px-3.5 py-2.5 text-[12px] leading-relaxed">
          {rule && <p className="text-muted-foreground">{rule.description}</p>}
          {rule && <p className="mt-1 text-[11.5px] text-muted-foreground/80">来源：{rule.source}</p>}
          {hint && <p className="mt-1.5 font-medium text-foreground">怎么改：{hint}</p>}
        </div>
      )}
    </Card>
  );
}

/* ---------------- 评审结果 ---------------- */

function JudgeCard({ result }: { result: JudgeResult }) {
  return (
    <Card className="border-primary/25 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[18px] font-extrabold tracking-tight text-primary">{result.score.toFixed(2)}</p>
        <SectionLabel>LLM 评审得分</SectionLabel>
        {result.constraintViolation && <Badge tone="danger">违反硬约束</Badge>}
        {!result.parsed && <Badge tone="warning">未按 rubric 返回 JSON</Badge>}
      </div>

      {result.parsed && (
        <div className="mt-3 space-y-2">
          {JUDGE_DIMENSIONS.map((d) => {
            const v = result.dimensions[d.key];
            return (
              <div key={d.key} className="flex items-center gap-2.5">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{d.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70 transition-all"
                    style={{ width: `${((v ?? 0) / 5) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right font-code text-[11.5px]">{v ?? "—"}</span>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[12.5px] leading-relaxed text-foreground/85">{result.reasoning}</p>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11.5px] text-muted-foreground hover:text-foreground">
          查看模型原始回复
        </summary>
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-card p-2.5 font-code text-[11px] leading-relaxed scroll-slim">
          {result.raw}
        </pre>
      </details>
    </Card>
  );
}

/* ---------------- helpers ---------------- */

function taskOf(item: DatasetItem | undefined): string {
  const input = (item?.input ?? {}) as Record<string, unknown>;
  return typeof input.task === "string" ? input.task : "";
}

function weightedLength(text: string): number {
  let n = 0;
  for (const c of text.replace(/\s/g, "")) {
    n += /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(c) ? 2 : 1;
  }
  return n;
}

/** 按 skill 声明的输出结构拼一份骨架，方便快速试跑规则。 */
function buildSkeleton(a: SkillAnalysis | null): string {
  const sections = a?.outputFields.length ? a.outputFields : a?.outputSections.length ? a.outputSections : ["结论", "细节", "下一步"];
  const lines = [`# ${a?.displayName ?? "示例输出"}`, ""];
  for (const s of sections.slice(0, 6)) {
    lines.push(`## ${s}`, "", "（在这里替换成真实内容）", "");
  }
  if (a?.formats.includes("table")) {
    lines.push("| 项目 | 状态 | 说明 |", "| --- | --- | --- |", "| 示例 | 进行中 | 替换成真实数据 |", "");
  }
  if (a?.formats.includes("code")) lines.push("```python", "print(\"replace me\")", "```", "");
  return lines.join("\n");
}

function buildReport(
  skillName: string,
  results: RuleResult[],
  score: number,
  judge: JudgeState,
  sample: string,
): string {
  const lines = [
    `# 试运行报告 — ${skillName}`,
    "",
    `- 加权规则得分：**${(score * 100).toFixed(0)}/100**`,
    `- 通过 ${results.filter((r) => r.passed).length}/${results.length} 条规则`,
  ];
  if (judge.status === "done") {
    lines.push(`- LLM 评审得分：**${judge.result.score.toFixed(2)}**`);
    if (judge.result.constraintViolation) lines.push("- ⚠️ 评审判定违反硬约束");
  }
  lines.push("", "## 规则明细", "");
  for (const r of results) {
    lines.push(`- ${r.passed ? "✅" : "❌"} **${r.name}**（权重 ${r.weight}）— ${r.comment}`);
  }
  if (judge.status === "done") {
    lines.push("", "## 评审理由", "", judge.result.reasoning);
  }
  lines.push("", "## 被评输出", "", "```", sample.slice(0, 4000), "```");
  return lines.join("\n");
}
