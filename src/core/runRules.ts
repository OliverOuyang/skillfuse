import type { RuleCheck, RuleResult } from "./types";

/** In-browser mirror of rule_scorers.py — interprets rule_checks.json against a sample output. */
export function runRuleChecks(rules: RuleCheck[], output: string): RuleResult[] {
  return rules.map((rule) => {
    const [passed, comment] = check(rule, output ?? "");
    return { id: rule.id, name: rule.name, passed, score: passed ? 1 : 0, comment, weight: rule.weight };
  });
}

/** 某条规则没过时，给一句「怎么改」——试运行页直接展示。 */
export function ruleFixHint(rule: RuleCheck): string {
  const p = rule.params ?? {};
  switch (rule.kind) {
    case "non_empty":
      return "输出为空，先确认 skill 真的产出了内容。";
    case "min_length":
      return `把内容补到加权长度 ${Number(p.min ?? 100)} 以上（中日韩字符按 2 计）。若该 skill 本就产出简短结果，可在生成页调低这条规则的阈值。`;
    case "max_length":
      return `精简到加权长度 ${Number(p.max ?? 20000)} 以内，或在生成页放宽阈值。`;
    case "valid_json":
      return "输出必须是可解析的 JSON（可以包在 ```json 代码块里）。检查是否混入了解释性文字。";
    case "has_heading":
      return "用 Markdown 标题（# / ## …）划分结构。";
    case "has_table":
      return "补一个 Markdown 表格（| 列 | 列 | 形式）。";
    case "has_code_block":
      return "用 ``` 围栏代码块给出代码。";
    case "no_emoji":
      return "删掉交付物里的 emoji——这是该 skill 的硬约束。";
    case "contains_any":
      return `至少覆盖其中 ${Number(p.min_match ?? 1)} 项：${((p.terms as string[]) ?? []).join("、")}。若是同义表述没被识别，可在生成页把实际用词加进关键词。`;
    case "contains_all":
      return `补齐缺失项：${((p.terms as string[]) ?? []).join("、")}。`;
    case "not_contains":
      return "输出命中了 skill 明令禁止的内容，需要删除或改写。";
    default:
      return "";
  }
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
      // 分支写法而非字符类：ZWJ / 变体选择符属于组合字符，放进字符类会被静态检查判为易错写法
      const re = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|\u{FE0F}|\u{200D}/u;
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
