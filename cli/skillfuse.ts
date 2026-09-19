/**
 * SkillFuse CLI — turn a SKILL.md into a Langfuse evaluation pack.
 *
 * Usage:
 *   npx tsx cli/skillfuse.ts <skill.md | skill-dir | skill.zip> [--out <dir>]
 *
 * Example:
 *   npx tsx cli/skillfuse.ts ./skills/customer-support --out ./out
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import JSZip from "jszip";
import { parseSkill } from "../src/core/parseSkill";
import { analyzeSkill } from "../src/core/analyze";
import { generateArtifacts } from "../src/core/generate";

async function readSkillInput(inputPath: string): Promise<{ markdown: string; sourceName: string }> {
  const p = resolve(inputPath);
  if (!existsSync(p)) throw new Error(`not found: ${p}`);

  if (p.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(readFileSync(p));
    const entry = Object.values(zip.files).find((f) => /(^|\/)SKILL\.md$/i.test(f.name));
    if (!entry) throw new Error("no SKILL.md found inside the zip");
    return { markdown: await entry.async("string"), sourceName: entry.name };
  }

  // directory → look for SKILL.md inside
  const dirCandidate = join(p, "SKILL.md");
  const target = existsSync(dirCandidate) ? dirCandidate : p;
  return { markdown: readFileSync(target, "utf-8"), sourceName: basename(target) };
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith("-"));
  const outIdx = args.indexOf("--out");
  const explicitOut = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (!input) {
    console.error("usage: npx tsx cli/skillfuse.ts <skill.md | skill-dir | skill.zip> [--out <dir>]");
    process.exit(1);
  }

  const { markdown, sourceName } = await readSkillInput(input);
  const skill = parseSkill(markdown, sourceName);
  const analysis = analyzeSkill(skill);

  console.log(`\n▸ skill:        ${analysis.skillName}`);
  console.log(`▸ formats:      ${analysis.formats.join(", ") || "(none detected)"}`);
  console.log(`▸ constraints:  ${analysis.constraints.length}`);
  console.log(`▸ steps:        ${analysis.steps.length}`);
  if (analysis.warnings.length > 0) {
    for (const w of analysis.warnings) console.log(`  ⚠ ${w}`);
  }

  const artifacts = generateArtifacts(analysis);
  const outDir = resolve(explicitOut ?? join("skillfuse-out", analysis.skillName));
  mkdirSync(outDir, { recursive: true });

  const files: Record<string, string> = {
    "dataset_schema.json": artifacts.datasetSchema,
    "dataset_items.json": artifacts.datasetItems,
    "rule_scorers.py": artifacts.ruleScorersPy,
    "rule_checks.json": artifacts.ruleChecksJson,
    "llm_judge_prompt.md": artifacts.llmJudgePrompt,
    "llm_judge.py": artifacts.llmJudgePy,
    "langfuse_config.py": artifacts.langfuseConfigPy,
    ".env.example": artifacts.envExample,
    "README.md": artifacts.packReadme,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content);
    console.log(`  ✓ ${name}`);
  }
  console.log(`\ndone → ${outDir}`);
  console.log("next: pip install langfuse openai python-dotenv && cp .env.example .env && python langfuse_config.py");
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
