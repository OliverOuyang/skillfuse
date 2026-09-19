import type { RuleCheck, RuleResult } from "./types";

/** In-browser mirror of rule_scorers.py — interprets rule_checks.json against a sample output. */
export function runRuleChecks(rules: RuleCheck[], output: string): RuleResult[] {
  return rules.map((rule) => {
    const [passed, comment] = check(rule, output ?? "");
    return { id: rule.id, name: rule.name, passed, score: passed ? 1 : 0, comment, weight: rule.weight };
  });
}

export function aggregate(results: RuleResult[]): number {
  const total = results.reduce((s, r) => s + r.weight, 0) || 1;
  return results.reduce((s, r) => s + r.score * r.weight, 0) / total;
}

function check(rule: RuleCheck, text: string): [boolean, string] {
  const p = rule.params as Record<string, unknown>;
  switch (rule.kind) {
    case "non_empty":
      return text.trim().length > 0 ? [true, "output is non-empty"] : [false, "output is empty"];
    case "min_length": {
      const min = Number(p.min ?? 100);
      const ok = text.trim().length >= min;
      return ok ? [true, `length ${text.trim().length} >= ${min}`] : [false, `too short: ${text.trim().length} chars (< ${min})`];
    }
    case "max_length": {
      const max = Number(p.max ?? 20000);
      return text.length <= max ? [true, `length ${text.length} <= ${max}`] : [false, `too long: ${text.length} chars (> ${max})`];
    }
    case "valid_json": {
      let candidate = text.trim();
      const m = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) candidate = m[1].trim();
      try {
        JSON.parse(candidate);
        return [true, "output parses as JSON"];
      } catch (e) {
        return [false, `invalid JSON: ${(e as Error).message}`];
      }
    }
    case "has_heading":
      return /^#{1,6}\s+\S/m.test(text) ? [true, "found markdown heading"] : [false, "no markdown heading found"];
    case "has_table":
      return /^\s*\|.+\|\s*$/m.test(text) ? [true, "found markdown table"] : [false, "no markdown table found"];
    case "has_code_block":
      return text.includes("```") ? [true, "found fenced code block"] : [false, "no fenced code block found"];
    case "no_emoji": {
      const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;
      const m = text.match(re);
      return m ? [false, `emoji found: ${m[0]}`] : [true, "no emoji found"];
    }
    case "contains_any": {
      const terms = (p.terms as string[]) ?? [];
      const hits = terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
      const need = Number(p.min_match ?? terms.length);
      return hits.length >= need
        ? [true, `matched ${hits.length}/${need}: ${hits.join(", ")}`]
        : [false, `matched ${hits.length}/${need}: ${hits.join(", ") || "none"}`];
    }
    case "contains_all": {
      const terms = (p.terms as string[]) ?? [];
      const missing = terms.filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
      return missing.length === 0 ? [true, "all terms present"] : [false, `missing: ${missing.join(", ")}`];
    }
    case "not_contains": {
      if (typeof p.regex === "string") {
        try {
          const re = new RegExp(p.regex, String(p.flags ?? ""));
          const m = text.match(re);
          return m ? [false, `found forbidden pattern: ${JSON.stringify(m[0])}`] : [true, "forbidden pattern absent"];
        } catch {
          return [true, "invalid regex (skipped)"];
        }
      }
      const terms = (p.terms as string[]) ?? [];
      const hits = terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
      return hits.length === 0 ? [true, "no banned terms found"] : [false, `banned terms found: ${hits.join(", ")}`];
    }
    default:
      return [true, `unknown rule kind ${rule.kind} (skipped)`];
  }
}
