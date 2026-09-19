import type { ParsedSkill, SkillAnalysis } from "./types";

const FORMAT_KEYWORDS: [RegExp, string][] = [
  [/\bpptx?\b|幻灯片|演示文稿|slides?/i, "pptx"],
  [/\bdocx?\b|word 文档/i, "docx"],
  [/\bxlsx?\b|excel|电子表格|spreadsheet/i, "xlsx"],
  [/\bpdf\b/i, "pdf"],
  [/\bjson\b/i, "json"],
  [/\bcsv\b/i, "csv"],
  [/\bhtml\b|网页|web ?page/i, "html"],
  [/markdown|\.md\b/i, "markdown"],
  [/表格|table/i, "table"],
  [/图表|chart|dashboard|仪表盘|可视化/i, "chart"],
  [/代码|\bcodes?\b|脚本|\bscripts?\b/i, "code"],
  [/图片|图像|image|海报|poster/i, "image"],
  [/音频|audio|语音/i, "audio"],
  [/视频|video/i, "video"],
  [/报告|report/i, "report"],
];

const INPUT_PATTERNS: [RegExp, string][] = [
  [/上传|upload|附件|attach/i, "user-uploaded file"],
  [/\.(csv|xlsx?|tsv)\b/i, "tabular data file"],
  [/\.(png|jpe?g|webp|gif)\b/i, "image file"],
  [/\.(md|markdown)\b/i, "markdown document"],
  [/\.pdf\b/i, "PDF document"],
  [/url|链接|website|网页/i, "URL / web page"],
  [/自然语言|natural.?language|用户需求|prompt/i, "natural-language request"],
  [/代码|\bcodes?\b|\brepos(?:itory)?\b|github/i, "source code"],
  [/数据|dataset|数据库|database/i, "dataset"],
];

const CONSTRAINT_RE =
  /\b(must|never|always|do not|don't|ensure|avoid|required|forbidden|shall not|no longer)\b|必须|禁止|不得|不要|务必|严禁|一定|不可/i;

const QUALITY_RE =
  /\b(should|quality|clear|concise|accurate|professional|consistent|readable|helpful|relevant)\b|清晰|准确|完整|简洁|专业|一致|可读|高质量|美观/i;

const TRIGGER_RE =
  /(?:trigger|use when|触发|关键词|keywords?|激活)[:：]?\s*(.+)/i;

/** Extract a structured analysis from a parsed skill. Pure heuristics — no model required. */
export function analyzeSkill(skill: ParsedSkill): SkillAnalysis {
  const text = skill.raw;
  const allBullets = skill.sections.flatMap((s) => s.bullets);
  const allNumbered = skill.sections.flatMap((s) => s.numbered);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const formats = dedupe(
    FORMAT_KEYWORDS.filter(([re]) => re.test(text)).map(([, f]) => f),
  );
  const inputs = dedupe(
    INPUT_PATTERNS.filter(([re]) => re.test(text)).map(([, i]) => i),
  );

  const constraints = dedupe(
    [...allBullets, ...lines.filter((l) => l.startsWith("- ") || l.startsWith("* ")).map((l) => l.slice(2))]
      .map((l) => l.replace(/[*_`]/g, "").trim())
      .filter((l) => CONSTRAINT_RE.test(l) && l.length > 8 && l.length < 300),
  ).slice(0, 12);

  const qualityCriteria = dedupe(
    allBullets
      .map((l) => l.replace(/[*_`]/g, "").trim())
      .filter(
        (l) =>
          QUALITY_RE.test(l) &&
          !CONSTRAINT_RE.test(l) &&
          l.length > 8 &&
          l.length < 240,
      ),
  ).slice(0, 10);

  const steps = dedupe(allNumbered.map((s) => s.replace(/[*_`]/g, "").trim())).slice(0, 12);

  const tools = dedupe(
    (text.match(/`([a-zA-Z0-9_./:-]{2,40})`/g) || [])
      .map((t) => t.slice(1, -1))
      .filter((t) => /[a-z]/i.test(t) && !/\s/.test(t)),
  ).slice(0, 16);

  const triggerKeywords = extractTriggers(skill.description);

  const examples = skill.sections.flatMap((s) =>
    s.codeBlocks.map((c) => ({
      lang: c.lang,
      code: c.code.slice(0, 4000),
      caption: s.heading,
    })),
  );

  const outputSections = skill.sections
    .filter((s) => /output|deliver|format|结构|输出|交付|成果|模板/i.test(s.heading))
    .map((s) => s.heading);

  // the concrete fields/sections the deliverable must contain — bullets under
  // an "output format"-style heading carry far more signal than the heading itself
  const outputFields = dedupe(
    skill.sections
      .filter((s) => /output|deliver|format|结构|输出|交付|成果|模板/i.test(s.heading))
      .flatMap((s) => s.bullets)
      .map((b) => b.replace(/\(.*?\)/g, "").trim())
      .filter((b) => b.length > 2 && b.length < 60),
  ).slice(0, 8);

  const warnings: string[] = [];
  if (!skill.frontmatter.name) warnings.push("frontmatter 缺少 name 字段");
  if (!skill.description) warnings.push("未找到 skill 描述，数据集 input 将更依赖章节推断");
  if (constraints.length === 0) warnings.push("未检测到硬性约束（must/never/必须/禁止），规则评分器将只包含通用检查");
  if (examples.length === 0) warnings.push("未检测到示例代码块，expectedOutput 将以结构骨架代替真实示例");

  return {
    skillName: skill.name,
    displayName: prettifyName(skill.name),
    description: skill.description,
    inputs,
    formats,
    constraints,
    qualityCriteria,
    steps,
    tools,
    triggerKeywords,
    examples,
    outputSections,
    outputFields,
    warnings,
  };
}

function extractTriggers(description: string): string[] {
  const out: string[] = [];
  const m = description.match(TRIGGER_RE);
  if (m) {
    // cut the capture at the end of the sentence and drop a leading "keywords:" label
    const capture = m[1]
      .split(/[.。]/)[0]
      .replace(/^(trigger\s*)?keywords?\s*[:：]?\s*/i, "");
    out.push(
      ...capture
        .split(/[,，、;；"“”']+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 40),
    );
  }
  // quoted phrases in the description are usually trigger phrases
  for (const q of description.matchAll(/[“"']([^“”"']{2,30})[”"']/g)) out.push(q[1]);
  return dedupe(out).slice(0, 10);
}

function prettifyName(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
