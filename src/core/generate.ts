import type { Artifacts, DatasetItem, GenerateOptions, RuleCheck, SkillAnalysis } from "./types";

const DAY = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* public entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * 组装评测包。
 * `options` 允许界面把用户改过的规则 / 条目回灌进来——生成物与界面所见始终一致。
 */
export function generateArtifacts(a: SkillAnalysis, options: GenerateOptions = {}): Artifacts {
  const rules = cleanRules(options.rules ?? buildRuleChecks(a));
  const items = options.items ?? buildDatasetItems(a);
  const datasetName = `${a.skillName}-eval`;

  return {
    datasetSchema: JSON.stringify(buildDatasetSchema(a, datasetName), null, 2),
    datasetItems: JSON.stringify(items, null, 2),
    ruleScorersPy: emitRuleScorersPy(a, rules),
    ruleChecksJson: JSON.stringify(rules, null, 2),
    llmJudgePrompt: emitJudgePrompt(a),
    llmJudgePy: emitJudgePy(a),
    langfuseConfigPy: emitLangfuseConfigPy(a, datasetName, items.length),
    envExample: emitEnvExample(),
    packReadme: emitPackReadme(a, rules, items),
  };
}

/* ------------------------------------------------------------------ */
/* dataset                                                             */
/* ------------------------------------------------------------------ */

function buildDatasetSchema(a: SkillAnalysis, datasetName: string) {
  return {
    name: datasetName,
    description: `「${a.skillName}」skill 的评测数据集。由 SkillFuse 于 ${DAY} 生成。`,
    metadata: {
      skill: a.skillName,
      generator: "skillfuse",
      generator_version: "0.2.0",
      task_types: inferTaskTypes(a),
      formats: a.formats,
    },
    item_schema: {
      input: {
        task: "string — 应触发该 skill 的用户请求",
        context: "object — 可选的附件 / 运行约束",
      },
      expectedOutput: {
        must_include: "string[] — 合格输出必须包含的元素",
        must_not_include: "string[] — 合格输出不得包含的元素",
        format: "string — 预期的输出格式",
        reference_outline: "string[] — 预期的章节结构（如适用）",
        notes: "string — 本条目的评分备注",
      },
      metadata: {
        source: "skill-body | skill-example | constraint-adversarial | llm-augmented",
        section: "string — 该条目来源的 skill 章节",
        tags: "string[]",
        difficulty: "basic | intermediate | edge",
      },
    },
    usage: [
      "python: langfuse.create_dataset(name=..., description=..., metadata=...)",
      "然后 langfuse.create_dataset_item(dataset_name=..., input=..., expected_output=..., metadata=...)",
    ],
  };
}

/** 剔除界面上被关掉的规则，并去掉只在界面里用的 enabled 字段。 */
function cleanRules(rules: RuleCheck[]): RuleCheck[] {
  return rules
    .filter((r) => r.enabled !== false)
    .map((r) => {
      const copy: RuleCheck = { ...r };
      delete copy.enabled;
      return copy;
    });
}

