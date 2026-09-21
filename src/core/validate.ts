/**
 * 企业级 SKILL 规范校验引擎。
 * 遍历 specRules.ts 中的规则表，产出分级报告（Web 与 CLI 共用）。
 */

import type {
  IssueCategory,
  IssueSeverity,
  ParsedSkill,
  SkillPackage,
  ValidationIssue,
  ValidationReport,
} from "./types";
import { SPEC_RULES } from "./specRules";

const CATEGORIES: IssueCategory[] = [
  "structure",
  "naming",
  "frontmatter",
  "body",
  "io",
  "report",
  "trace",
  "security",
];

const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

function emptyCategoryStats() {
  return Object.fromEntries(
    CATEGORIES.map((c) => [c, { errors: 0, warnings: 0, infos: 0, passed: 0, total: 0 }]),
  ) as ValidationReport["byCategory"];
}

export function validateSkillPackage(pkg: SkillPackage, parsed: ParsedSkill): ValidationReport {
  const issues: ValidationIssue[] = [];
  const passedRules: ValidationReport["passedRules"] = [];
  const byCategory = emptyCategoryStats();

  for (const rule of SPEC_RULES) {
    // 专项规则（如策略报告类）只对适用的 skill 计入总数，避免「自动通过」虚高得分
    if (rule.applies && !rule.applies({ pkg, parsed })) continue;
    byCategory[rule.category].total += 1;
    const hit = rule.check({ pkg, parsed });
    if (!hit) {
      passedRules.push({ ruleId: rule.id, ruleName: rule.name, category: rule.category });
      byCategory[rule.category].passed += 1;
      continue;
    }
    const severity = hit.severity ?? rule.severity;
    issues.push({
      ruleId: rule.id,
      ruleName: rule.name,
      severity,
      category: rule.category,
      message: hit.message,
      hint: rule.fix,
      example: rule.example,
    });
    if (severity === "error") byCategory[rule.category].errors += 1;
    else if (severity === "warning") byCategory[rule.category].warnings += 1;
    else byCategory[rule.category].infos += 1;
  }

  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;

  return {
    issues,
    passedRules,
    summary: {
      errors,
      warnings,
      infos,
      passed: passedRules.length,
      total: CATEGORIES.reduce((n, c) => n + byCategory[c].total, 0),
    },
    score: Math.max(0, 100 - errors * 10 - warnings * 3),
    byCategory,
  };
}

/** 把报告导出成可归档、可贴进 PR 的 Markdown。 */
export function reportToMarkdown(report: ValidationReport, skillName: string): string {
  const labels: Record<IssueCategory, string> = {
    structure: "目录结构",
    naming: "命名规范",
    frontmatter: "frontmatter",
    body: "正文结构",
    io: "输入输出",
    report: "报告类专项",
    trace: "trace 规范",
    security: "安全基线",
  };
  const icon: Record<IssueSeverity, string> = { error: "🔴", warning: "🟡", info: "🔵" };

  const lines = [
    `# SKILL 规范检查报告 — ${skillName}`,
    "",
    `- 综合得分：**${report.score}/100**`,
    `- 通过 ${report.summary.passed}/${report.summary.total} 条规则`,
    `- 错误 ${report.summary.errors} · 警告 ${report.summary.warnings} · 提示 ${report.summary.infos}`,
    "",
  ];

  if (report.issues.length === 0) {
    lines.push("全部规则通过，没有待修项。");
    return lines.join("\n");
  }

  lines.push("## 待修项", "");
  for (const c of CATEGORIES) {
    const list = report.issues.filter((i) => i.category === c);
    if (list.length === 0) continue;
    lines.push(`### ${labels[c]}`, "");
    for (const i of list) {
      lines.push(`- ${icon[i.severity]} **${i.ruleName}** \`${i.ruleId}\``);
      lines.push(`  - 问题：${i.message}`);
      if (i.hint) lines.push(`  - 怎么修：${i.hint}`);
      if (i.example) {
        if (i.example.filename) lines.push(`  - 建议文件：\`${i.example.filename}\``);
        lines.push("", `\`\`\`${i.example.lang}`, i.example.code, "```");
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
