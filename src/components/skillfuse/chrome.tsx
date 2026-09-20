import {
  Check,
  Database,
  FileSliders,
  FlaskConical,
  Github,
  ListChecks,
  Moon,
  ScanSearch,
  Sparkles,
  Sun,
  Upload,
} from "lucide-react";
import type { ModelConfig } from "@/core/types";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/* ---------- logo ---------- */
export function Logo() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden className="shrink-0">
        <rect width="26" height="26" rx="7" fill="hsl(var(--primary))" />
        <path
          d="M14.6 5.5 8 14h4.2L11.4 20.5 18 12h-4.2l.8-6.5z"
          fill="#fff"
          stroke="#fff"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-[17px] font-bold tracking-tight text-foreground">SkillFuse</span>
      <span className="ml-1 hidden truncate border-l pl-3 text-[13px] text-muted-foreground md:block">
        把 AI Skill 变成可衡量的效果
      </span>
    </div>
  );
}

/* ---------- top nav ---------- */
export function TopNav({
  modelCfg,
  onOpenSettings,
  theme,
  onToggleTheme,
}: {
  modelCfg: ModelConfig | null;
  onOpenSettings: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-card/85 px-4 backdrop-blur sm:px-5">
      <Logo />
      <nav className="flex items-center gap-1.5">
        <button
          onClick={onOpenSettings}
          title={modelCfg ? `已接入 ${modelCfg.model}` : "未接入模型——点击配置"}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            modelCfg
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full", modelCfg ? "bg-emerald-500" : "bg-muted-foreground/50")}
            aria-hidden
          />
          <span className="max-w-[140px] truncate font-code">{modelCfg ? modelCfg.model : "未接入模型"}</span>
        </button>
        <Button variant="ghost" size="sm" onClick={onToggleTheme} aria-label="切换主题">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <a
          href="https://github.com/OliverOuyang/skillfuse"
          target="_blank"
          rel="noreferrer"
          className="hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
        >
          <Github className="h-4 w-4" /> GitHub
        </a>
        <span className="hidden rounded-full bg-primary/10 px-2.5 py-1 font-code text-[11px] font-semibold text-primary sm:inline">
          v0.2.0
        </span>
      </nav>
    </header>
  );
}

/* ---------- steps ---------- */
const STEPS = [
  { n: 1, title: "导入 Skill", sub: "添加 SKILL.md 或 ZIP", icon: Upload },
  { n: 2, title: "检查 Skill", sub: "规范打分与修复建议", icon: ScanSearch },
  { n: 3, title: "生成评测包", sub: "数据集与评分器", icon: Sparkles },
  { n: 4, title: "试运行", sub: "验证评分器", icon: FlaskConical },
];

