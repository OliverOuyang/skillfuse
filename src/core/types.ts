/** Shared types for the SkillFuse engine (used by both the web app and the CLI). */

/** A single file inside an imported skill package. */
export interface SkillFile {
  /** path relative to the package root, e.g. "scripts/build.py" */
  path: string;
  content: string;
  size: number;
}

/** A whole imported skill package (directory / zip / single file). */
export interface SkillPackage {
  /** all files in the package, sorted by path; directories are not included */
  files: SkillFile[];
  /** the main SKILL.md document */
  skillMd: SkillFile;
  /** where the package came from (directory name / zip name / file name) */
  sourceName: string;
}

export type IssueSeverity = "error" | "warning" | "info";

export type IssueCategory =
  | "structure" // 目录结构
  | "frontmatter" // frontmatter 字段
  | "body" // 正文七段式
  | "io" // 输入输出规范
  | "trace" // trace / 可观测性
  | "security"; // 安全基线

export interface ValidationIssue {
  ruleId: string;
  severity: IssueSeverity;
  category: IssueCategory;
  /** 面向用户的中文说明 */
  message: string;
  /** 关联文件路径；缺省表示 SKILL.md */
  filePath?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  summary: { errors: number; warnings: number; infos: number; passed: number };
  /** 0..100，按 error/warning 扣分 */
  score: number;
}

export interface SkillSection {
  heading: string;
  level: number;
  body: string;
  bullets: string[];
  numbered: string[];
  codeBlocks: { lang: string; code: string }[];
}

export interface ParsedSkill {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  sections: SkillSection[];
  raw: string;
  wordCount: number;
  sourceName: string;
}

export interface SkillAnalysis {
  skillName: string;
  displayName: string;
  description: string;
  /** detected input kinds, e.g. "CSV file", "natural-language request" */
  inputs: string[];
  /** detected output formats, e.g. "markdown", "json", "pptx" */
  formats: string[];
  /** hard rules: must / never / always lines */
  constraints: string[];
  /** soft quality rubric lines */
  qualityCriteria: string[];
  /** workflow steps in order */
  steps: string[];
  /** tools / APIs / libraries the skill references */
  tools: string[];
  /** words that trigger the skill */
  triggerKeywords: string[];
  /** example snippets found in code blocks */
  examples: { lang: string; code: string; caption: string }[];
  /** headings that describe the expected output structure */
  outputSections: string[];
  /** concrete fields the deliverable must contain (bullets under output-format sections) */
  outputFields: string[];
  warnings: string[];
}

export interface DatasetItem {
  input: unknown;
  expectedOutput?: unknown;
  metadata: Record<string, unknown>;
}

export interface RuleCheck {
  id: string;
  name: string;
  description: string;
  kind: "non_empty" | "min_length" | "contains_any" | "contains_all" | "not_contains" | "has_heading" | "valid_json" | "has_table" | "has_code_block" | "max_length" | "no_emoji";
  params: Record<string, unknown>;
  weight: number;
  /** which part of the skill motivated this rule */
  source: string;
}

export interface RuleResult {
  id: string;
  name: string;
  passed: boolean;
  score: number; // 0..1
  comment: string;
  weight: number;
}

export interface Artifacts {
  /** langfuse-ready dataset definition (schema + metadata) */
  datasetSchema: string;
  /** dataset items as JSON array */
  datasetItems: string;
  /** deterministic python scorers, self-contained */
  ruleScorersPy: string;
  /** the rule checks as JSON (drives the in-browser test runner) */
  ruleChecksJson: string;
  /** LLM-as-judge prompt (markdown) */
  llmJudgePrompt: string;
  /** LLM-as-judge scorer wired to langfuse (python) */
  llmJudgePy: string;
  /** end-to-end langfuse setup script (python) */
  langfuseConfigPy: string;
  /** .env template */
  envExample: string;
  /** README for the generated pack */
  packReadme: string;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}
