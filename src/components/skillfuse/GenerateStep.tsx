import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  FileCode2,
  FlaskConical,
  Loader2,
  Package,
  Plus,
  RotateCcw,
  Scale,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import JSZip from "jszip";
import type { Artifacts, DatasetItem, ModelConfig, RuleCheck, SkillAnalysis } from "@/core/types";
import {
  type ChangeAction,
  describeError,
  optimizeDatasetItems,
  optimizeRuleChecks,
  summarizeChanges,
} from "@/core/llm";
import { emitLoopxEvaluatorPy, emitLoopxReadme, toLoopxCases } from "@/core/exportLoopx";
import { CodeView, CopyButton, DownloadButton } from "./CodeView";
import { downloadText } from "./download";
import { StepFooter, StepHeading } from "./chrome";
import { Badge, Button, Card, EmptyState, SectionLabel, Segmented, Toggle } from "@/components/ui";
import { useToast } from "@/components/ui/toast-context";
import { cn } from "@/lib/utils";

interface FileTab {
  id: keyof Artifacts;
  file: string;
  lang: string;
  desc: string;
}

const FILES: FileTab[] = [
  { id: "datasetSchema", file: "dataset_schema.json", lang: "json", desc: "Langfuse 数据集定义" },
  { id: "datasetItems", file: "dataset_items.json", lang: "json", desc: "数据集条目" },
  { id: "ruleScorersPy", file: "rule_scorers.py", lang: "python", desc: "确定性规则评分器" },
  { id: "ruleChecksJson", file: "rule_checks.json", lang: "json", desc: "规则的数据形态" },
  { id: "llmJudgePrompt", file: "llm_judge_prompt.md", lang: "markdown", desc: "评审 rubric" },
  { id: "llmJudgePy", file: "llm_judge.py", lang: "python", desc: "LLM 评审评分器" },
  { id: "langfuseConfigPy", file: "langfuse_config.py", lang: "python", desc: "一键建数据集" },
  { id: "envExample", file: ".env.example", lang: "env", desc: "环境变量模板" },
  { id: "packReadme", file: "README.md", lang: "markdown", desc: "评测包说明" },
];

const KIND_LABEL: Record<RuleCheck["kind"], string> = {
  non_empty: "非空",
  min_length: "最小长度",
  max_length: "最大长度",
  contains_any: "包含任一",
  contains_all: "包含全部",
  not_contains: "不得包含",
  has_heading: "含标题",
  valid_json: "合法 JSON",
  has_table: "含表格",
  has_code_block: "含代码块",
  no_emoji: "无 emoji",
};

/** 导出给评测助手时，加权分达到该值才判 task_completed——助手只收布尔，默认要求全过。 */
const LOOPX_THRESHOLD = 1;

type View = "rules" | "items" | "files";

