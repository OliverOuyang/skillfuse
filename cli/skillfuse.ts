/**
 * SkillFuse CLI — turn a SKILL.md into a Langfuse evaluation pack.
 *
 * Usage:
 *   npx tsx cli/skillfuse.ts <skill.md | skill-dir | skill.zip> [--out <dir>] [--strict]
 *
 * Example:
 *   npx tsx cli/skillfuse.ts ./skills/customer-support --out ./out
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import JSZip from "jszip";
import { parseSkill } from "../src/core/parseSkill";
import { analyzeSkill } from "../src/core/analyze";
import { reportToMarkdown, validateSkillPackage } from "../src/core/validate";
import { buildSkillPackage, isReadableSize } from "../src/core/package";
import type { SkillFile } from "../src/core/types";
import { buildDatasetItems, buildRuleChecks, generateArtifacts } from "../src/core/generate";
import { emitLoopxEvaluatorPy, emitLoopxReadme, toLoopxCases } from "../src/core/exportLoopx";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

function collectDir(dir: string, prefix: string, out: SkillFile[]): void {
  if (out.length >= 300) return;
  for (const entry of readdirSync(dir)) {
    if (out.length >= 300) return;
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectDir(full, rel, out);
    } else if (st.isFile() && isReadableSize(st.size)) {
      out.push({ path: rel, content: readFileSync(full, "utf-8"), size: st.size });
    }
  }
}

async function readSkillInput(inputPath: string): Promise<{ files: SkillFile[]; sourceName: string }> {
  const p = resolve(inputPath);
  if (!existsSync(p)) throw new Error(`not found: ${p}`);

  if (p.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(readFileSync(p));
    const entries = Object.values(zip.files).filter((f) => !f.dir);
    const files: SkillFile[] = [];
    for (const f of entries) {
      if (files.length >= 300) break;
      if (!isReadableSize((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0)) continue;
      const content = await f.async("string");
      files.push({ path: f.name, content, size: content.length });
    }
    return { files, sourceName: basename(p) };
  }

  if (statSync(p).isDirectory()) {
    const files: SkillFile[] = [];
    collectDir(p, "", files);
    return { files, sourceName: basename(p) };
  }

  const content = readFileSync(p, "utf-8");
  return { files: [{ path: basename(p), content, size: content.length }], sourceName: basename(p) };
}

const SEV_ICON = { error: "✗", warning: "⚠", info: "ℹ" } as const;
const SEV_LABEL = { error: "error", warning: "warn ", info: "info " } as const;

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith("-"));
  const outIdx = args.indexOf("--out");
  const explicitOut = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const strict = args.includes("--strict");
  const formatIdx = args.indexOf("--format");
  const format = formatIdx >= 0 ? args[formatIdx + 1] : "langfuse";
  const thresholdIdx = args.indexOf("--threshold");
  const threshold = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 1;

  if (!input) {
    console.error(
      "usage: npx tsx cli/skillfuse.ts <skill.md | skill-dir | skill.zip> [--out <dir>] [--strict] [--format langfuse|loopx] [--threshold 1]",
    );
    process.exit(1);
  }
  if (format !== "langfuse" && format !== "loopx") {
    console.error(`error: 未知的 --format ${format}（可选 langfuse | loopx）`);
    process.exit(1);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error("error: --threshold 需为 (0, 1] 之间的数值");
    process.exit(1);
  }

  const { files, sourceName } = await readSkillInput(input);
  const pkg = buildSkillPackage(files, sourceName);
  const skill = parseSkill(pkg.skillMd.content, pkg.skillMd.path);
  const analysis = analyzeSkill(skill);
  const report = validateSkillPackage(pkg, skill);

  console.log(`\n▸ skill：      ${analysis.skillName}`);
  console.log(`▸ 包内容：     ${pkg.files.length} 个文件`);
  console.log(`▸ 输出格式：   ${analysis.formats.join(", ") || "（未检测到）"}`);
  console.log(`▸ 硬约束：     ${analysis.constraints.length} 条`);
  console.log(`▸ 工作流步骤： ${analysis.steps.length} 步`);

  console.log(
    `\n▸ 规范检查：   得分 ${report.score}/100（通过 ${report.summary.passed}/${report.summary.total} 条规则）`,
  );
  for (const issue of report.issues) {
    console.log(`  ${SEV_ICON[issue.severity]} [${SEV_LABEL[issue.severity]}] ${issue.ruleName} — ${issue.message}`);
    if (issue.hint) console.log(`      怎么修：${issue.hint}`);
  }
  if (report.issues.length === 0) {
    console.log("  ✓ 全部规则通过");
  }
  if (strict && report.summary.errors > 0) {
    console.error(`\nstrict 模式：存在 ${report.summary.errors} 个 error，终止。`);
    process.exit(1);
  }

  const rules = buildRuleChecks(analysis);
  const items = buildDatasetItems(analysis);
  const artifacts = generateArtifacts(analysis, { rules, items });
  const outDir = resolve(explicitOut ?? join("skillfuse-out", analysis.skillName));
  mkdirSync(outDir, { recursive: true });

  const outputs: Record<string, string> = {
    "dataset_schema.json": artifacts.datasetSchema,
    "dataset_items.json": artifacts.datasetItems,
    "rule_scorers.py": artifacts.ruleScorersPy,
    "rule_checks.json": artifacts.ruleChecksJson,
    "llm_judge_prompt.md": artifacts.llmJudgePrompt,
    "llm_judge.py": artifacts.llmJudgePy,
    "langfuse_config.py": artifacts.langfuseConfigPy,
    ".env.example": artifacts.envExample,
    "README.md": artifacts.packReadme,
    "spec_report.md": reportToMarkdown(report, analysis.skillName),
  };

  if (format === "loopx") {
    const exported = toLoopxCases(items);
    outputs["loopx_cases.json"] = JSON.stringify(exported.cases, null, 2);
    outputs["loopx_structural_cases.json"] = JSON.stringify(exported.structuralOnly, null, 2);
    outputs["loopx_manifest.json"] = JSON.stringify(exported.manifest, null, 2);
    outputs["loopx_evaluator.py"] = emitLoopxEvaluatorPy(rules, threshold);
    outputs["loopx_README.md"] = emitLoopxReadme(analysis.skillName, exported, threshold);
    console.log(
      `\n▸ 评测助手包： 正式案例 ${exported.cases.length} 条 · 结构判定案例 ${exported.structuralOnly.length} 条` +
        (exported.skipped.length > 0 ? ` · 跳过 ${exported.skipped.length} 条` : ""),
    );
    if (exported.cases.length === 0) {
      console.log("  ⚠ 还没有条目带业务确认的标准答案——正式案例为空，先在生成页补 expected_result / answer。");
    }
  }

  for (const [name, content] of Object.entries(outputs)) {
    writeFileSync(join(outDir, name), content);
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n完成 → ${outDir}`);
  console.log(
    format === "loopx"
      ? "下一步：把 loopx_cases.json 粘给 Skill 评测助手预览确认（话术见 loopx_README.md）"
      : "下一步：pip install langfuse openai python-dotenv && cp .env.example .env && python langfuse_config.py",
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
