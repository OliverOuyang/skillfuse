/**
 * 网页试运行必须与导出的 Python 评测器给出相同结论。
 * 这里逐项镜像 pyContractEngine.ts，只依赖浏览器和 Node 都支持的基础能力。
 */

import type { AcceptanceContract, ContractFact, ContractTableSpec } from "./types";

export interface ContractCheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  comment: string;
}

type Check = [ContractCheckResult["status"], string];

function decodeHtml(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (source, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? source;
    const hex = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : source;
  });
}

function stripHtml(text: string): string {
  return decodeHtml(
    (text || "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<h[1-6]\b[^>]*>/gi, "\n")
      .replace(/<\/h[1-6]\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function detectFormat(text: string): AcceptanceContract["format"] {
  const source = text || "";
  if (/<(html|body)\b[^>]*>[\s\S]*?<\/\1\s*>/i.test(source)) return "html";
  const opened = new Set([...source.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)].map((match) => match[1].toLowerCase()));
  const closed = new Set([...source.matchAll(/<\/([a-z][a-z0-9]*)\s*>/gi)].map((match) => match[1].toLowerCase()));
  if ([...opened].filter((tag) => closed.has(tag)).length >= 2) return "html";
  let candidate = source.trim();
  const fenced = candidate.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    JSON.parse(candidate);
    return "json";
  } catch {
    if (/^#{1,6}\s+\S/m.test(source) || /^\s*\|.+\|\s*$/m.test(source)) return "markdown";
    return "text";
  }
}

function checkFormat(text: string, want: AcceptanceContract["format"]): Check {
  if (want === "text") return ["pass", "文本格式不作限制"];
  const actual = detectFormat(text);
  if (want === "html") {
    return actual === "html" ? ["pass", "检测到完整 HTML"] : ["fail", `需要 HTML，实际检测为 ${actual}`];
  }
  if (want === "markdown") {
    if (actual === "html") return ["fail", "需要 Markdown，但输出为 HTML"];
    return actual === "markdown" ? ["pass", "检测到 Markdown"] : ["fail", `需要 Markdown，实际检测为 ${actual}`];
  }
  if (want === "json") {
    return actual === "json" ? ["pass", "检测到合法 JSON"] : ["fail", `需要 JSON，实际检测为 ${actual}`];
  }
  return ["fail", `不支持的契约格式：${want}`];
}

function htmlHeadings(text: string): string[] {
  return [...(text || "").matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)]
    .map((match) => stripHtml(match[1]).trim());
}

function checkSections(text: string, sections: string[]): Check {
  if (sections.length === 0) return ["pass", "未要求章节"];
  const actual = detectFormat(text);
  const headings = actual === "markdown"
    ? [...(text || "").matchAll(/^#{1,6}\s*(.+?)\s*$/gm)].map((match) => match[1].trim())
    : actual === "html" ? htmlHeadings(text) : [];
  const missing = sections.filter((section) => !headings.some((heading) => heading.toLowerCase().includes(section.toLowerCase())));
  if (missing.length === 0) return ["pass", `章节标题齐全：${sections.length}/${sections.length}`];
  const plain = stripHtml(text).toLowerCase();
  const bodyHits = missing.filter((section) => plain.includes(section.toLowerCase()));
  const trulyMissing = missing.filter((section) => !bodyHits.includes(section));
  if (trulyMissing.length > 0) return ["fail", `缺少章节：${trulyMissing.join("、")}`];
  return ["pass", `章节仅正文命中，未作为标题出现：${bodyHits.join("、")}`];
}

function markdownTables(text: string): string[][] {
  const lines = (text || "").split(/\r?\n/);
  const tables: string[][] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index].trim();
    const separator = lines[index + 1].trim();
    if (header.startsWith("|") && header.endsWith("|") && /^\|?\s*:?-{3,}/.test(separator)) {
      tables.push(header.slice(1, -1).split("|").map((cell) => cell.trim()));
    }
  }
  return tables;
}

function htmlTables(text: string): string[][] {
  return [...(text || "").matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].flatMap((tableMatch) => {
    const rows = [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((rowMatch) =>
      [...rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((cell) => ({
        tag: cell[1].toLowerCase(),
        value: stripHtml(cell[2]).trim(),
      })),
    );
    const ths = rows.flat().filter((cell) => cell.tag === "th").map((cell) => cell.value);
    if (ths.length > 0) return [ths];
    return rows.length > 0 ? [rows[0].map((cell) => cell.value)] : [];
  });
}

function checkTables(text: string, specs: ContractTableSpec[]): Check {
  if (specs.length === 0) return ["pass", "未要求表格"];
  const tables = detectFormat(text) === "html" ? htmlTables(text) : markdownTables(text);
  if (tables.length === 0) return ["fail", "未找到表格"];
  for (const spec of specs) {
    const required = spec.columns ?? [];
    const covered = tables.some((table) =>
      required.every((column) => table.some((cell) => cell.toLowerCase().includes(String(column).toLowerCase()))),
    );
    if (required.length > 0 && !covered) return ["fail", `没有表格覆盖全部必备列：${required.join("、")}`];
  }
  return ["pass", `表格要求通过：${specs.length} 项`];
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const source = String(value).trim().replace(/[０-９．，％－＋]/g, (char) =>
    "0123456789.,%-+"["０１２３４５６７８９．，％－＋".indexOf(char)],
  );
  const match = source.match(/[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|万|亿|[kKmM])?/);
  if (!match) return null;
  let token = match[0].replace(/[,\s]/g, "");
  let multiplier = 1;
  if (token.endsWith("%")) [token, multiplier] = [token.slice(0, -1), 0.01];
  else if (token.endsWith("万")) [token, multiplier] = [token.slice(0, -1), 1e4];
  else if (token.endsWith("亿")) [token, multiplier] = [token.slice(0, -1), 1e8];
  else if (token.slice(-1).toLowerCase() === "k") [token, multiplier] = [token.slice(0, -1), 1e3];
  else if (token.slice(-1).toLowerCase() === "m") [token, multiplier] = [token.slice(0, -1), 1e6];
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function checkFacts(text: string, facts: ContractFact[]): ContractCheckResult[] {
  const results: ContractCheckResult[] = [];
  const plain = stripHtml(text);
  const numberRe = /[-+＋－]?[0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]+)?\s*(?:[%％]|万|亿|[kKmM])?/g;
  for (const fact of facts) {
    const name = String(fact.name ?? "");
    if (fact.status !== "confirmed" || fact.value === null) {
      results.push({ name: `事实:${name}`, status: "skip", comment: "关键数据未核验（待业务补齐）" });
      continue;
    }
    const positions = name ? [...plain.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))].map((match) => match.index) : [];
    if (positions.length === 0) {
      results.push({ name: `事实:${name}`, status: "fail", comment: "未提及该指标" });
      continue;
    }
    const unit = String(fact.unit ?? "");
    const tokens = positions.flatMap((position) => {
      const lineStart = plain.lastIndexOf("\n", position - 1) + 1;
      const foundEnd = plain.indexOf("\n", position);
      const lineEnd = foundEnd < 0 ? plain.length : foundEnd;
      return plain.slice(lineStart, Math.max(lineEnd, position + name.length + 60)).match(numberRe) ?? [];
    });
    const candidates = tokens.map((token) => parseNumber(/[%％万亿kKmM]\s*$/.test(token) || !unit ? token : token + unit));
    const expectedSource = `${fact.value}${unit && !/[%％万亿kKmM]\s*$/.test(String(fact.value)) ? unit : ""}`;
    const expected = parseNumber(expectedSource);
    const tolerance = Math.abs(Number(fact.tolerance ?? 0) || 0);
    const passed = expected !== null && candidates.some((candidate) => candidate !== null && Math.abs(candidate - expected) <= tolerance);
    results.push(passed
      ? { name: `事实:${name}`, status: "pass", comment: "指标值在容忍范围内" }
      : { name: `事实:${name}`, status: "fail", comment: `指标值不符，期望 ${fact.value}±${tolerance}` });
  }
  return results;
}

function checkStatements(text: string, statements: string[]): Check {
  const plain = stripHtml(text).toLowerCase();
  const missing = statements.filter((item) => !plain.includes(String(item).toLowerCase()));
  return missing.length === 0 ? ["pass", "必备表述齐全"] : ["fail", `缺少表述：${missing.join("、")}`];
}

function checkForbidden(text: string, terms: string[]): Check {
  const plain = stripHtml(text).toLowerCase();
  const hits = terms.filter((term) => plain.includes(String(term).toLowerCase()));
  return hits.length === 0 ? ["pass", "未发现禁止内容"] : ["fail", `命中禁止词：${hits.join("、")}`];
}

function checkExternalScripts(text: string): Check {
  const match = (text || "").match(/<(?:script\b[^>]+src|link\b[^>]+href|img\b[^>]+src)\s*=\s*["']?(?:https?:)?\/\//i);
  return match ? ["fail", `发现外部资源：${match[0]}`] : ["pass", "未引用外部资源"];
}

/** 运行与 Python 导出评分器相同的案例契约检查。 */
export function runContract(output: string, contract: AcceptanceContract | null): ContractCheckResult[] {
  if (!contract) return [];
  const results: ContractCheckResult[] = [];
  const add = (name: string, [status, comment]: Check) => results.push({ name, status, comment });
  add("格式", checkFormat(output, contract.format));
  add("章节", checkSections(output, contract.required_sections));
  add("表格", checkTables(output, contract.required_tables));
  add("必须包含", checkStatements(output, contract.must_include));
  add("结论表述", checkStatements(output, contract.required_statements));
  add("禁止内容", checkForbidden(output, contract.must_not_include));
  if (contract.forbid_external_scripts) add("外部资源", checkExternalScripts(output));
  return [...results, ...checkFacts(output, contract.facts)];
}

/** 把失败项转换为可直接执行的中文修改建议。 */
export function contractFixHint(result: ContractCheckResult): string {
  if (result.status !== "fail") return "";
  if (result.name === "格式") return "按契约要求改成交付格式，并确保内容可被对应解析器读取。";
  if (result.name === "章节") return "补齐缺少的章节，并优先使用 Markdown 标题或 HTML h1-h6 标题。";
  if (result.name === "表格") return "补充表格，并在同一张表的表头中覆盖全部必备列。";
  if (result.name === "必须包含" || result.name === "结论表述") return "在交付物正文中补齐缺少的必备表述。";
  if (result.name === "禁止内容") return "删除命中的禁止内容，不要用占位文本代替真实交付物。";
  if (result.name === "外部资源") return "移除外部 script、link 或 img 引用，改为可离线打开的内联资源。";
  if (result.name.startsWith("事实:")) return "使用业务已确认的 SQL、报表或人工基准核对并修正该指标值。";
  return "按失败说明修正交付物后重新检查。";
}
