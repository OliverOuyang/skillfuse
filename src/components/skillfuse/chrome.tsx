import { Check, Database, FileSliders, Github, ListChecks, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------- logo ---------- */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
        <rect width="26" height="26" rx="7" fill="hsl(248 89% 66%)" />
        <path
          d="M14.6 5.5 8 14h4.2L11.4 20.5 18 12h-4.2l.8-6.5z"
          fill="#fff"
          stroke="#fff"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-[17px] font-bold tracking-tight text-foreground">SkillFuse</span>
      <span className="ml-1 hidden border-l pl-3 text-[13px] text-muted-foreground sm:block">
        把 AI Skill 变成可衡量的效果
      </span>
    </div>
  );
}

/* ---------- top nav ---------- */
export function TopNav({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-white/85 px-5 backdrop-blur">
      <Logo />
      <nav className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
        <a
          href="https://github.com/OliverOuyang/skillfuse"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Github className="h-4 w-4" /> GitHub
        </a>
        <button
          onClick={onOpenSettings}
          className="rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted hover:text-foreground"
        >
          模型设置
        </button>
        <span className="ml-2 rounded-full bg-primary/10 px-2.5 py-1 font-code text-[11px] font-semibold text-primary">
          v0.1.0
        </span>
      </nav>
    </header>
  );
}

/* ---------- left step rail ---------- */
export const STEPS = [
  { n: 1, title: "导入 Skill", sub: "添加 SKILL.md 或 ZIP" },
  { n: 2, title: "检查解析", sub: "核对 skill 元数据" },
  { n: 3, title: "生成", sub: "生成数据集与评分器" },
  { n: 4, title: "测试", sub: "试运行与验证" },
];

export function StepRail({ step, onSelect, maxReached }: { step: number; onSelect: (n: number) => void; maxReached: number }) {
  return (
    <aside className="hidden w-[218px] shrink-0 flex-col justify-between border-r bg-white px-5 py-6 lg:flex">
      <ol className="relative space-y-7">
        <span className="absolute left-[15px] top-3 h-[calc(100%-24px)] w-px bg-border" aria-hidden />
        {STEPS.map((s) => {
          const done = s.n < step;
          const active = s.n === step;
          const reachable = s.n <= maxReached;
          return (
            <li key={s.n} className="relative">
              <button
                disabled={!reachable}
                onClick={() => onSelect(s.n)}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-lg px-1 py-0.5 text-left",
                  reachable ? "cursor-pointer" : "cursor-default opacity-60",
                )}
              >
                <span
                  className={cn(
                    "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold transition-colors",
                    active
                      ? "border-primary bg-primary text-white shadow-[0_0_0_4px_hsl(248_89%_66%/0.15)]"
                      : done
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-white text-muted-foreground group-hover:border-primary/40",
                  )}
                >
                  {done ? <Check className="h-4 w-4" /> : s.n}
                </span>
                <span>
                  <span className={cn("block text-[13.5px] font-semibold", active ? "text-primary" : "text-foreground")}>
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
        <p className="pt-2 font-code text-[10.5px]">v0.1.0 · MIT License</p>
      </div>
    </aside>
  );
}

/* ---------- right output plan rail ---------- */
const PLAN = [
  {
    icon: Database,
    title: "数据集 Schema",
    desc: "根据 skill 的输入、任务与预期输出，生成兼容 Langfuse 的数据集定义。",
    points: ["字段与示例", "元数据（标签、任务类型、来源）", "可直接用于 langfuse.create_dataset()"],
  },
  {
    icon: ListChecks,
    title: "规则评分器",
    desc: "针对关键行为与硬性约束的确定性评分器，零依赖、可复现。",
    points: ["格式与结构检查", "硬约束（必须 / 禁止）校验", "从 skill 中提取的自定义规则"],
  },
  {
    icon: Sparkles,
    title: "LLM 评审",
    desc: "基于 skill 的质量标准与示例生成的 LLM-as-a-judge 评分器。",
    points: ["从 skill 正文提取评分细则", "支持你自己的模型，任意 OpenAI 兼容接口", "兼容 Langfuse 评分流程"],
  },
  {
    icon: FileSliders,
    title: "Langfuse 配置",
    desc: "开箱即用的配置与辅助脚本，在 Langfuse 中记录、评分与可视化结果。",
    points: ["数据集与评分器定义", "SDK 接入示例代码", "环境变量说明"],
  },
];

export function OutputPlan({ ready }: { ready: boolean }) {
  return (
    <aside className="hidden w-[318px] shrink-0 overflow-y-auto border-l bg-white px-6 py-6 xl:block">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[15px] font-bold tracking-tight">生成清单</h2>
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", ready ? "bg-emerald-500" : "bg-amber-400")} />
          {ready ? "已就绪" : "等待导入 skill"}
        </span>
      </div>
      <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
        SkillFuse 将从你的 skill 生成以下内容：
      </p>
      <div className="space-y-6">
        {PLAN.map((p) => (
          <section key={p.title} className="border-t pt-4 first:border-t-0 first:pt-0">
            <div className="flex items-center gap-2">
              <p.icon className="h-4 w-4 text-primary" />
              <h3 className="text-[13.5px] font-semibold">{p.title}</h3>
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
    </aside>
  );
}

/* ---------- shared bits ---------- */
export function StepHeading({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <div className="mb-7">
      <p className="font-code text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{kicker}</p>
      <h1 className="mt-1.5 text-[30px] font-extrabold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted-foreground">{sub}</p>
    </div>
  );
}