export function StepRail({
  step,
  onSelect,
  maxReached,
}: {
  step: number;
  onSelect: (n: number) => void;
  maxReached: number;
}) {
  return (
    <aside className="hidden w-[224px] shrink-0 border-r bg-card lg:block">
      <div className="sticky top-14 flex h-[calc(100vh-3.5rem)] flex-col justify-between px-5 py-6">
      <ol className="relative space-y-6">
        <span className="absolute left-[15px] top-4 h-[calc(100%-32px)] w-px bg-border" aria-hidden />
        {STEPS.map((s) => {
          const done = s.n < step;
          const active = s.n === step;
          const reachable = s.n <= maxReached;
          return (
            <li key={s.n} className="relative">
              <button
                disabled={!reachable}
                onClick={() => onSelect(s.n)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-lg px-1 py-0.5 text-left",
                  reachable ? "cursor-pointer" : "cursor-default opacity-50",
                )}
              >
                <span
                  className={cn(
                    "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]"
                      : done
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground group-hover:border-primary/40",
                  )}
                >
                  {done ? <Check className="h-4 w-4" /> : s.n}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn("block text-[13.5px] font-semibold", active ? "text-primary" : "text-foreground")}
                  >
                    {s.title}
                  </span>
                  <span className="block text-[12px] text-muted-foreground">{s.sub}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="space-y-2 text-[12px] text-muted-foreground">
        <p className="font-semibold text-foreground">SkillFuse</p>
        <p>开源项目 · 让 AI 更可靠</p>
        <a
          href="https://github.com/OliverOuyang/skillfuse"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 hover:text-foreground"
        >
          <Github className="h-3.5 w-3.5" /> 在 GitHub 查看
        </a>
        <p className="pt-2 font-code text-[10.5px]">v0.2.0 · MIT License</p>
      </div>
      </div>
    </aside>
  );
}

/** 小屏下的横向步骤条——移动端不再看不到自己走到哪一步。 */
export function StepBarMobile({
  step,
  onSelect,
  maxReached,
}: {
  step: number;
  onSelect: (n: number) => void;
  maxReached: number;
}) {
  return (
    <div className="sticky top-14 z-20 flex items-center gap-1 overflow-x-auto border-b bg-card px-3 py-2 lg:hidden">
      {STEPS.map((s) => {
        const active = s.n === step;
        const reachable = s.n <= maxReached;
        return (
          <button
            key={s.n}
            disabled={!reachable}
            onClick={() => onSelect(s.n)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : reachable
                  ? "text-muted-foreground hover:bg-muted"
                  : "text-muted-foreground/40",
            )}
          >
            <s.icon className="h-3.5 w-3.5" />
            {s.title}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- right output plan rail ---------- */
const PLAN = [
  {
    icon: Database,
    title: "数据集 Schema",
    desc: "根据 skill 的输入、任务与预期输出，生成兼容 Langfuse 的数据集定义。",
    points: ["字段与示例", "元数据（标签、任务类型、来源）", "可直接用于 langfuse.create_dataset()"],
    step: 3,
  },
  {
    icon: ListChecks,
    title: "规则评分器",
    desc: "针对关键行为与硬性约束的确定性评分器，零依赖、可复现。",
    points: ["格式与结构检查", "硬约束（必须 / 禁止）校验", "权重可在界面上直接调"],
    step: 3,
  },
  {
    icon: Sparkles,
    title: "LLM 评审",
    desc: "基于 skill 的质量标准与示例生成的 LLM-as-a-judge 评分器。",
    points: ["从 skill 正文提取评分细则", "支持任意 OpenAI 兼容端点", "兼容 Langfuse 评分流程"],
    step: 3,
  },
  {
    icon: FileSliders,
    title: "Langfuse 配置",
    desc: "开箱即用的配置与辅助脚本，在 Langfuse 中记录、评分与可视化结果。",
    points: ["数据集与评分器定义", "SDK 接入示例代码", "环境变量说明"],
    step: 3,
  },
];

export function OutputPlan({ ready, step }: { ready: boolean; step: number }) {
  return (
    <aside className="hidden w-[320px] shrink-0 border-l bg-card xl:block">
      <div className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto px-6 py-6 scroll-slim">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[15px] font-bold tracking-tight">生成清单</h2>
        <Badge tone={ready ? "success" : "warning"}>
          <span className={cn("h-1.5 w-1.5 rounded-full", ready ? "bg-emerald-500" : "bg-amber-400")} />
          {ready ? "已就绪" : step === 1 ? "等待导入" : "尚未生成"}
        </Badge>
      </div>
      <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
        SkillFuse 将从你的 skill 生成以下内容：
      </p>
      <div className="space-y-5">
        {PLAN.map((p) => (
          <section
            key={p.title}
            className={cn(
              "rounded-lg border p-3.5 transition-colors",
              ready ? "border-primary/20 bg-primary/[0.04]" : "bg-card",
            )}
          >
            <div className="flex items-center gap-2">
              <p.icon className={cn("h-4 w-4", ready ? "text-primary" : "text-muted-foreground")} />
              <h3 className="text-[13.5px] font-semibold">{p.title}</h3>
              {ready && <Check className="ml-auto h-3.5 w-3.5 text-emerald-500" />}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{p.desc}</p>
            <ul className="mt-2 space-y-1">
              {p.points.map((pt) => (
                <li key={pt} className="flex gap-2 text-[12px] text-muted-foreground">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                  {pt}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      </div>
    </aside>
  );
}

/* ---------- shared bits ---------- */
export function StepHeading({
  kicker,
  title,
  sub,
  right,
}: {
  kicker: string;
  title: string;
  sub: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="font-code text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {kicker}
        </p>
        <h1 className="mt-1.5 break-words text-[26px] font-extrabold tracking-tight text-foreground sm:text-[30px]">
          {title}
        </h1>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted-foreground">{sub}</p>
      </div>
      {right}
    </div>
  );
}

/** 每一步底部统一的上一步 / 下一步操作条。 */
export function StepFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-8 flex flex-wrap items-center gap-3 border-t pt-6">{children}</div>;
}
