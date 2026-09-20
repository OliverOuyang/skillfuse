import { useCallback, useState } from "react";
import type { Artifacts, DatasetItem, ModelConfig, ParsedSkill, SkillAnalysis, ValidationReport } from "@/core/types";
import { parseSkill } from "@/core/parseSkill";
import { analyzeSkill } from "@/core/analyze";
import { validateSkillPackage } from "@/core/validate";
import { generateArtifacts } from "@/core/generate";
import { OutputPlan, StepRail, TopNav } from "@/components/skillfuse/chrome";
import { ImportStep, type ImportedSkill } from "@/components/skillfuse/ImportStep";
import { InspectStep } from "@/components/skillfuse/InspectStep";
import { GenerateStep } from "@/components/skillfuse/GenerateStep";
import { TestStep } from "@/components/skillfuse/TestStep";
import { ModelDialog, loadModelConfig } from "@/components/skillfuse/ModelDialog";

export default function App() {
  const [step, setStep] = useState(1);
  const [maxReached, setMaxReached] = useState(1);
  const [skill, setSkill] = useState<ParsedSkill | null>(null);
  const [analysis, setAnalysis] = useState<SkillAnalysis | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  const [modelCfg, setModelCfg] = useState<ModelConfig | null>(() => loadModelConfig());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const goTo = (n: number) => {
    setStep(n);
    setMaxReached((m) => Math.max(m, n));
  };

  const handleAnalyze = useCallback((imported: ImportedSkill) => {
    const parsed = parseSkill(imported.pkg.skillMd.content, imported.pkg.skillMd.path);
    setSkill(parsed);
    setAnalysis(analyzeSkill(parsed));
    setReport(validateSkillPackage(imported.pkg, parsed));
    setArtifacts(null);
    goTo(2);
  }, []);

  const handleGenerate = useCallback(() => {
    if (!analysis) return;
    setArtifacts(generateArtifacts(analysis));
    goTo(3);
  }, [analysis]);

  const handleAugmented = useCallback((extra: DatasetItem[]) => {
    setArtifacts((prev) => {
      if (!prev) return prev;
      try {
        const items = JSON.parse(prev.datasetItems) as DatasetItem[];
        return { ...prev, datasetItems: JSON.stringify([...items, ...extra], null, 2) };
      } catch {
        return prev;
      }
    });
  }, []);

  const restart = () => {
    setSkill(null);
    setAnalysis(null);
    setReport(null);
    setArtifacts(null);
    setStep(1);
    setMaxReached(1);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav onOpenSettings={() => setSettingsOpen(true)} />
      <div className="flex flex-1 items-stretch">
        <StepRail step={step} maxReached={maxReached} onSelect={(n) => n <= maxReached && setStep(n)} />
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
          <div className="mx-auto max-w-[860px]">
            {step === 1 && <ImportStep onAnalyze={handleAnalyze} />}
            {step === 2 && skill && analysis && (
              <InspectStep skill={skill} analysis={analysis} report={report} onBack={() => setStep(1)} onNext={handleGenerate} />
            )}
            {step === 3 && analysis && artifacts && (
              <GenerateStep
                analysis={analysis}
                artifacts={artifacts}
                modelCfg={modelCfg}
                onAugmented={handleAugmented}
                onBack={() => setStep(2)}
                onNext={() => goTo(4)}
              />
            )}
            {step === 4 && artifacts && (
              <TestStep artifacts={artifacts} modelCfg={modelCfg} onBack={() => setStep(3)} onRestart={restart} />
            )}
          </div>
        </main>
        <OutputPlan ready={artifacts !== null} />
      </div>
      <ModelDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={setModelCfg} />
    </div>
  );
}
