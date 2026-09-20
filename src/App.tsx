import { useCallback, useMemo, useState } from "react";
import type { DatasetItem, ModelConfig, ParsedSkill, RuleCheck, SkillAnalysis, ValidationReport } from "@/core/types";
import { parseSkill } from "@/core/parseSkill";
import { analyzeSkill } from "@/core/analyze";
import { validateSkillPackage } from "@/core/validate";
import { buildDatasetItems, buildRuleChecks, generateArtifacts } from "@/core/generate";
import { OutputPlan, StepBarMobile, StepRail, TopNav } from "@/components/skillfuse/chrome";
import { ImportStep, type ImportedSkill } from "@/components/skillfuse/ImportStep";
import { InspectStep } from "@/components/skillfuse/InspectStep";
import { GenerateStep } from "@/components/skillfuse/GenerateStep";
import { TestStep } from "@/components/skillfuse/TestStep";
import { ModelDialog } from "@/components/skillfuse/ModelDialog";
import { loadModelConfig } from "@/core/modelStore";
import { useToast } from "@/components/ui/toast-context";
import { useTheme } from "@/components/ui/theme";

export default function App() {
  const toast = useToast();
  const { theme, toggle } = useTheme();

  const [step, setStep] = useState(1);
  const [maxReached, setMaxReached] = useState(1);
  const [skill, setSkill] = useState<ParsedSkill | null>(null);
  const [analysis, setAnalysis] = useState<SkillAnalysis | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [rules, setRules] = useState<RuleCheck[]>([]);
  const [items, setItems] = useState<DatasetItem[]>([]);
  const [generated, setGenerated] = useState(false);
  const [modelCfg, setModelCfg] = useState<ModelConfig | null>(() => loadModelConfig());
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* 产物始终由「分析 + 当前规则 + 当前条目」推导——界面改什么，下载到的就是什么。 */
  const artifacts = useMemo(
    () => (analysis ? generateArtifacts(analysis, { rules, items }) : null),
    [analysis, rules, items],
  );

  const goTo = useCallback((n: number) => {
    setStep(n);
    setMaxReached((m) => Math.max(m, n));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleAnalyze = useCallback(
    (imported: ImportedSkill) => {
      const parsed = parseSkill(imported.pkg.skillMd.content, imported.pkg.skillMd.path);
      const a = analyzeSkill(parsed);
      setSkill(parsed);
      setAnalysis(a);
      setReport(validateSkillPackage(imported.pkg, parsed));
      setRules(buildRuleChecks(a));
      setItems(buildDatasetItems(a));
      setGenerated(false);
      goTo(2);
    },
    [goTo],
  );

  const handleGenerate = useCallback(() => {
    if (!analysis) return;
    setGenerated(true);
    goTo(3);
    toast({
      kind: "success",
      message: "评测包已生成",
      detail: `${items.length} 个数据集条目 · ${rules.filter((r) => r.enabled !== false).length} 条规则`,
    });
  }, [analysis, goTo, items.length, rules, toast]);

  const resetCustomizations = useCallback(() => {
    if (!analysis) return;
    setRules(buildRuleChecks(analysis));
    setItems(buildDatasetItems(analysis));
    toast({ kind: "info", message: "已恢复默认规则与条目" });
  }, [analysis, toast]);

  const restart = () => {
    setSkill(null);
    setAnalysis(null);
    setReport(null);
    setRules([]);
    setItems([]);
    setGenerated(false);
    setStep(1);
    setMaxReached(1);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav
        modelCfg={modelCfg}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggle}
      />
      <StepBarMobile step={step} maxReached={maxReached} onSelect={(n) => n <= maxReached && setStep(n)} />
      <div className="flex flex-1 items-stretch">
        <StepRail step={step} maxReached={maxReached} onSelect={(n) => n <= maxReached && setStep(n)} />
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8">
          <div className="mx-auto max-w-[920px]">
            {step === 1 && <ImportStep onAnalyze={handleAnalyze} />}
            {step === 2 && skill && analysis && (
              <InspectStep
                skill={skill}
                analysis={analysis}
                report={report}
                onBack={() => setStep(1)}
                onNext={handleGenerate}
              />
            )}
            {step === 3 && analysis && artifacts && (
              <GenerateStep
                analysis={analysis}
                artifacts={artifacts}
                rules={rules}
                items={items}
                modelCfg={modelCfg}
                onRulesChange={setRules}
                onItemsChange={setItems}
                onReset={resetCustomizations}
                onOpenModelSettings={() => setSettingsOpen(true)}
                onBack={() => setStep(2)}
                onNext={() => goTo(4)}
              />
            )}
            {step === 4 && artifacts && (
              <TestStep
                artifacts={artifacts}
                modelCfg={modelCfg}
                onBack={() => setStep(3)}
                onRestart={restart}
                onOpenModelSettings={() => setSettingsOpen(true)}
              />
            )}
          </div>
        </main>
        <OutputPlan ready={generated} step={step} />
      </div>
      {settingsOpen && (
        <ModelDialog
          onClose={() => setSettingsOpen(false)}
          onSave={(cfg) => {
            setModelCfg(cfg);
            toast(
              cfg
                ? { kind: "success", message: "模型已接入", detail: `${cfg.model} · ${cfg.baseUrl}` }
                : { kind: "info", message: "已清除模型配置" },
            );
          }}
        />
      )}
    </div>
  );
}
