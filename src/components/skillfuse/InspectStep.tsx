import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Lightbulb,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type {
  IssueCategory,
  IssueSeverity,
  ParsedSkill,
  SkillAnalysis,
  ValidationIssue,
  ValidationReport,
} from "@/core/types";
import { reportToMarkdown } from "@/core/validate";
import { Badge, Button, Card, Collapsible, CopyIconButton, EmptyState, ScoreRing, SectionLabel, Segmented } from "@/components/ui";
import { SEVERITY_ICON } from "@/components/ui/severity";
import { useToast } from "@/components/ui/toast-context";
import { downloadText } from "./download";
import { StepFooter, StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

const CATEGORY_META: { key: IssueCategory; label: string; desc: string }[] = [
  { key: "structure", label: "目录结构", desc: "SKILL.md / scripts / references / tests 的组织方式" },
  { key: "naming", label: "命名规范", desc: "skill 名、文件名与脚本名的可读性与可移植性" },
  { key: "frontmatter", label: "frontmatter", desc: "name、description、allowed-tools 等元数据" },
  { key: "body", label: "正文结构", desc: "何时使用 / 工作流 / 失败回退 / 边界" },
  { key: "io", label: "输入输出", desc: "输入校验与输出格式的字段级定义" },
  { key: "report", label: "报告类专项", desc: "结论先行、数据出处、口径与建议（仅报告类 skill）" },
  { key: "output", label: "产出规范", desc: "产出目录、版本与台账的落盘约定" },
  { key: "trace", label: "trace 规范", desc: "中间步骤埋点与可观测性" },
  { key: "security", label: "安全基线", desc: "提示注入、外部链接与权限面" },
];

const SEVERITY_LABEL: Record<IssueSeverity, string> = { error: "错误", warning: "警告", info: "提示" };

type SeverityFilter = "all" | IssueSeverity | "passed";

export function InspectStep({
  skill,
  analysis,
  report,
  onBack,
  onNext,
}: {
  skill: ParsedSkill;
  analysis: SkillAnalysis;
  report: ValidationReport | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const toast = useToast();
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [category, setCategory] = useState<IssueCategory | "all">("all");
  const [query, setQuery] = useState("");

  const issues = useMemo(() => report?.issues ?? [], [report]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((i) => {
      if (severity !== "all" && severity !== "passed" && i.severity !== severity) return false;
      if (category !== "all" && i.category !== category) return false;
      if (q && !`${i.ruleName} ${i.message} ${i.ruleId} ${i.hint ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [issues, severity, category, query]);

  const passedVisible = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.passedRules.filter(
      (r) =>
        (category === "all" || r.category === category) &&
        (!q || `${r.ruleName} ${r.ruleId}`.toLowerCase().includes(q)),
    );
  }, [report, category, query]);

  const exportReport = () => {
    if (!report) return;
    downloadText(`${analysis.skillName}-spec-report.md`, reportToMarkdown(report, analysis.skillName), "text/markdown");
    toast({ kind: "success", message: "检查报告已导出", detail: `${analysis.skillName}-spec-report.md` });
  };

  return (
    <div>
      <StepHeading
        kicker="第 2 步 · 检查"
        title={analysis.displayName}
        sub={analysis.description || "frontmatter 中没有找到描述——生成器将更多依赖章节结构进行推断。"}
        right={
          report && (
            <Button variant="secondary" size="sm" onClick={exportReport}>
              <Download className="h-3.5 w-3.5" /> 导出检查报告
            </Button>
          )
        }
      />

      {report && <ScoreCard report={report} category={category} onPickCategory={setCategory} />}

      {report && (
        <section className="mt-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold tracking-tight">规范检查明细</h2>
              <Badge tone="neutral">
                {severity === "passed" ? passedVisible.length : visible.length} / {report.summary.total}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索规则或说明"
                  className="h-9 w-44 rounded-lg border bg-card pl-8 pr-2.5 text-[12.5px] outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15 sm:w-56"
                />
              </div>
              <Segmented<SeverityFilter>
                value={severity}
                onChange={setSeverity}
                options={[
                  { value: "all", label: "全部", count: issues.length },
                  { value: "error", label: "错误", count: report.summary.errors },
                  { value: "warning", label: "警告", count: report.summary.warnings },
                  { value: "info", label: "提示", count: report.summary.infos },
                  { value: "passed", label: "已通过", count: report.summary.passed },
                ]}
              />
            </div>
          </div>

          {category !== "all" && (
            <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              已按分类筛选：
              <Badge tone="primary">{CATEGORY_META.find((c) => c.key === category)?.label}</Badge>
              <button onClick={() => setCategory("all")} className="font-medium text-primary hover:underline">
                清除
              </button>
            </div>
          )}

          {severity === "passed" ? (
            passedVisible.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="当前筛选下没有已通过的规则" />
            ) : (
              <Card className="divide-y">
                {passedVisible.map((r) => (
                  <div key={r.ruleId} className="flex items-center gap-2.5 px-4 py-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    <span className="text-[13px] font-medium">{r.ruleName}</span>
                    <span className="ml-auto font-code text-[11px] text-muted-foreground">{r.ruleId}</span>
                  </div>
                ))}
              </Card>
            )
          ) : visible.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={issues.length === 0 ? "全部规则通过，没有待修项" : "当前筛选下没有待修项"}
              sub={issues.length === 0 ? "这个 skill 已经符合企业级规范，可以直接进入生成步骤。" : undefined}
            />
          ) : (
            <div className="space-y-2">
              {visible.map((issue) => (
                <IssueRow key={issue.ruleId} issue={issue} />
              ))}
            </div>
          )}
        </section>
      )}

      {analysis.warnings.length > 0 && (
        <Card className="mt-6 border-amber-500/30 bg-amber-500/5 p-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-600 dark:text-amber-400">
            <Lightbulb className="h-3.5 w-3.5" /> 对生成结果的影响
          </p>
          <ul className="space-y-1">
            {analysis.warnings.map((w) => (
              <li key={w} className="text-[12.5px] leading-relaxed text-muted-foreground">
                · {w}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section className="mt-8">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[15px] font-bold tracking-tight">解析结果</h2>
          <span className="text-[12.5px] text-muted-foreground">这些字段决定了下一步生成什么</span>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="章节" value={skill.sections.length} />
          <Stat label="硬约束" value={analysis.constraints.length} />
          <Stat label="工作流步骤" value={analysis.steps.length} />
          <Stat label="示例" value={analysis.examples.length} />
        </div>

        {analysis.triggerKeywords.length > 0 && (
          <Card className="mb-3 p-4">
            <SectionLabel className="mb-2">触发关键词</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {analysis.triggerKeywords.map((t) => (
                <Badge key={t} tone="primary">
                  {t}
                </Badge>
              ))}
            </div>
          </Card>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <ListPanel title="检测到的输出格式" items={analysis.formats} empty="未检测到明确的输出格式" mono open />
          <ListPanel title="skill 预期的输入" items={analysis.inputs} empty="未检测到输入类型" open />
          <ListPanel title="硬约束（必须 / 禁止）" items={analysis.constraints} empty="未检测到" open />
          <ListPanel title="质量标准" items={analysis.qualityCriteria} empty="未检测到" open />
          <ListPanel title="工作流程" items={analysis.steps} numbered empty="未找到编号工作流" />
          <ListPanel title="工具与引用" items={analysis.tools} empty="未检测到" mono />
        </div>

        <Collapsible
          title="SKILL.md 章节速览"
          subtitle={`共 ${skill.sections.length} 个章节 · ${skill.wordCount} 字`}
        >
          <ul className="space-y-1.5">
            {skill.sections.map((s, i) => (
              <li key={`${s.heading}-${i}`} className="flex items-baseline gap-2 text-[12.5px]">
                <span className="font-code text-[10.5px] text-muted-foreground">H{s.level}</span>
                <span className="font-medium">{s.heading || "（无标题）"}</span>
                <span className="ml-auto shrink-0 font-code text-[11px] text-muted-foreground">
                  {s.bullets.length} 要点 · {s.codeBlocks.length} 代码块
                </span>
              </li>
            ))}
          </ul>
        </Collapsible>
      </section>

      <StepFooter>
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> 上一步
        </Button>
        <Button variant="primary" size="lg" onClick={onNext}>
          <Sparkles className="h-4 w-4" /> 生成数据集与评分器 <ArrowRight className="h-4 w-4" />
        </Button>
        {report && report.summary.errors > 0 && (
          <span className="text-[12.5px] text-muted-foreground">
            仍有 {report.summary.errors} 个错误——可以先生成，修完后重新导入即可刷新。
          </span>
        )}
      </StepFooter>
    </div>
  );
}

/* ---------------- score card ---------------- */

function ScoreCard({
  report,
  category,
  onPickCategory,
}: {
  report: ValidationReport;
  category: IssueCategory | "all";
  onPickCategory: (c: IssueCategory | "all") => void;
}) {
  const tone = report.summary.errors > 0 ? "danger" : report.summary.warnings > 0 ? "warning" : "success";
  const verdict =
    report.summary.errors > 0
      ? "存在阻断性错误，建议先修复再上线"
      : report.summary.warnings > 0
        ? "可用，但仍有规范项待完善"
        : "符合企业级规范";

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <ScoreRing value={report.score} tone={tone} caption="规范得分" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold tracking-tight">{verdict}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            通过 {report.summary.passed}/{report.summary.total} 条规则 · 扣分规则：每个错误 −10、每个警告 −3
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone="danger">错误 {report.summary.errors}</Badge>
            <Badge tone="warning">警告 {report.summary.warnings}</Badge>
            <Badge tone="primary">提示 {report.summary.infos}</Badge>
            <Badge tone="success">通过 {report.summary.passed}</Badge>
          </div>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted">
            <Bar count={report.summary.errors} total={report.summary.total} className="bg-destructive" />
            <Bar count={report.summary.warnings} total={report.summary.total} className="bg-amber-400" />
            <Bar count={report.summary.infos} total={report.summary.total} className="bg-primary/60" />
            <Bar count={report.summary.passed} total={report.summary.total} className="bg-emerald-500" />
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 border-t pt-4 sm:grid-cols-3 lg:grid-cols-4">
        {/* 专项分类（如报告类）对不适用的 skill 没有规则，不展示空卡片 */}
        {CATEGORY_META.filter(({ key }) => report.byCategory[key].total > 0).map(({ key, label, desc }) => {
          const s = report.byCategory[key];
          const state = s.errors > 0 ? "danger" : s.warnings > 0 ? "warning" : s.infos > 0 ? "info" : "ok";
          const selected = category === key;
          return (
            <button
              key={key}
              title={desc}
              onClick={() => onPickCategory(selected ? "all" : key)}
              className={cn(
                "rounded-lg border px-2.5 py-2 text-left transition-colors",
                selected && "ring-2 ring-primary/40",
                state === "ok" && "border-emerald-500/30 bg-emerald-500/5",
                state === "danger" && "border-destructive/30 bg-destructive/5",
                state === "warning" && "border-amber-500/30 bg-amber-500/5",
                state === "info" && "border-primary/25 bg-primary/5",
              )}
            >
              <p
                className={cn(
                  "text-[12.5px] font-semibold",
                  state === "ok" && "text-emerald-600 dark:text-emerald-400",
                  state === "danger" && "text-destructive",
                  state === "warning" && "text-amber-600 dark:text-amber-400",
                  state === "info" && "text-primary",
                )}
              >
                {state === "ok" ? "✓ " : ""}
                {label}
              </p>
              <p className="mt-0.5 font-code text-[10.5px] text-muted-foreground">
                {state === "ok" ? `${s.passed}/${s.total} 通过` : `${s.errors + s.warnings + s.infos} 项待看`}
              </p>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function Bar({ count, total, className }: { count: number; total: number; className: string }) {
  if (count === 0) return null;
  return <div className={className} style={{ width: `${(count / Math.max(total, 1)) * 100}%` }} />;
}

/* ---------------- issue row ---------------- */

function IssueRow({ issue }: { issue: ValidationIssue }) {
  const [open, setOpen] = useState(issue.severity === "error");
  const Icon = SEVERITY_ICON[issue.severity];
  const label = CATEGORY_META.find((c) => c.key === issue.category)?.label ?? issue.category;

  return (
    <Card
      className={cn(
        "overflow-hidden transition-colors",
        issue.severity === "error" && "border-destructive/30",
        issue.severity === "warning" && "border-amber-500/30",
      )}
    >
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2.5 px-4 py-3 text-left">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            issue.severity === "error"
              ? "text-destructive"
              : issue.severity === "warning"
                ? "text-amber-500"
                : "text-primary",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold">{issue.ruleName}</span>
            <Badge tone="neutral">{label}</Badge>
            <span className="font-code text-[10.5px] text-muted-foreground">{issue.ruleId}</span>
          </span>
          <span className="mt-1 block text-[12.5px] leading-relaxed text-muted-foreground">{issue.message}</span>
        </span>
        <span className="ml-1 flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "hidden text-[11px] font-semibold sm:inline",
              issue.severity === "error"
                ? "text-destructive"
                : issue.severity === "warning"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-primary",
            )}
          >
            {SEVERITY_LABEL[issue.severity]}
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        </span>
      </button>
      {open && (issue.hint || issue.example) && (
        <div className="border-t bg-muted/40 px-4 py-3">
          {issue.hint && (
            <>
              <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
                <Lightbulb className="h-3.5 w-3.5 text-primary" /> 怎么修
              </p>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{issue.hint}</p>
            </>
          )}
          {issue.example && (
            <div className="mt-3 overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="font-code text-[11px] text-muted-foreground">
                  {issue.example.filename ?? `示例.${issue.example.lang}`}
                </span>
                <CopyIconButton text={issue.example.code} label="复制代码" />
              </div>
              <pre className="max-h-80 overflow-auto p-3 text-[11px] leading-relaxed">
                <code>{issue.example.code}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------- small pieces ---------------- */

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-[26px] font-extrabold leading-none tracking-tight text-foreground">{value}</p>
      <p className="mt-1.5 font-code text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </Card>
  );
}

function ListPanel({
  title,
  items,
  empty,
  numbered,
  mono,
  open,
}: {
  title: string;
  items: string[];
  empty: string;
  numbered?: boolean;
  mono?: boolean;
  open?: boolean;
}) {
  return (
    <Collapsible
      title={title}
      subtitle={items.length > 0 ? `${items.length} 项` : empty}
      defaultOpen={open && items.length > 0}
      right={
        items.length > 0 ? (
          <Badge tone="neutral">{items.length}</Badge>
        ) : (
          <FileText className="h-3.5 w-3.5 text-muted-foreground/50" />
        )
      }
    >
      {items.length === 0 ? (
        <p className="text-[12.5px] italic text-muted-foreground/70">{empty}</p>
      ) : (
        <ul className="max-h-52 space-y-1.5 overflow-y-auto pr-1 scroll-slim">
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
    </Collapsible>
  );
}
