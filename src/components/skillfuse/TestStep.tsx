import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Code2,
  Download,
  Eraser,
  Eye,
  FlaskConical,
  History,
  Loader2,
  PlayCircle,
  RotateCcw,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { Artifacts, DatasetItem, ModelConfig, RuleCheck, RuleResult, SkillAnalysis } from "@/core/types";
import { aggregate, ruleFixHint, runRuleChecks } from "@/core/runRules";
import { JUDGE_DIMENSIONS, type JudgeResult, describeError, runJudge, runSkillTask } from "@/core/llm";
import {
  Badge,
  Button,
  Card,
  Collapsible,
  EmptyState,
  ScoreRing,
  SectionLabel,
  Segmented,
  Toggle,
} from "@/components/ui";
import { useToast } from "@/components/ui/toast-context";
import { MarkdownPreview } from "./MarkdownPreview";
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

/** 端到端试运行的阶段，用于按钮上的进度提示。 */
type Stage = "idle" | "generating" | "scoring" | "judging";

/** 输出区的两种看法：原始文本 / Markdown 预览。 */
type Mode = "code" | "preview";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "用模型跑需求并评分",
  generating: "模型正在跑需求…",
  scoring: "规则评分中…",
  judging: "LLM 评审中…",
};

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
  const [task, setTask] = useState(() => taskOf(items[0]));
  const [stage, setStage] = useState<Stage>("idle");
  const [mode, setMode] = useState<Mode>("code");
  const [history, setHistory] = useState<RunRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  /* 规则跑一次只是几个正则，够快，实时模式直接推导即可——不需要 effect 同步状态 */
  const results = useMemo(
    () => (live ? (sample.trim() ? runRuleChecks(rules, sample) : null) : manualResults),
    [live, sample, rules, manualResults],
  );
  const score = results ? aggregate(results) : 0;
  const judgeInput = task.trim() || "（未填写需求）";

  const record = useCallback(
    /* 端到端跑完时 sample 的 state 还没刷新，所以允许显式传入本次被评的输出 */
    (res: RuleResult[], judgeScore?: number, output?: string) =>
      setHistory((h) =>
        [
          {
            at: Date.now(),
            ruleScore: aggregate(res),
            judgeScore,
            passed: res.filter((r) => r.passed).length,
            total: res.length,
            sample: output ?? sample,
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

  /** 端到端：让配置的模型按 skill 跑这条需求，拿到输出后立刻规则评分 + LLM 评审。 */
  const runEndToEnd = async () => {
    if (!modelCfg || !analysis || !task.trim()) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setJudge({ status: "idle" });
    setStage("generating");
    let output = "";
    try {
      output = await runSkillTask(modelCfg, analysis, task, { signal: ac.signal });
      setSample(output);
      if (!output.trim()) {
        toast({ kind: "error", message: "模型没有返回任何输出", detail: "可在模型设置里调大最大输出 token 后重试" });
        setStage("idle");
        return;
      }
    } catch (e) {
      const d = describeError(e);
      setStage("idle");
      toast({ kind: "error", message: `跑需求失败：${d.message}`, detail: d.hint });
      return;
    }

    setStage("scoring");
    const res = runRuleChecks(rules, output);
    setManualResults(res);

    setStage("judging");
    setJudge({ status: "running" });
    try {
      const r = await runJudge(modelCfg, artifacts.llmJudgePrompt, task, output, { signal: ac.signal });
      setJudge({ status: "done", result: r });
      record(res, r.score, output);
      toast({
        kind: "success",
        message: `试运行完成：规则 ${(aggregate(res) * 100).toFixed(0)} · 评审 ${r.score.toFixed(2)}`,
        detail: `${modelCfg.model} 生成并评审`,
      });
    } catch (e) {
      const d = describeError(e);
      setJudge({ status: "error", message: d.message, hint: d.hint });
      record(res, undefined, output);
      toast({ kind: "error", message: `LLM 评审失败：${d.message}`, detail: "规则评分已完成，可单独重试评审" });
    } finally {
      setStage("idle");
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
    setSample(buildSkeleton(analysis, rules));
    toast({ kind: "info", message: "已按当前规则生成骨架", detail: "章节与结构都取自现在这套评分器" });
  };

  const exportReport = () => {
    if (!results) return;
    downloadText(
      `${analysis?.skillName ?? "skill"}-dryrun.md`,
      buildReport({
        skillName: analysis?.skillName ?? "skill",
        task,
        model: modelCfg?.model,
        rules,
        results,
        score,
        judge,
        sample,
      }),
      "text/markdown",
    );
    toast({ kind: "success", message: "试运行报告已导出", detail: "含需求、模型输出、规则明细与评审理由" });
  };

  const failed = results?.filter((r) => !r.passed) ?? [];

  return (
    <div>
      <StepHeading
        kicker="第 4 步 · 试运行"
        title="验证评分器"
        sub="接入模型后可以直接让它按 skill 跑一条需求，再对结果做规则评分与 LLM 评审；也可以把现成输出粘到左边即时打分——与生成的 rule_scorers.py 是同一套逻辑、同一个分数。"
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
            <SectionLabel className="mb-1.5">需求（既是模型的输入，也是评审的 input）</SectionLabel>
            {items.length > 0 && (
              <select
                value={itemIdx}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  setItemIdx(i);
                  setTask(taskOf(items[i]));
                }}
                className="mb-2 h-9 w-full rounded-lg border bg-card px-2 text-[12.5px] outline-none focus:border-primary"
                aria-label="选择数据集条目"
              >
                {items.map((it, i) => (
                  <option key={i} value={i}>
                    #{i + 1} · {taskOf(it).slice(0, 60) || "（空任务）"}
                  </option>
                ))}
              </select>
            )}
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="选一条数据集条目，或直接写一条需求…"
              className="h-20 w-full resize-y rounded-lg border bg-card p-2.5 text-[12.5px] leading-relaxed outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </Card>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <SectionLabel>模型输出示例</SectionLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                <Segmented<Mode>
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "code", label: <span className="flex items-center gap-1"><Code2 className="h-3.5 w-3.5" />代码</span> },
                    { value: "preview", label: <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />预览</span> },
                  ]}
                />
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
            {mode === "code" ? (
              <textarea
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder="把跑 skill 得到的真实（或草稿）输出粘贴到这里…"
                className="h-[320px] w-full resize-y rounded-lg border bg-card p-3.5 font-code text-[12px] leading-relaxed outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            ) : (
              <div className="h-[320px] w-full overflow-auto rounded-lg border bg-card p-3.5 scroll-slim">
                {sample.trim() ? (
                  <MarkdownPreview source={sample} />
                ) : (
                  <p className="text-[12.5px] text-muted-foreground">还没有输出可预览。</p>
                )}
              </div>
            )}
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
            {modelCfg ? (
              <>
                <Button
                  variant="primary"
                  onClick={runEndToEnd}
                  disabled={!task.trim() || stage !== "idle"}
                  title="用配置的模型按 skill 跑这条需求，再对结果做规则评分与 LLM 评审"
                >
                  {stage === "idle" ? <PlayCircle className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
                  {STAGE_LABEL[stage]}
                </Button>
                <Button variant="secondary" onClick={runRules} disabled={!sample.trim() || stage !== "idle"}>
                  <FlaskConical className="h-4 w-4" /> 只跑规则评分
                </Button>
                <Button
                  variant="subtle"
                  onClick={runLlmJudge}
                  disabled={!sample.trim() || judge.status === "running" || stage !== "idle"}
                >
                  {judge.status === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {judge.status === "running" ? "评审中…" : "只跑 LLM 评审"}
                </Button>
                {(stage !== "idle" || judge.status === "running") && (
                  <Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                    取消
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="primary" onClick={runRules} disabled={!sample.trim()}>
                  <FlaskConical className="h-4 w-4" /> 运行规则评分
                </Button>
                <Button variant="secondary" onClick={onOpenModelSettings}>
                  <Sparkles className="h-4 w-4" /> 接入模型以跑需求与评审
                </Button>
              </>
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

/**
 * 按「当前这套规则」拼骨架——包括模型优化出来的定制规则。
 * 目标是让骨架尽量命中规则：章节取自关键词类规则的词表，结构类规则决定要不要放表格 / 代码块，
 * 这样用户一眼能看出「规则到底在要求什么」，而不是拿一份和规则无关的模板去跑分。
 */
function buildSkeleton(a: SkillAnalysis | null, rules: RuleCheck[]): string {
  const enabled = rules.filter((r) => r.enabled !== false);
  const has = (kind: RuleCheck["kind"]) => enabled.some((r) => r.kind === kind);

  // 关键词类规则的词表即「必须出现的内容」，作为章节标题
  const wanted = enabled
    .filter((r) => r.kind === "contains_any" || r.kind === "contains_all")
    .flatMap((r) => ((r.params.terms as string[] | undefined) ?? []).slice(0, 6));
  const banned = enabled
    .filter((r) => r.kind === "not_contains")
    .flatMap((r) => ((r.params.terms as string[] | undefined) ?? []));

  const sections = [
    ...new Set([...wanted, ...(a?.outputFields ?? []), ...(a?.outputSections ?? [])].map((s) => s.trim()).filter(Boolean)),
  ].slice(0, 8);

  if (has("valid_json")) {
    const obj = Object.fromEntries((sections.length ? sections : ["result"]).map((s) => [s, "替换成真实值"]));
    return JSON.stringify(obj, null, 2);
  }

  const lines = [`# ${a?.displayName ?? "示例输出"}`, ""];
  for (const s of sections.length > 0 ? sections : ["结论", "细节", "下一步"]) {
    lines.push(`## ${s}`, "", "（在这里替换成真实内容）", "");
  }
  if (has("has_table") || a?.formats.includes("table")) {
    lines.push("| 项目 | 状态 | 说明 |", "| --- | --- | --- |", "| 示例 | 进行中 | 替换成真实数据 |", "");
  }
  if (has("has_code_block") || a?.formats.includes("code")) {
    lines.push("```python", 'print("replace me")', "```", "");
  }
  const min = Math.max(
    0,
    ...enabled.filter((r) => r.kind === "min_length").map((r) => Number(r.params.min ?? 0)),
  );
  if (min > 0) lines.push(`> 提示：当前规则要求加权长度 ≥ ${min}，正文需要写到这个体量。`, "");
  // 只提示数量不列原词：违禁词一旦写进骨架，not_contains 规则当场就会判不通过
  if (banned.length > 0) {
    lines.push(`> 提示：当前规则禁用了 ${banned.length} 个措辞（见生成页的「不得包含」规则），正文请避开。`, "");
  }
  return lines.join("\n");
}

function buildReport({
  skillName,
  task,
  model,
  rules,
  results,
  score,
  judge,
  sample,
}: {
  skillName: string;
  task: string;
  model?: string;
  rules: RuleCheck[];
  results: RuleResult[];
  score: number;
  judge: JudgeState;
  sample: string;
}): string {
  const lines = [
    `# 试运行报告 — ${skillName}`,
    "",
    `- 时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `- 加权规则得分：**${(score * 100).toFixed(0)}/100**（通过 ${results.filter((r) => r.passed).length}/${results.length} 条）`,
  ];
  if (model) lines.push(`- 模型：\`${model}\``);
  if (judge.status === "done") {
    lines.push(`- LLM 评审得分：**${judge.result.score.toFixed(2)}**`);
    if (judge.result.constraintViolation) lines.push("- ⚠️ 评审判定违反硬约束");
  }

  if (task.trim()) lines.push("", "## 需求", "", task.trim());

  lines.push("", "## 规则明细", "", "| 结果 | 规则 | 权重 | 来源 | 说明 |", "| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const rule = rules.find((x) => x.id === r.id);
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(
      `| ${r.passed ? "✅" : "❌"} | ${cell(r.name)} | ${r.weight} | ${cell(rule?.source ?? "—")} | ${cell(r.comment)} |`,
    );
  }

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("", "## 怎么改", "");
    for (const f of failed) {
      const rule = rules.find((x) => x.id === f.id);
      lines.push(`- **${f.name}**：${rule ? ruleFixHint(rule) : f.comment}`);
    }
  }

  if (judge.status === "done") {
    lines.push("", "## LLM 评审", "");
    for (const d of JUDGE_DIMENSIONS) {
      lines.push(`- ${d.label}：${judge.result.dimensions[d.key] ?? "—"}/5`);
    }
    lines.push("", judge.result.reasoning);
  }

  lines.push("", "## 被评输出", "", "````", sample.slice(0, 8000), "````");
  return lines.join("\n");
}