export function buildDatasetItems(a: SkillAnalysis): DatasetItem[] {
  const items: DatasetItem[] = [];
  const skillRef = a.description ? a.description.slice(0, 160) : a.displayName;

  // 1. happy-path items from trigger keywords / steps
  const triggers = a.triggerKeywords.length > 0 ? a.triggerKeywords : [a.displayName];
  for (const t of triggers.slice(0, 3)) {
    items.push({
      input: {
        task: synthesizeTask(t, a),
        context: {},
      },
      expectedOutput: {
        must_include: mustInclude(a),
        must_not_include: mustNotInclude(a),
        format: a.formats[0] || "markdown",
        reference_outline: a.outputSections.length > 0 ? a.outputSections : a.steps.slice(0, 5),
        notes: `基于触发词「${t}」生成的常规条目。在依赖精确匹配评分之前，请先补充具体的参考答案。`,
      },
      metadata: {
        source: "skill-body",
        section: "description",
        tags: ["happy-path", a.skillName],
        difficulty: "basic",
      },
    });
  }

  // 2. example-based items from code blocks in the skill
  for (const ex of a.examples.slice(0, 3)) {
    items.push({
      input: {
        task: `请为 skill「${a.skillName}」产出 skill 示例${ex.caption ? `（${ex.caption}）` : ""}所演示的输出。`,
        context: { example_language: ex.lang },
      },
      expectedOutput: {
        must_include: ex.code
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 10)
          .slice(0, 5),
        format: ex.lang || a.formats[0] || "text",
        reference: ex.code.slice(0, 2000),
        notes: "参考答案逐字取自 skill 正文中的代码块。",
      },
      metadata: {
        source: "skill-example",
        section: ex.caption,
        tags: ["example", a.skillName],
        difficulty: "intermediate",
      },
    });
  }

  // 3. constraint-adversarial items
  for (const c of a.constraints.slice(0, 2)) {
    items.push({
      input: {
        task: `${synthesizeTask(triggers[0], a)}（本次运行专门探测约束：「${c}」）`,
        context: { probe_constraint: c },
      },
      expectedOutput: {
        must_not_include: mustNotInclude(a),
        format: a.formats[0] || "markdown",
        notes: `对抗性条目：合格答案必须遵守硬规则「${c}」。`,
      },
      metadata: {
        source: "constraint-adversarial",
        section: "constraints",
        tags: ["constraint", "edge-case", a.skillName],
        difficulty: "edge",
      },
    });
  }

  if (items.length === 0) {
    items.push({
      input: { task: `使用「${a.skillName}」skill：${skillRef}`, context: {} },
      expectedOutput: {
        must_include: mustInclude(a),
        format: a.formats[0] || "markdown",
        notes: "兜底条目——未在该 skill 中检测到触发词、示例或约束。",
      },
      metadata: { source: "skill-body", section: "", tags: [a.skillName], difficulty: "basic" },
    });
  }

  return items.slice(0, 8);
}

function synthesizeTask(trigger: string, a: SkillAnalysis): string {
  const inputHint = a.inputs.length > 0 ? `（输入：${a.inputs[0]}）` : "";
  return `一位用户提出请求${inputHint}：「${trigger}」。请端到端执行「${a.skillName}」skill，产出其预期交付物。`;
}

function mustInclude(a: SkillAnalysis): string[] {
  const out: string[] = [];
  if (a.outputFields.length > 0) out.push(...a.outputFields.slice(0, 4));
  else if (a.outputSections.length > 0) out.push(...a.outputSections.slice(0, 4));
  else if (a.steps.length > 0) out.push(...a.steps.slice(0, 3).map((s) => s.slice(0, 60)));
  if (a.formats.includes("table")) out.push("一个表格");
  if (a.formats.includes("code")) out.push("一个代码块");
  return out;
}

