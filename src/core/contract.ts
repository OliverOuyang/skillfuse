/**
 * 验收契约只保存可复查的结构要求与业务已确认事实。
 * 自动分析无法知道业务真值，因此生成的指标永远保持 pending，等待人工补齐。
 */

import { mustNotInclude } from "./generate";
import type {
  AcceptanceContract,
  ContractFact,
  ContractFormat,
  ContractTableSpec,
  SkillAnalysis,
} from "./types";

const BASE_FORBIDDEN = ["TODO", "待补充", "数据暂缺", "示例数据", "占位", "xxx"];
const FACT_NAME_RE = /(率|量|额|数|占比|金额|成本|人数|笔数|rate|ratio|count|amount|volume|cost)$|^(ROI|GMV|CTR|CVR|CPA|CPS|LTV)$/i;
const FORMATS = new Set<ContractFormat>(["markdown", "html", "json", "text"]);

/** 验收层级只由已确认且非空的业务事实决定。 */
export function verificationLevelOf(facts: ContractFact[]): AcceptanceContract["verification_level"] {
  return facts.some((fact) => fact.status === "confirmed" && fact.value !== null) ? "facts" : "structure";
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function formatOf(value: unknown, fallback: ContractFormat = "text"): ContractFormat {
  return typeof value === "string" && FORMATS.has(value as ContractFormat) ? (value as ContractFormat) : fallback;
}

function inferredFormat(formats: string[]): ContractFormat {
  for (const value of formats) {
    const format = value.toLowerCase();
    if (format === "report" || format === "markdown") return "markdown";
    if (format === "html" || format === "json") return format;
  }
  return "text";
}

function shortHeading(step: string): string {
  return step.replace(/^\d+[.)、．]\s*/, "").split(/[。；;：:]/, 1)[0].trim().slice(0, 40);
}

function outputHeading(field: string): string {
  return field.replace(/[（(][^）)]*[）)]/g, "").replace(/^\s*\d+[.)、．]\s*/, "").trim();
}

function tableColumns(fields: string[]): string[] {
  const labeled = fields
    .flatMap((field) => {
      const columns = field.match(/(?:表格|table)\s*[：:]\s*([^）)]+)/i)?.[1];
      return columns ? columns.split(/[、,，|｜/]/) : [];
    })
    .map((field) => field.trim())
    .filter((field) => field.length > 0 && field.length <= 30);
  const candidates = labeled.length > 0
    ? labeled
    : fields.map((field) => field.trim()).filter((field) => field.length > 0 && field.length <= 30);
  return candidates.slice(0, 8);
}

/** 从 skill 静态信息构建结构级契约，不生成任何业务数值。 */
export function buildContract(
  analysis: SkillAnalysis,
  opts: { format?: ContractFormat } = {},
): AcceptanceContract {
  const inferred = inferredFormat(analysis.formats);
  const format = opts.format ?? inferred;
  const outputFields = analysis.outputFields
    .map(outputHeading)
    .filter((field) => field.length > 0 && field.length <= 40);
  const requiredSections = (outputFields.length > 0
    ? outputFields
    : analysis.steps.map(shortHeading).filter(Boolean)
  ).slice(0, 8);
  const factNames = outputFields
    .flatMap((field) => field.split(/[、,，|｜/：:]/))
    .map((field) => field.trim())
    .filter((field) => FACT_NAME_RE.test(field));
  const facts: ContractFact[] = [...new Set(factNames.map((name) => name.toLowerCase()))]
    .map((key) => factNames.find((name) => name.toLowerCase() === key)!)
    .slice(0, 6)
    .map((name) => ({ name, value: null, tolerance: 0, status: "pending" }));
  const requiredTables: ContractTableSpec[] = analysis.formats.includes("table")
    ? [{ columns: tableColumns(analysis.outputFields) }]
    : [];
  const notes = [
    "关键指标数值需由业务从已确认的 SQL/报表补齐后才会硬判。",
    ...(analysis.deliversFile
      ? ["文件型交付物必须在最终回复中内联完整报告全文，否则评测器拿不到内容无法评分。"]
      : []),
    ...(opts.format === undefined && inferred === "text"
      ? ["该 skill 的交付物是二进制/非文本格式，评测器只能看到最终回复的文本，L1 格式校验不生效，需要 skill 在回复中内联可校验的内容摘要。"]
      : []),
  ].join(" ");

  return {
    format,
    verification_level: "structure",
    required_sections: requiredSections,
    required_tables: requiredTables,
    facts,
    required_statements: [],
    must_include: [],
    must_not_include: [...new Set([...BASE_FORBIDDEN, ...mustNotInclude(analysis)])],
    forbid_external_scripts: format === "html",
    notes,
  };
}

/** 把旧 expectedOutput 安全升级为完整契约；任何异常字段都回退为空值。 */
export function normalizeContract(raw: unknown, fallbackFormat: ContractFormat = "text"): AcceptanceContract {
  const value = recordOf(raw);
  const facts = Array.isArray(value.facts)
    ? value.facts.flatMap((item): ContractFact[] => {
        const fact = recordOf(item);
        if (typeof fact.name !== "string") return [];
        const factValue = typeof fact.value === "number" || typeof fact.value === "string" ? fact.value : null;
        const confirmed = fact.status === "confirmed" && factValue !== null
          && (typeof factValue !== "string" || factValue.trim().length > 0);
        return [{
          name: fact.name,
          value: confirmed ? factValue : null,
          ...(typeof fact.tolerance === "number" ? { tolerance: fact.tolerance } : {}),
          ...(typeof fact.unit === "string" ? { unit: fact.unit } : {}),
          status: confirmed ? "confirmed" : "pending",
        }];
      })
    : [];
  const requiredTables = Array.isArray(value.required_tables)
    ? value.required_tables.map((item) => ({ columns: stringsOf(recordOf(item).columns) }))
    : [];
  const verificationLevel = verificationLevelOf(facts);

  return {
    format: formatOf(value.format, fallbackFormat),
    verification_level: verificationLevel,
    required_sections: stringsOf(value.required_sections ?? value.reference_outline),
    required_tables: requiredTables,
    facts,
    required_statements: stringsOf(value.required_statements),
    must_include: stringsOf(value.must_include),
    must_not_include: stringsOf(value.must_not_include),
    forbid_external_scripts: value.forbid_external_scripts === true,
    notes: typeof value.notes === "string" ? value.notes : "",
  };
}

/** 判断是否已是带契约字段的新形态。 */
export function isContract(raw: unknown): boolean {
  const value = recordOf(raw);
  return FORMATS.has(value.format as ContractFormat)
    && (value.verification_level === "structure" || value.verification_level === "facts")
    && Array.isArray(value.required_sections)
    && Array.isArray(value.required_tables)
    && Array.isArray(value.facts);
}
