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

/** CJK 字符的信息密度约为拉丁字符的两倍，长度类规则按加权长度度量。 */
function weightedLength(text: string): number {
  let n = 0;
  for (const c of text.replace(/\s/g, "")) {
    n += /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(c) ? 2 : 1;
  }
  return n;
}

function check(rule: RuleCheck, text: string): [boolean, string] {
  const p = rule.params as Record<string, unknown>;
  switch (rule.kind) {
    case "non_empty":
      return text.trim().length > 0 ? [true, "输出非空"] : [false, "输出为空"];
    case "min_length": {
      const min = Number(p.min ?? 100);
      const len = weightedLength(text);
      return len >= min ? [true, `长度 ${len} ≥ ${min}`] : [false, `过短：${len}（< ${min}）`];
    }
    case "max_length": {
      const max = Number(p.max ?? 20000);
      const len = weightedLength(text);
      return len <= max ? [true, `长度 ${len} ≤ ${max}`] : [false, `过长：${len}（> ${max}）`];
    }
    case "valid_json": {
      let candidate = text.trim();
      const m = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) candidate = m[1].trim();
      try {
        JSON.parse(candidate);
        return [true, "输出可解析为 JSON"];
      } catch (e) {
        return [false, `非法 JSON：${(e as Error).message}`];
      }
    }
    case "has_heading":
      return /^#{1,6}\s+\S/m.test(text) ? [true, "找到 Markdown 标题"] : [false, "未找到 Markdown 标题"];
    case "has_table":
      return /^\s*\|.+\|\s*$/m.test(text) ? [true, "找到 Markdown 表格"] : [false, "未找到 Markdown 表格"];
    case "has_code_block":
      return text.includes("```") ? [true, "找到围栏代码块"] : [false, "未找到围栏代码块"];
    case "no_emoji": {
      const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;
      const m = text.match(re);
      return m ? [false, `发现 emoji：${m[0]}`] : [true, "未发现 emoji"];
    }
    case "contains_any": {
      const terms = (p.terms as string[]) ?? [];
      const hits = terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
      const need = Number(p.min_match ?? terms.length);
      return hits.length >= need
        ? [true, `命中 ${hits.length}/${need}：${hits.join("、")}`]
        : [false, `命中 ${hits.length}/${need}：${hits.join("、") || "无"}`];
    }
    case "contains_all": {
      const terms = (p.terms as string[]) ?? [];
      const missing = terms.filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
      return missing.length === 0 ? [true, "所有必备项均已包含"] : [false, `缺少：${missing.join("、")}`];
    }
    case "not_contains": {
      if (typeof p.regex === "string") {
        try {
          const re = new RegExp(p.regex, String(p.flags ?? ""));
          const m = text.match(re);
          return m ? [false, `发现违禁内容：${JSON.stringify(m[0])}`] : [true, "未发现违禁内容"];
        } catch {
          return [true, "正则无效（已跳过）"];
        }
      }
      const terms = (p.terms as string[]) ?? [];
      const hits = terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
      return hits.length === 0 ? [true, "未发现违禁词"] : [false, `发现违禁词：${hits.join("、")}`];
    }
    default:
      return [true, `未知规则类型 ${rule.kind}（已跳过）`];
  }
}