function mustNotInclude(a: SkillAnalysis): string[] {
  const out: string[] = [];
  for (const c of a.constraints) {
    const quoted = [...c.matchAll(/["'“”`]([^"'“”`]{2,60})["'“”`]/g)].map((m) => m[1]);
    if (/never|禁止|不得|不要|avoid|forbidden/i.test(c)) out.push(...quoted.slice(0, 2));
  }
  return [...new Set(out)].slice(0, 6);
}

function inferTaskTypes(a: SkillAnalysis): string[] {
  const t: string[] = [];
  if (a.formats.some((f) => ["pptx", "docx", "xlsx", "pdf", "html", "image"].includes(f))) t.push("artifact-generation");
  if (a.formats.includes("code")) t.push("code-generation");
  if (a.formats.some((f) => ["report", "markdown", "chart"].includes(f))) t.push("writing-and-analysis");
  if (a.tools.length > 3) t.push("tool-use");
  return t.length > 0 ? t : ["general"];
}

/* ------------------------------------------------------------------ */
/* rule checks                                                         */
/* ------------------------------------------------------------------ */

/** 交付物是策略 / 分析报告——这类 skill 需要额外检查结论的可追溯性。 */
export function isReportDeliverable(a: SkillAnalysis): boolean {
  if (a.formats.includes("report")) return true;
  return /报告|策略|分析|洞察|复盘|诊断|report|analysis|insight|strategy/i.test(
    `${a.description} ${a.displayName} ${a.outputSections.join(" ")}`,
  );
}

export function buildRuleChecks(a: SkillAnalysis): RuleCheck[] {
  const rules: RuleCheck[] = [
    {
      id: "non_empty",
      name: "输出非空",
      description: "模型给出了有实质内容的回答。",
      kind: "non_empty",
      params: {},
      weight: 1,
      source: "通用规则",
    },
    {
      id: "min_length",
      name: "最小长度",
      description: "回答长度足以合理完成该 skill。",
      kind: "min_length",
      params: { min: a.formats.some((f) => ["report", "pptx", "docx"].includes(f)) ? 300 : 120 },
      weight: 1,
      source: "格式推断",
    },
  ];

  if (a.formats.includes("json")) {
    rules.push({
      id: "valid_json",
      name: "合法 JSON",
      description: "输出可被解析为 JSON（该 skill 声明了 JSON 输出）。",
      kind: "valid_json",
      params: {},
      weight: 2,
      source: "声明格式：json",
    });
  }
  if (a.formats.includes("markdown") || a.formats.includes("report")) {
    rules.push({
      id: "has_heading",
      name: "包含标题结构",
      description: "Markdown 输出中至少包含一个标题。",
      kind: "has_heading",
      params: {},
      weight: 1,
      source: "声明格式：markdown/report",
    });
  }
  if (a.formats.includes("table")) {
    rules.push({
      id: "has_table",
      name: "包含表格",
      description: "输出中包含 Markdown 表格。",
      kind: "has_table",
      params: {},
      weight: 1,
      source: "声明格式：table",
    });
  }
  if (a.formats.includes("code")) {
    rules.push({
      id: "has_code_block",
      name: "包含代码块",
      description: "输出中至少包含一个围栏代码块。",
      kind: "has_code_block",
      params: {},
      weight: 2,
      source: "声明格式：code",
    });
  }

  // banned terms from never-constraints
  const banned = mustNotInclude(a);
  if (banned.length > 0) {
    rules.push({
      id: "no_banned_terms",
      name: "遵守硬约束",
      description: `输出不得包含：${banned.join("、")}。`,
      kind: "not_contains",
      params: { terms: banned },
      weight: 3,
      source: "skill 硬约束（never / 禁止）",
    });
  }

  // emoji ban is common in skills
  if (a.constraints.some((c) => /emoji/i.test(c) && /never|禁止|不得|不要|avoid|no /i.test(c))) {
    rules.push({
      id: "no_emoji",
      name: "不含 emoji",
      description: "该 skill 禁止在交付物中使用 emoji。",
      kind: "no_emoji",
      params: {},
      weight: 2,
      source: "skill 约束：禁止 emoji",
    });
  }

  // 策略 / 分析报告类交付物：检查的是结论能不能被追溯，而不只是格式
  if (isReportDeliverable(a)) {
    rules.push(
      {
        id: "report_conclusion_first",
        name: "结论先行",
        description: "开头就给出结论 / 摘要，而不是先铺陈过程。",
        kind: "contains_any",
        params: { terms: ["结论", "摘要", "核心发现", "TL;DR", "Executive Summary", "一句话"], min_match: 1 },
        weight: 2,
        source: "报告类专项",
      },
      {
        id: "report_evidence",
        name: "结论带数据出处",
        description: "结论标注了数据来源 / 口径，可被追溯核对。",
        kind: "contains_any",
        params: { terms: ["数据来源", "口径", "来源", "取数", "样本", "统计自"], min_match: 1 },
        weight: 3,
        source: "报告类专项",
      },
      {
        id: "report_time_window",
        name: "声明时间范围",
        description: "写清统计时间范围或对比基准（同比 / 环比 / 截至）。",
        kind: "contains_any",
        params: { terms: ["时间范围", "统计周期", "同比", "环比", "截至", "至今", "近 7 天", "近 30 天"], min_match: 1 },
        weight: 2,
        source: "报告类专项",
      },
      {
        id: "report_recommendation",
        name: "给出可执行建议",
        description: "包含「建议 / 下一步 / 行动项」，不是只描述现象。",
        kind: "contains_any",
        params: { terms: ["建议", "下一步", "行动项", "落地", "优化方向"], min_match: 1 },
        weight: 3,
        source: "报告类专项",
      },
      {
        id: "report_no_empty_talk",
        name: "不说正确的废话",
        description: "不出现「持续关注 / 有待观察」这类没有动作的空泛结论。",
        kind: "not_contains",
        params: { terms: ["持续关注", "有待观察", "进一步观察", "仅供参考", "众所周知"] },
        weight: 2,
        source: "报告类专项",
      },
    );
  }

  // required sections — prefer concrete output fields over section headings
  const required = (a.outputFields.length > 0 ? a.outputFields : a.outputSections).slice(0, 5);
  if (required.length > 0) {
    rules.push({
      id: "required_sections",
      name: "必备章节齐全",
      description: `输出应覆盖：${required.join(" / ")}。`,
      kind: "contains_any",
      params: { terms: required, min_match: Math.max(1, Math.ceil(required.length / 2)) },
      weight: 2,
      source: "skill 输出结构章节",
    });
  }

  return rules;
}

/* ------------------------------------------------------------------ */
/* python emitters                                                     */
/* ------------------------------------------------------------------ */

function emitRuleScorersPy(a: SkillAnalysis, rules: RuleCheck[]): string {
  return `"""「${a.skillName}」skill 的确定性规则评分器。

由 SkillFuse 于 ${DAY} 生成。零外部依赖——无论是否安装 Langfuse SDK 都能运行。
每个评分器返回 (name, value, comment)，value 为 1.0（通过）或 0.0（未通过）；
使用 run_all 可获得加权总分。
"""

import json
import re

RULES = json.loads(r'''${JSON.stringify(rules).replace(/'/g, "\\u0027")}''')

WEIGHT_TOTAL = sum(r.get("weight", 1) for r in RULES) or 1


def _wlen(text: str) -> int:
    """加权长度：CJK 字符的信息密度约为拉丁字符的两倍。"""
    return sum(
        2 if ("一" <= c <= "鿿" or "㐀" <= c <= "䶿" or "\u3000" <= c <= "〿" or "＀" <= c <= "￯") else 1
        for c in re.sub(r"\\s", "", text)
    )


def _check(rule, output: str) -> tuple[bool, str]:
    kind = rule["kind"]
    p = rule.get("params", {})
    text = output or ""

    if kind == "non_empty":
        ok = len(text.strip()) > 0
        return ok, "输出非空" if ok else "输出为空"
    if kind == "min_length":
        n = p.get("min", 100)
        ln = _wlen(text)
        ok = ln >= n
        return ok, f"长度 {ln} ≥ {n}" if ok else f"过短：{ln}（< {n}）"
    if kind == "max_length":
        n = p.get("max", 20000)
        ln = _wlen(text)
        ok = ln <= n
        return ok, f"长度 {ln} ≤ {n}" if ok else f"过长：{ln}（> {n}）"
    if kind == "valid_json":
        candidate = text.strip()
        m = re.search(r"\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`", candidate)
        if m:
            candidate = m.group(1).strip()
        try:
            json.loads(candidate)
            return True, "输出可解析为 JSON"
        except Exception as exc:
            return False, f"非法 JSON：{exc}"
    if kind == "has_heading":
        ok = re.search(r"^#{1,6}\\s+\\S", text, re.M) is not None
        return ok, "找到 Markdown 标题" if ok else "未找到 Markdown 标题"
    if kind == "has_table":
        ok = re.search(r"^\\s*\\|.+\\|\\s*$", text, re.M) is not None
        return ok, "找到 Markdown 表格" if ok else "未找到 Markdown 表格"
    if kind == "has_code_block":
        ok = "\`\`\`" in text
        return ok, "找到围栏代码块" if ok else "未找到围栏代码块"
    if kind == "no_emoji":
        m = re.search("[\\U0001F300-\\U0001FAFF\\u2600-\\u27BF\\uFE0F\\u200D]", text)
        return m is None, "未发现 emoji" if m is None else f"发现 emoji：{m.group(0)}"
    if kind == "contains_any":
        terms = p.get("terms", [])
        flags = p.get("flags", "")
        if "regex" in p:
            ok = re.search(p["regex"], text, re.U if "u" in flags else 0) is None
            return ok, "违禁模式未出现" if ok else f"发现违禁模式：{p['regex']}"
        hits = [t for t in terms if t.lower() in text.lower()]
        need = p.get("min_match", len(terms))
        ok = len(hits) >= need
        return ok, f"命中 {len(hits)}/{need}：{hits}"
    if kind == "contains_all":
        terms = p.get("terms", [])
        missing = [t for t in terms if t.lower() not in text.lower()]
        return not missing, "所有必备项均已包含" if not missing else f"缺少：{missing}"
    if kind == "not_contains":
        if "regex" in p:
            m = re.search(p["regex"], text, re.U if "u" in p.get("flags", "") else 0)
            return m is None, "违禁模式未出现" if m is None else f"发现违禁内容：{m.group(0)!r}"
        terms = p.get("terms", [])
        hits = [t for t in terms if t.lower() in text.lower()]
        return not hits, "未发现违禁词" if not hits else f"发现违禁词：{hits}"
    return True, f"未知规则类型 {kind!r}（已跳过）"


def score(output: str) -> list[tuple[str, float, str]]:
    """运行所有规则；返回 (rule_id, value, comment) 列表。"""
    results = []
    for rule in RULES:
        ok, comment = _check(rule, output)
        results.append((rule["id"], 1.0 if ok else 0.0, comment))
    return results


def run_all(output: str) -> tuple[str, float, str]:
    """加权总分，取值 [0, 1]，可直接用于 langfuse.score(...)。"""
    results = score(output)
    total = sum(r.get("weight", 1) for r, (_, v, _) in zip(RULES, results)) or 1
    value = sum(v * r.get("weight", 1) for r, (_, v, _) in zip(RULES, results)) / total
    failed = [rid for rid, v, _ in results if v == 0.0]
    comment = "全部规则通过" if not failed else "未通过：" + ", ".join(failed)
    return "rule_checks", round(value, 4), comment


if __name__ == "__main__":
    import sys
    sample = sys.stdin.read() if not sys.stdin.isatty() else ""
    name, value, comment = run_all(sample)
    print(f"{name}: {value:.2f} — {comment}")
`;
}

function emitJudgePrompt(a: SkillAnalysis): string {
  const criteria =
    a.qualityCriteria.length > 0
      ? a.qualityCriteria.map((c) => `- ${c}`).join("\n")
      : "- 回答完整实现了 skill 声明的目标\n- 回答准确、清晰、结构良好";
  const constraints =
    a.constraints.length > 0
      ? a.constraints.map((c) => `- ${c}`).join("\n")
      : "-（未在该 skill 中检测到硬约束。）";

  return `# LLM-as-a-Judge — ${a.displayName}

你正在为一个执行了 skill **${a.skillName}** 的 AI 助手的输出打分。

## 被测 skill

> ${a.description || "（未提供描述）"}

## 评分细则（每项 1–5 分）

1. **任务完成度** — 输出是否真正交付了 skill 承诺的成果？
2. **指令遵循度** — 是否遵循了 skill 的工作流程和硬性规则？
3. **质量标准** — 从 skill 正文中提取：
${criteria}
4. **格式合规性** — 预期格式：${a.formats.join(", ") || "自由文本"}。

## 硬约束（违反任意一条，总分上限为 1 分）

${constraints}

## 输入

\`\`\`
{{input}}
\`\`\`

## 待评分的输出

\`\`\`
{{output}}
\`\`\`

## 判定格式

只回复 **JSON**：

\`\`\`json
{
  "task_completion": 1-5,
  "instruction_adherence": 1-5,
  "quality": 1-5,
  "format_compliance": 1-5,
  "constraint_violation": true | false,
  "reasoning": "2-3 句话",
  "score": 0.0-1.0
}
\`\`\`

\`score\` = 四项 1–5 分的均值，归一化到 0–1；如果 \`constraint_violation\` 为 true，\`score\` 必须 ≤ 0.2。
`;
}

function emitJudgePy(a: SkillAnalysis): string {
  return `"""「${a.skillName}」skill 的 LLM-as-a-judge 评分器（兼容 Langfuse）。

由 SkillFuse 于 ${DAY} 生成。
依赖：pip install openai langfuse
通过环境变量配置评审模型（见 .env.example）：支持任意 OpenAI 兼容端点——
包括你自己的模型。
"""

import json
import os
import re

from openai import BadRequestError, OpenAI

JUDGE_PROMPT = open(os.path.join(os.path.dirname(__file__), "llm_judge_prompt.md"), encoding="utf-8").read()

client = OpenAI(
    base_url=os.environ.get("JUDGE_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or None,
    api_key=os.environ.get("JUDGE_API_KEY") or os.environ.get("OPENAI_API_KEY"),
)
MODEL = os.environ.get("JUDGE_MODEL", "gpt-4o-mini")


def _complete(prompt: str):
    kwargs = {"model": MODEL, "messages": [{"role": "user", "content": prompt}], "temperature": 0}
    try:
        return client.chat.completions.create(**kwargs)
    except BadRequestError as exc:
        # 部分推理型模型（如 kimi-for-coding）只接受默认温度，去掉该参数重试一次
        if "temperature" not in str(exc).lower():
            raise
        kwargs.pop("temperature")
        return client.chat.completions.create(**kwargs)


def judge(input_text: str, output_text: str) -> tuple[str, float, str]:
    """返回 (name, value, comment) — value 取值 [0, 1]，可直接用于 langfuse.score(...)。"""
    prompt = JUDGE_PROMPT.replace("{{input}}", input_text or "").replace("{{output}}", output_text or "")
    resp = _complete(prompt)
    raw = resp.choices[0].message.content or ""
    m = re.search(r"\\{[\\s\\S]*\\}", raw)
    try:
        data = json.loads(m.group(0) if m else raw)
        value = max(0.0, min(1.0, float(data.get("score", 0))))
        return "llm_judge", round(value, 4), str(data.get("reasoning", ""))[:500]
    except Exception as exc:
        return "llm_judge", 0.0, f"评审结果解析失败：{exc}; raw={raw[:200]}"


if __name__ == "__main__":
    import sys
    name, value, comment = judge(sys.argv[1] if len(sys.argv) > 1 else "", sys.stdin.read())
    print(f"{name}: {value:.2f} — {comment}")
`;
}

function emitLangfuseConfigPy(a: SkillAnalysis, datasetName: string, itemCount: number): string {
  return `"""「${a.skillName}」skill 的 Langfuse 一键配置脚本。

由 SkillFuse 于 ${DAY} 生成。

用法：
    pip install langfuse openai
    cp .env.example .env   # 填入你的密钥
    python langfuse_config.py            # 创建数据集并上传条目
    python langfuse_config.py --eval     # （骨架）运行你的 skill 并对输出评分

数据集：${datasetName}（${itemCount} 个条目）
"""

import json
import os
import sys

from dotenv import load_dotenv  # pip install python-dotenv

load_dotenv()

from langfuse import Langfuse

langfuse = Langfuse(
    public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
    secret_key=os.environ["LANGFUSE_SECRET_KEY"],
    host=os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com"),
)

DATASET_NAME = "${datasetName}"
HERE = os.path.dirname(os.path.abspath(__file__))


def create_dataset() -> None:
    schema = json.load(open(os.path.join(HERE, "dataset_schema.json"), encoding="utf-8"))
    items = json.load(open(os.path.join(HERE, "dataset_items.json"), encoding="utf-8"))

    langfuse.create_dataset(
        name=DATASET_NAME,
        description=schema["description"],
        metadata=schema["metadata"],
    )
    for item in items:
        langfuse.create_dataset_item(
            dataset_name=DATASET_NAME,
            input=item["input"],
            expected_output=item.get("expectedOutput"),
            metadata=item.get("metadata", {}),
        )
    print(f"数据集 '{DATASET_NAME}' 已创建，共 {len(items)} 个条目")


def run_evaluation(run_name: str = "skillfuse-run") -> None:
    """骨架：接入你自己的 skill 运行器，然后由规则评分器 + LLM 评审对每个输出打分。"""
    from rule_scorers import run_all as rule_score
    from llm_judge import judge

    dataset = langfuse.get_dataset(DATASET_NAME)
    for item in dataset.items:
        with item.observe(run_name=run_name) as trace_id:
            # TODO：替换为真正执行你的 skill 的调用，处理 item.input
            output = "YOUR_SKILL_OUTPUT_HERE"

            name, value, comment = rule_score(output)
            langfuse.score(trace_id=trace_id, name=name, value=value, comment=comment)

            jname, jvalue, jcomment = judge(json.dumps(item.input, ensure_ascii=False), output)
            langfuse.score(trace_id=trace_id, name=jname, value=jvalue, comment=jcomment)

    langfuse.flush()
    print(f"评测运行 '{run_name}' 已完成——打开 Langfuse 查看分数")


if __name__ == "__main__":
    if "--eval" in sys.argv:
        run_evaluation()
    else:
        create_dataset()
`;
}

function emitEnvExample(): string {
  return `# --- Langfuse（必填）---
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com

# --- 评审模型（可选，任意 OpenAI 兼容端点 / 你自己的模型）---
JUDGE_BASE_URL=https://api.openai.com/v1
JUDGE_API_KEY=sk-...
JUDGE_MODEL=gpt-4o-mini
`;
}

function emitPackReadme(a: SkillAnalysis, rules: RuleCheck[], items: DatasetItem[]): string {
  return `# ${a.skillName}-eval — Langfuse 评测包

由 **SkillFuse** 于 ${DAY} 从该 skill 的 \`SKILL.md\` 生成。

## 内容清单

| 文件 | 作用 |
| --- | --- |
| \`dataset_schema.json\` | 兼容 Langfuse 的数据集定义（schema + 元数据） |
| \`dataset_items.json\` | ${items.length} 个数据集条目（常规路径、示例参考、约束对抗三类） |
| \`rule_scorers.py\` | ${rules.length} 个确定性评分器，零依赖，含加权总分 |
| \`rule_checks.json\` | 同一套规则的数据形态——驱动 SkillFuse 浏览器内试运行 |
| \`llm_judge_prompt.md\` | 从 skill 质量标准提取的 LLM-as-a-judge 评分细则 |
| \`llm_judge.py\` | 评审评分器，支持任意 OpenAI 兼容端点 |
| \`langfuse_config.py\` | 一键创建数据集 + 评测运行骨架 |
| \`.env.example\` | 环境变量模板 |

## 快速上手

\`\`\`bash
pip install langfuse openai python-dotenv
cp .env.example .env   # 填入 Langfuse 密钥（用到评审模型时也填 JUDGE_*）
python langfuse_config.py
\`\`\`

## 说明

- 标记为 \`"source": "skill-body"\` 的条目含有模板化的 \`expectedOutput\`——
  在依赖精确匹配评分之前，请先替换为具体的参考答案。
- 规则评分器是确定性的、零成本；LLM 评审为可选项，仅在设置了
  \`JUDGE_API_KEY\` 时运行。
`;
}
