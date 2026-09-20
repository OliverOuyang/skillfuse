import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Info, XCircle } from "lucide-react";
import type { IssueCategory, ParsedSkill, SkillAnalysis, ValidationReport } from "@/core/types";
import { StepHeading } from "./chrome";
import { cn } from "@/lib/utils";

const CATEGORY_META: { key: IssueCategory; label: string }[] = [
  { key: "structure", label: "目录结构" },
  { key: "frontmatter", label: "frontmatter" },
  { key: "body", label: "正文结构" },
  { key: "io", label: "输入输出" },
  { key: "trace", label: "trace 规范" },
  { key: "security", label: "安全基线" },
];

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
  return (
    <div>
      <StepHeading
        kicker="第 2 步 · 检查"
        title={analysis.displayName}
        sub={analysis.description || "frontmatter 中没有找到描述——生成器将更多依赖章节结构进行推断。"}
      />

      {/* stat row */}
      <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="章节" value={skill.sections.length} />
        <Stat label="硬约束" value={analysis.constraints.length} />
        <Stat label="工作流步骤" value={analysis.steps.length} />
        <Stat label="示例" value={analysis.examples.length} />
      </div>

      {report && <ValidationPanel report={report} />}

      {analysis.warnings.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> 需要注意
          </p>
          <ul className="space-y-1">
            {analysis.warnings.map((w) => (
              <li key={w} className="text-[12.5px] text-amber-700">· {w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="检测到的输出格式" items={analysis.formats} empty="未检测到明确的输出格式" mono />
        <Panel title="skill 预期的输入" items={analysis.inputs} empty="未检测到输入类型" />
        <Panel title="硬约束（必须 / 禁止）" items={analysis.constraints} empty="未检测到" />
        <Panel title="质量标准" items={analysis.qualityCriteria} empty="未检测到" />
        <Panel title="工作流程" items={analysis.steps} numbered empty="未找到编号工作流" />
        <Panel title="工具与引用" items={analysis.tools} empty="未检测到" mono />
      </div>

      {analysis.triggerKeywords.length > 0 && (
        <div className="mt-4 rounded-lg border bg-white p-4">
          <p className="mb-2 font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            触发关键词
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
          <ArrowLeft className="h-4 w-4" /> 上一步
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-[14px] font-semibold text-white shadow-sm hover:bg-primary/90"
        >
          生成数据集与评分器 <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ValidationPanel({ report }: { report: ValidationReport }) {
  const scoreColor =
    report.summary.errors > 0 ? "text-red-600" : report.summary.warnings > 0 ? "text-amber-600" : "text-emerald-600";

  return (
    <div className="mb-6 rounded-lg border bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-code text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          企业级规范检查
        </p>
        <p className={cn("text-[22px] font-extrabold tracking-tight", scoreColor)}>
          {report.score}
          <span className="text-[12px] font-medium text-muted-foreground"> /100</span>
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {CATEGORY_META.map(({ key, label }) => {
          const catIssues = report.issues.filter((i) => i.category === key);
          const catErrors = catIssues.filter((i) => i.severity === "error").length;
          const ok = catIssues.length === 0;
          return (
            <div
              key={key}
              className={cn(
                "rounded-md border px-2.5 py-2 text-center",
                ok ? "border-emerald-200 bg-emerald-50" : catErrors > 0 ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50",
              )}
            >
              <p className={cn("text-[12px] font-semibold", ok ? "text-emerald-700" : catErrors > 0 ? "text-red-700" : "text-amber-700")}>
                {ok ? "✓ " : ""}
                {label}
              </p>
              {!ok && (
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {catErrors > 0 && `${catErrors} error `}
                  {catIssues.length - catErrors > 0 && `${catIssues.length - catErrors} 提示`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {report.issues.length > 0 ? (
        <ul className="mt-3.5 space-y-1.5 border-t pt-3.5">
          {report.issues.map((issue, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
              {issue.severity === "error" ? (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
              ) : issue.severity === "warning" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              )}
              <span className="text-foreground/90">
                <span className="mr-1.5 font-code text-[10.5px] text-muted-foreground">
                  {issue.ruleId}
                </span>
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3.5 flex items-center gap-1.5 border-t pt-3.5 text-[12.5px] text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> 全部规则通过（{report.summary.passed} 条）
        </p>
      )}
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
