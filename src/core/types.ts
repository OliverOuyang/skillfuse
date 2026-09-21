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
  | "naming" // skill 命名规范
  | "frontmatter" // frontmatter 字段
  | "body" // 正文七段式
  | "io" // 输入输出规范
  | "report" // 策略/分析报告类 skill 专项（仅对该类 skill 生效）
  | "trace" // trace / 可观测性
  | "security"; // 安全基线

export interface ValidationIssue {
  ruleId: string;
  /** 规则短名，用于报告标题 */
  ruleName: string;
  severity: IssueSeverity;
  category: IssueCategory;
  /** 面向用户的中文说明 */
  message: string;
  /** 可执行的修复建议 */
  hint?: string;
  /** 可直接复制到 skill 包中的修复示例 */
  example?: { lang: string; code: string; filename?: string };
  /** 关联文件路径；缺省表示 SKILL.md */
  filePath?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** 全部通过的规则（用于「已通过」列表展示） */
  passedRules: { ruleId: string; ruleName: string; category: IssueCategory }[];
  summary: { errors: number; warnings: number; infos: number; passed: number; total: number };
  /** 0..100，按 error/warning 扣分 */
  score: number;
  /** 按分类汇总，驱动检查页的分类卡片 */
  byCategory: Record<IssueCategory, { errors: number; warnings: number; infos: number; passed: number; total: number }>;
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
  /** 是否要求把交付物写入文件 */
  deliversFile: boolean;
  warnings: string[];
}

export type ContractFormat = "markdown" | "html" | "json" | "text";
export type FactStatus = "pending" | "confirmed";

export interface ContractFact {
  /** 指标名，例如「通过率」「申请量」 */
  name: string;
  /** 业务确认的期望值；pending 时为 null */
  value: number | string | null;
  /** 数值型指标的绝对误差容忍度 */
  tolerance?: number;
  /** 单位提示，例如 "%"、"万元"；用于数值归一 */
  unit?: string;
  status: FactStatus;
}

export interface ContractTableSpec {
  /** 必备列名；空数组表示只要求「存在表格」 */
  columns: string[];
}

export interface AcceptanceContract {
  format: ContractFormat;
  /** structure = facts 全为 pending，只判结构；facts = 关键数据已由业务确认，硬判数值 */
  verification_level: "structure" | "facts";
  required_sections: string[];
  required_tables: ContractTableSpec[];
  facts: ContractFact[];
  /** 必须出现的结论性表述（子串匹配） */
  required_statements: string[];
  must_include: string[];
  must_not_include: string[];
  /** HTML 交付物：禁止引用外部脚本 / 样式 / 图片，保证离线可打开 */
  forbid_external_scripts: boolean;
  notes: string;
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
  /** UI 开关：false 时该规则不会进入生成的评测包（生成前会被剔除） */
  enabled?: boolean;
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
  /** 预设厂商 id（见 core/providers.ts），custom 表示自定义端点 */
  providerId?: string;
  /** 采样温度，缺省 0.3 */
  temperature?: number;
  /** 单次请求最大输出 token，缺省不限制 */
  maxTokens?: number;
  /** 请求超时（毫秒），缺省 60000 */
  timeoutMs?: number;
  /** 经本机 vite 服务中转，用于绕开端点不返回 CORS 头的问题（仅 dev / preview 可用） */
  useProxy?: boolean;
}

/** 生成评测包时的可选覆盖项——让用户在界面上调完规则与条目后重新生成。 */
export interface GenerateOptions {
  /** 覆盖默认规则集（已剔除禁用项） */
  rules?: RuleCheck[];
  /** 覆盖默认数据集条目（含 LLM 补充与用户删改） */
  items?: DatasetItem[];
}
