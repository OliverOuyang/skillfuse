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
        Turn AI skills into measurable impact.
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
          Model settings
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
  { n: 1, title: "Import Skill", sub: "Add your SKILL.md or ZIP" },
  { n: 2, title: "Inspect", sub: "Review skill metadata" },
  { n: 3, title: "Generate", sub: "Create datasets and scorers" },
  { n: 4, title: "Test", sub: "Run and validate" },
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
        <p>Open source. Build better AI.</p>
        <a
          href="https://github.com/OliverOuyang/skillfuse"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 hover:text-foreground"
        >
          <Github className="h-3.5 w-3.5" /> View on GitHub
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
    title: "Dataset schema",
    desc: "A Langfuse-compatible dataset schema derived from your skill's inputs, tasks and expected outputs.",
    points: ["Fields and examples", "Metadata (tags, task type, source)", "Ready for langfuse.create_dataset()"],
  },
  {
    icon: ListChecks,
    title: "Rule scorers",
    desc: "Deterministic evaluators for key behaviors and constraints.",
    points: ["Format and structure checks", "Hard-constraint validation", "Custom rules from your skill"],
  },
  {
    icon: Sparkles,
    title: "LLM judge",
    desc: "An LLM-as-a-judge scorer using your skill's rubric and examples.",
    points: ["Graded criteria from the skill body", "Your own model, any OpenAI-compatible API", "Langfuse-compatible scorer"],
  },
  {
    icon: FileSliders,
    title: "Langfuse config",
    desc: "Ready-to-use configuration and helpers to log, evaluate and visualize results in Langfuse.",
    points: ["Dataset and scorer definitions", "SDK integration snippets", "Environment variable guidance"],
  },
];

export function OutputPlan({ ready }: { ready: boolean }) {
  return (
    <aside className="hidden w-[318px] shrink-0 overflow-y-auto border-l bg-white px-6 py-6 xl:block">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[15px] font-bold tracking-tight">Output plan</h2>
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", ready ? "bg-emerald-500" : "bg-amber-400")} />
          {ready ? "Ready" : "Waiting for skill"}
        </span>
      </div>
      <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
        Here's what SkillFuse will generate from your skill:
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
