/**
 * 企业级 SKILL 规范校验引擎。
 * 遍历 specRules.ts 中的规则表，产出分级报告（Web 与 CLI 共用）。
 */

import type { ParsedSkill, SkillPackage, ValidationIssue, ValidationReport } from "./types";
import { SPEC_RULES } from "./specRules";

export function validateSkillPackage(pkg: SkillPackage, parsed: ParsedSkill): ValidationReport {
  const issues: ValidationIssue[] = [];
  let passed = 0;

  for (const rule of SPEC_RULES) {
    const hit = rule.check({ pkg, parsed });
    if (!hit) {
      passed += 1;
      continue;
    }
    issues.push({
      ruleId: rule.id,
      severity: hit.severity ?? rule.severity,
      category: rule.category,
      message: hit.message,
    });
  }

  issues.sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;

  return {
    issues,
    summary: { errors, warnings, infos, passed },
    score: Math.max(0, 100 - errors * 10 - warnings * 3),
  };
}