export function GenerateStep({
  analysis,
  artifacts,
  rules,
  items,
  modelCfg,
  onRulesChange,
  onItemsChange,
  onReset,
  onOpenModelSettings,
  onBack,
  onNext,
}: {
  analysis: SkillAnalysis;
  artifacts: Artifacts;
  rules: RuleCheck[];
  items: DatasetItem[];
  modelCfg: ModelConfig | null;
  onRulesChange: (r: RuleCheck[]) => void;
  onItemsChange: (i: DatasetItem[]) => void;
  onReset: () => void;
  onOpenModelSettings: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<View>("rules");
  const [activeFile, setActiveFile] = useState<FileTab>(FILES[0]);
  const [augmenting, setAugmenting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [changes, setChanges] = useState<{ action: ChangeAction; label: string; reason: string }[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const activeRules = rules.filter((r) => r.enabled !== false);
  const weightTotal = activeRules.reduce((s, r) => s + r.weight, 0);

  const optimizeItems = async () => {
    if (!modelCfg) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setAugmenting(true);
    try {
      const { next, changes } = await optimizeDatasetItems(modelCfg, analysis, items, { signal: ac.signal });
      onItemsChange(next);
      setChanges(changes);
      setView("items");
      toast({
        kind: "success",
        message: `数据集已优化：${summarizeChanges(changes)}`,
        detail: `${items.length} → ${next.length} 条 · 来自 ${modelCfg.model}`,
      });
    } catch (e) {
      const d = describeError(e);
      toast({ kind: "error", message: `优化条目失败：${d.message}`, detail: d.hint });
    } finally {
      setAugmenting(false);
    }
  };

  const optimizeRules = async () => {
    if (!modelCfg) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSuggesting(true);
    try {
      const { next, changes } = await optimizeRuleChecks(modelCfg, analysis, rules, { signal: ac.signal });
      onRulesChange(next);
      setChanges(changes);
      setView("rules");
      toast({
        kind: "success",
        message: `评分器已优化：${summarizeChanges(changes)}`,
        detail: `${rules.length} → ${next.length} 条 · 判分仍由本地确定性引擎执行`,
      });
    } catch (e) {
      const d = describeError(e);
      toast({ kind: "error", message: `优化规则失败：${d.message}`, detail: d.hint });
    } finally {
      setSuggesting(false);
    }
  };

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder(`${analysis.skillName}-eval`)!;
    for (const f of FILES) folder.file(f.file, artifacts[f.id] ?? "");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${analysis.skillName}-eval.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ kind: "success", message: "评测包已下载", detail: `${analysis.skillName}-eval.zip（${FILES.length} 个文件）` });
  };

  /** 导出 SH-LoopX 评测助手能直接消化的案例包（含规则评分器）。 */
  const downloadLoopxPack = async () => {
    const exported = toLoopxCases(items);
    const zip = new JSZip();
    const folder = zip.folder(`${analysis.skillName}-loopx`)!;
    folder.file("loopx-cases.json", JSON.stringify(exported.cases, null, 2));
    folder.file("loopx-structural-cases.json", JSON.stringify(exported.structuralOnly, null, 2));
    folder.file("loopx-manifest.json", JSON.stringify(exported.manifest, null, 2));
    folder.file("loopx_evaluator.py", emitLoopxEvaluatorPy(rules, LOOPX_THRESHOLD));
    folder.file("README.md", emitLoopxReadme(analysis.skillName, exported, LOOPX_THRESHOLD));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${analysis.skillName}-loopx.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast({
      kind: exported.cases.length > 0 ? "success" : "info",
      message: "评测助手案例包已下载",
      detail:
        exported.cases.length > 0
          ? `正式案例 ${exported.cases.length} 条 · 结构判定案例 ${exported.structuralOnly.length} 条`
          : `还没有条目填了标准答案——${exported.structuralOnly.length} 条只能按结构判定。在「数据集条目」里补答案后再导出。`,
    });
  };

  return (
    <div>
      <StepHeading
        kicker="第 3 步 · 生成"
        title="你的评测包"
        sub={`已为「${analysis.skillName}」生成 ${items.length} 个数据集条目和 ${activeRules.length} 条规则检查。规则与条目都可以在这里直接调，改完即时反映到右侧产物文件里。`}
      />

      {/* 操作条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={downloadZip}>
          <Package className="h-4 w-4" /> 下载整包（.zip）
        </Button>
        <Button
          variant="secondary"
          onClick={downloadLoopxPack}
          title="导出 SH-LoopX 评测助手能直接消化的案例包：业务 JSON 案例 + 规则评分器。保存仍需在助手里预览确认。"
        >
          <Send className="h-4 w-4" /> 导出评测助手案例包
        </Button>
        {modelCfg ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="subtle"
              onClick={optimizeItems}
              disabled={augmenting || suggesting}
              title="让模型通盘优化数据集：改写模糊任务、删重复条目、补缺失的边界场景"
            >
              {augmenting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {augmenting ? "正在优化条目…" : "用模型优化数据集"}
            </Button>
            <Button
              variant="subtle"
              onClick={optimizeRules}
              disabled={augmenting || suggesting}
              title="让模型通盘优化评分器：调权重、改关键词、删冗余、补这个 skill 专属的检查"
            >
              {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scale className="h-4 w-4" />}
              {suggesting ? "正在优化评分器…" : "用模型优化评分器"}
            </Button>
            {(augmenting || suggesting) && (
              <Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                取消
              </Button>
            )}
          </div>
        ) : (
          <Button variant="secondary" onClick={onOpenModelSettings}>
            <Sparkles className="h-4 w-4" /> 接入模型以优化条目与评分器
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setChanges([]);
            onReset();
          }}
          title="放弃对规则与条目的改动"
        >
          <RotateCcw className="h-3.5 w-3.5" /> 重置改动
        </Button>
      </div>

      {changes.length > 0 && <ChangeLog changes={changes} onDismiss={() => setChanges([])} />}

      <Segmented<View>
        className="mb-4"
        value={view}
        onChange={setView}
        options={[
          { value: "rules", label: <span className="flex items-center gap-1.5"><Scale className="h-3.5 w-3.5" />规则评分器</span>, count: activeRules.length },
          { value: "items", label: <span className="flex items-center gap-1.5"><FlaskConical className="h-3.5 w-3.5" />数据集条目</span>, count: items.length },
          { value: "files", label: <span className="flex items-center gap-1.5"><FileCode2 className="h-3.5 w-3.5" />产物文件</span>, count: FILES.length },
        ]}
      />

      {view === "rules" && (
        <RuleEditor rules={rules} weightTotal={weightTotal} onChange={onRulesChange} />
      )}

      {view === "items" && <ItemEditor items={items} onChange={onItemsChange} />}

      {view === "files" && (
        <div className="grid gap-3 lg:grid-cols-[236px_minmax(0,1fr)]">
          <Card className="h-fit overflow-hidden p-1.5">
            {FILES.map((f) => (
              <button
                key={f.id}
                onClick={() => setActiveFile(f)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  activeFile.id === f.id ? "bg-primary/10" : "hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "font-code text-[11.5px] font-medium",
                    activeFile.id === f.id ? "text-primary" : "text-foreground",
                  )}
                >
                  {f.file}
                </span>
                <span className="text-[11px] text-muted-foreground">{f.desc}</span>
              </button>
            ))}
          </Card>

          <Card className="min-w-0 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-code text-[12.5px] font-medium">{activeFile.file}</p>
                <p className="text-[11.5px] text-muted-foreground">
                  {activeFile.desc} · {((artifacts[activeFile.id] ?? "").length / 1024).toFixed(1)} KB
                </p>
              </div>
              <div className="flex gap-2">
                <CopyButton text={artifacts[activeFile.id] ?? ""} />
                <DownloadButton filename={activeFile.file} content={artifacts[activeFile.id] ?? ""} label="下载" />
              </div>
            </div>
            <CodeView code={artifacts[activeFile.id] ?? ""} lang={activeFile.lang} searchable />
          </Card>
        </div>
      )}

      <Card className="mt-6 p-4">
        <p className="mb-1.5 text-[13px] font-semibold">接入 Langfuse</p>
        <div className="flex items-start justify-between gap-3">
          <code className="block flex-1 whitespace-pre rounded-md bg-muted p-2.5 font-code text-[11.5px] leading-relaxed text-foreground">
            {QUICKSTART}
          </code>
          <Button variant="secondary" size="sm" onClick={() => downloadText("quickstart.sh", QUICKSTART)}>
            保存脚本
          </Button>
        </div>
      </Card>

      <StepFooter>
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> 上一步
        </Button>
        <Button variant="primary" size="lg" onClick={onNext}>
          去试运行评分器 <ArrowRight className="h-4 w-4" />
        </Button>
      </StepFooter>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 优化改动清单                                                        */
/* ------------------------------------------------------------------ */

const ACTION_TONE: Record<ChangeAction, "success" | "primary" | "danger" | "neutral"> = {
  add: "success",
  modify: "primary",
  drop: "danger",
  keep: "neutral",
};

const ACTION_TEXT: Record<ChangeAction, string> = { add: "新增", modify: "修改", drop: "删除", keep: "保留" };

function ChangeLog({
  changes,
  onDismiss,
}: {
  changes: { action: ChangeAction; label: string; reason: string }[];
  onDismiss: () => void;
}) {
  return (
    <Card className="mb-4 border-primary/25 bg-primary/5 p-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionLabel>本次优化改了什么</SectionLabel>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          <X className="h-3.5 w-3.5" /> 收起
        </Button>
      </div>
      <ul className="space-y-1.5">
        {changes.map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
            <Badge tone={ACTION_TONE[c.action]}>{ACTION_TEXT[c.action]}</Badge>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{c.label}</span>
              {c.reason && <span className="text-muted-foreground"> — {c.reason}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 规则编辑器                                                          */
/* ------------------------------------------------------------------ */

function RuleEditor({
  rules,
  weightTotal,
  onChange,
}: {
  rules: RuleCheck[];
  weightTotal: number;
  onChange: (r: RuleCheck[]) => void;
}) {
  const patch = (id: string, p: Partial<RuleCheck>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));

  if (rules.length === 0) {
    return <EmptyState icon={Scale} title="没有生成任何规则" sub="这个 skill 里没有检测到可量化的硬约束或输出格式。" />;
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        <Settings2 className="h-3.5 w-3.5" />
        权重决定每条规则在总分里的占比（当前总权重 {weightTotal}）。关掉的规则不会写进评测包。
      </div>

      {rules.map((rule) => {
        const on = rule.enabled !== false;
        const share = on && weightTotal > 0 ? (rule.weight / weightTotal) * 100 : 0;
        return (
          <Card key={rule.id} className={cn("p-4 transition-opacity", !on && "opacity-55")}>
            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <Toggle checked={on} onChange={(v) => patch(rule.id, { enabled: v })} label={`启用规则 ${rule.name}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13.5px] font-semibold">{rule.name}</p>
                  <Badge tone="primary">{KIND_LABEL[rule.kind]}</Badge>
                  {rule.source.includes("模型优化") && <Badge tone="neutral">模型优化</Badge>}
                  <span className="font-code text-[10.5px] text-muted-foreground">{rule.id}</span>
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{rule.description}</p>
                <p className="mt-1 text-[11.5px] text-muted-foreground/80">来源：{rule.source}</p>

                <RuleParams rule={rule} onChange={(params) => patch(rule.id, { params })} />
              </div>

              <div className="w-28 shrink-0">
                <SectionLabel className="mb-1">权重 {rule.weight}</SectionLabel>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={rule.weight}
                  disabled={!on}
                  onChange={(e) => patch(rule.id, { weight: Number(e.target.value) })}
                  className="w-full accent-[hsl(var(--primary))]"
                  aria-label={`${rule.name} 权重`}
                />
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${share}%` }} />
                </div>
                <p className="mt-1 text-right font-code text-[10.5px] text-muted-foreground">
                  占比 {share.toFixed(0)}%
                </p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function RuleParams({ rule, onChange }: { rule: RuleCheck; onChange: (p: Record<string, unknown>) => void }) {
  const p = rule.params ?? {};
  const terms = Array.isArray(p.terms) ? (p.terms as string[]) : null;
  const [draft, setDraft] = useState("");

  const numberField = (key: "min" | "max", label: string) => (
    <label className="flex items-center gap-2">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <input
        type="number"
        min={0}
        value={Number(p[key] ?? 0)}
        onChange={(e) => onChange({ ...p, [key]: Number(e.target.value) })}
        className="h-7 w-24 rounded-md border bg-card px-2 font-code text-[11.5px] outline-none focus:border-primary"
      />
    </label>
  );

  const hasParams = terms || "min" in p || "max" in p || "min_match" in p;
  if (!hasParams) return null;

  return (
    <div className="mt-2.5 space-y-2 rounded-lg border bg-muted/40 p-2.5">
      <div className="flex flex-wrap items-center gap-3">
        {"min" in p && numberField("min", "最小加权长度")}
        {"max" in p && numberField("max", "最大加权长度")}
        {terms && "min_match" in p && (
          <label className="flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground">至少命中</span>
            <input
              type="number"
              min={1}
              max={terms.length}
              value={Number(p.min_match ?? 1)}
              onChange={(e) => onChange({ ...p, min_match: Number(e.target.value) })}
              className="h-7 w-16 rounded-md border bg-card px-2 font-code text-[11.5px] outline-none focus:border-primary"
            />
            <span className="text-[11.5px] text-muted-foreground">/ {terms.length}</span>
          </label>
        )}
      </div>

      {terms && (
        <div>
          <div className="flex flex-wrap gap-1.5">
            {terms.map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 font-code text-[11px]"
              >
                {t}
                <button
                  onClick={() => onChange({ ...p, terms: terms.filter((_, j) => j !== i) })}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`移除 ${t}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {terms.length === 0 && <span className="text-[11.5px] italic text-muted-foreground">暂无关键词</span>}
          </div>
          <div className="mt-2 flex gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  onChange({ ...p, terms: [...terms, draft.trim()] });
                  setDraft("");
                }
              }}
              placeholder="添加关键词后回车"
              className="h-7 flex-1 rounded-md border bg-card px-2 text-[11.5px] outline-none focus:border-primary"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!draft.trim()}
              onClick={() => {
                onChange({ ...p, terms: [...terms, draft.trim()] });
                setDraft("");
              }}
            >
              <Plus className="h-3 w-3" /> 添加
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 数据集条目编辑器                                                    */
/* ------------------------------------------------------------------ */

const SOURCE_LABEL: Record<string, string> = {
  "skill-body": "正文推断",
  "skill-example": "示例参考",
  "constraint-adversarial": "约束对抗",
  "llm-augmented": "模型补充",
  "llm-optimized": "模型优化",
};

const DIFFICULTY_TONE = { basic: "success", intermediate: "primary", edge: "warning" } as const;

function ItemEditor({ items, onChange }: { items: DatasetItem[]; onChange: (i: DatasetItem[]) => void }) {
  const stats = useMemo(() => {
    const by: Record<string, number> = {};
    for (const it of items) {
      const s = String(it.metadata?.source ?? "unknown");
      by[s] = (by[s] ?? 0) + 1;
    }
    return by;
  }, [items]);

  const setTask = (idx: number, task: string) =>
    onChange(
      items.map((it, i) =>
        i === idx ? { ...it, input: { ...(it.input as Record<string, unknown>), task } } : it,
      ),
    );

  /** 标准答案由业务填写——评测助手的正式案例必须带它，缺失的条目只能按结构判定。 */
  const setAnswer = (idx: number, answer: string) =>
    onChange(
      items.map((it, i) =>
        i === idx ? { ...it, expectedOutput: { ...(it.expectedOutput as Record<string, unknown>), answer } } : it,
      ),
    );

  const addBlank = () =>
    onChange([
      ...items,
      {
        input: { task: "", context: {} },
        expectedOutput: { must_include: [], format: "markdown", notes: "手工添加的条目。" },
        metadata: { source: "manual", tags: [], difficulty: "basic" },
      },
    ]);

  if (items.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState icon={FlaskConical} title="数据集里还没有条目" sub="可以手工添加，或用接入的模型补充。" />
        <Button variant="secondary" onClick={addBlank}>
          <Plus className="h-4 w-4" /> 添加空白条目
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(stats).map(([k, n]) => (
          <Badge key={k} tone="neutral">
            {SOURCE_LABEL[k] ?? k} {n}
          </Badge>
        ))}
        <Button variant="secondary" size="sm" className="ml-auto" onClick={addBlank}>
          <Plus className="h-3.5 w-3.5" /> 添加条目
        </Button>
      </div>

      {items.map((item, idx) => {
        const input = (item.input ?? {}) as Record<string, unknown>;
        const expected = (item.expectedOutput ?? {}) as Record<string, unknown>;
        const meta = item.metadata ?? {};
        const difficulty = String(meta.difficulty ?? "basic") as keyof typeof DIFFICULTY_TONE;
        const mustInclude = Array.isArray(expected.must_include) ? (expected.must_include as string[]) : [];
        const mustNot = Array.isArray(expected.must_not_include) ? (expected.must_not_include as string[]) : [];
        const rawAnswer = expected.expected_result ?? expected.answer;
        const answerText =
          rawAnswer === undefined || rawAnswer === null
            ? ""
            : typeof rawAnswer === "string"
              ? rawAnswer
              : JSON.stringify(rawAnswer);
        const hasAnswer = answerText.trim().length > 0;

        return (
          <Card key={idx} className="p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-code text-[11px] text-muted-foreground">#{idx + 1}</span>
              <Badge tone="neutral">{SOURCE_LABEL[String(meta.source ?? "")] ?? String(meta.source ?? "手工")}</Badge>
              <Badge tone={DIFFICULTY_TONE[difficulty] ?? "neutral"}>{difficulty}</Badge>
              {typeof expected.format === "string" && (
                <Badge tone="primary">格式 {expected.format}</Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                aria-label={`删除条目 ${idx + 1}`}
              >
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </Button>
            </div>

            <SectionLabel className="mb-1">任务（input.task）</SectionLabel>
            <textarea
              value={String(input.task ?? "")}
              onChange={(e) => setTask(idx, e.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border bg-card p-2.5 text-[12.5px] leading-relaxed outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
              placeholder="描述一个应当触发该 skill 的用户请求…"
            />

            <SectionLabel className="mb-1 mt-2.5">
              标准答案（expected_result）
              {hasAnswer ? (
                <Badge tone="success" className="ml-2">已填</Badge>
              ) : (
                <Badge tone="warning" className="ml-2">待补</Badge>
              )}
            </SectionLabel>
            <textarea
              value={answerText}
              onChange={(e) => setAnswer(idx, e.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border bg-card p-2.5 font-code text-[12px] leading-relaxed outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
              placeholder='业务核对过的答案；SQL 取数类可填表格 JSON：{"columns": [...], "rows": [[...]], "tolerance": 0.0000005}'
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              只有填了这里的条目才会进「评测助手正式案例」；留空的进结构判定清单。不要用被测 skill 自己的输出当标准答案。
            </p>

            {(mustInclude.length > 0 || mustNot.length > 0) && (
              <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {mustInclude.length > 0 && (
                  <div>
                    <SectionLabel className="mb-1">必须包含</SectionLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {mustInclude.slice(0, 6).map((t, i) => (
                        <Badge key={i} tone="success">
                          {t.length > 28 ? `${t.slice(0, 28)}…` : t}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {mustNot.length > 0 && (
                  <div>
                    <SectionLabel className="mb-1">不得包含</SectionLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {mustNot.slice(0, 6).map((t, i) => (
                        <Badge key={i} tone="danger">
                          {t.length > 28 ? `${t.slice(0, 28)}…` : t}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {typeof expected.notes === "string" && expected.notes && (
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">{expected.notes}</p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

const QUICKSTART = `pip install langfuse openai python-dotenv
cp .env.example .env   # 填入你的 Langfuse 密钥
python langfuse_config.py`;
