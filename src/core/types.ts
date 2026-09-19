/** Shared types for the SkillFuse engine (used by both the web app and the CLI). */

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
