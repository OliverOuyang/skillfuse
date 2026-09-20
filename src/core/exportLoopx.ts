/**
 * 导出「SH-LoopX 评测助手」可消化的案例包。
 *
 * 助手侧只认一种业务 JSON：`task` / `constraints` / `expected_result`，
 * 且只产出单一布尔指标 `task_completed`。本模块负责两件事：
 *   L1 `toLoopxCases`        —— dataset_items → 助手业务 JSON（有答案 / 无答案分流）
 *   L2 `emitLoopxEvaluatorPy` —— rule_checks  → 助手侧 custom code evaluator
 *
 * 导出产物只用于「粘贴给评测助手 → preview → 人工确认」，本模块不写任何远端数据。
 */

import { PY_RULE_ENGINE } from "./pyRuleEngine";
import type { DatasetItem, RuleCheck } from "./types";

/**
 * 助手业务 JSON。字段是封闭的——`normalize_evaluation_materials` 只认
 * `task` / `constraints` / `expected_result`，多一个键（例如 metadata）会直接报错，
 * 所以 SkillFuse 的条目 metadata 只能放进旁挂的 manifest，不能混进案例本体。
 */
export interface LoopxCase {
  task: string;
  constraints?: string;
  expected_result: unknown;
}

/** 案例的旁挂信息：留痕用，不提交给助手。 */
export interface LoopxManifestEntry {
  /** 在 dataset_items 里的下标 */
  index: number;
  kind: "case" | "structural";
  task: string;
  metadata: Record<string, unknown>;
  /** 结构判定案例：为什么没进正式案例 */
  reason?: string;
}

export interface LoopxExport {
  /** 正式案例：答案已由业务确认 */
  cases: LoopxCase[];
  /** 结构判定案例：还没有标准答案，只能由 Layer 2 评分器判结构 */
  structuralOnly: LoopxCase[];
  manifest: LoopxManifestEntry[];
  /** 完全不可用的条目（缺 task） */
  skipped: { index: number; reason: string }[];
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `{"columns": [...], "rows": [[...]]}` 形态即 SQL 取数类答案，助手按表格比较。 */
function isTableAnswer(v: unknown): boolean {
  const r = asRecord(v);
  return Array.isArray(r.columns) && Array.isArray(r.rows);
}

/** 字符串答案若本身是合法 JSON 表格/对象，按结构化答案提交，否则按纯文本答案。 */
function normalizeAnswer(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return isTableAnswer(raw) ? raw : { answer: raw };
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return isTableAnswer(parsed) ? parsed : { answer: parsed };
    } catch {
      /* 不是 JSON 就按纯文本处理 */
    }
  }
  return { answer: text };
}

/** input.context 里的非空约束序列化为一句话，交给助手作为 constraints。 */
function toConstraints(context: unknown): string | undefined {
  const ctx = asRecord(context);
  const parts = Object.entries(ctx)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}：${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length > 0 ? parts.join("；") : undefined;
}

/**
 * dataset_items → 评测助手案例包。
 * 已补标准答案的进 `cases`；仅有结构要求（must_include / format）的进 `structuralOnly`。
 */
export function toLoopxCases(items: DatasetItem[]): LoopxExport {
  const cases: LoopxCase[] = [];
  const structuralOnly: LoopxCase[] = [];
  const manifest: LoopxManifestEntry[] = [];
  const skipped: { index: number; reason: string }[] = [];

  items.forEach((item, index) => {
    const input = asRecord(item.input);
    const task = String(input.task ?? "").trim();
    if (!task) {
      skipped.push({ index, reason: "缺少 input.task，无法构成案例" });
      return;
    }

    const expected = asRecord(item.expectedOutput);
    const constraints = toConstraints(input.context);
    const metadata = { ...item.metadata };

    // 人工答案可以写在 expected_result（直接沿用）或 answer（按类型归一）里
    const answer =
      expected.expected_result !== undefined && expected.expected_result !== null && expected.expected_result !== ""
        ? expected.expected_result
        : normalizeAnswer(expected.answer);

    if (answer !== null && answer !== undefined) {
      cases.push({
        task,
        ...(constraints ? { constraints } : {}),
        expected_result: answer,
      });
      manifest.push({ index, kind: "case", task, metadata });
      return;
    }

    structuralOnly.push({
      task,
      ...(constraints ? { constraints } : {}),
      expected_result: {
        structural_only: true,
        must_include: Array.isArray(expected.must_include) ? expected.must_include : [],
        must_not_include: Array.isArray(expected.must_not_include) ? expected.must_not_include : [],
        format: expected.format ?? "",
      },
    });
    manifest.push({
      index,
      kind: "structural",
      task,
      metadata,
      reason: "该条目尚无业务确认的标准答案；只能由规则评分器判结构，不判答案。",
    });
  });

  return { cases, structuralOnly, manifest, skipped };
}

/**
 * rule_checks → 助手侧 custom code evaluator（Langfuse code evaluator 接口）。
 * 判定逻辑与 `rule_scorers.py`、网页试运行页完全一致，只是把加权分压扁成单一布尔。
 *
 * @param threshold 判为「完成」的加权分下限，默认 1.0（全过才算完成）
 */
export function emitLoopxEvaluatorPy(rules: RuleCheck[], threshold = 1.0): string {
  const active = rules
    .filter((r) => r.enabled !== false)
    .map((r) => {
      const copy: RuleCheck = { ...r };
      delete copy.enabled;
      return copy;
    });
  return `"""SH-LoopX 评测助手 · 自定义代码评分器（由 SkillFuse 导出）。

判定逻辑与 SkillFuse 网页的规则评分完全一致：先跑全部规则，再按权重汇总，
最后压扁为助手唯一支持的布尔指标 task_completed。各规则明细保留在 comment 里以便回溯。

只读取实际答案与执行状态；不读取工具轨迹、SQL 证明、查询编号或 skill 触发字段。
发布前请用「符合标准 / 不符合标准 / 业务失败」三类样例验证。
"""

import json
import re

RULES = json.loads(r'''${JSON.stringify(active).replace(/'/g, "\\u0027")}''')

# 加权分达到该阈值即判为完成；1.0 表示全部规则必须通过
THRESHOLD = ${threshold}


${PY_RULE_ENGINE}


def _run_all(output: str):
    results = []
    for rule in RULES:
        ok, comment = _check(rule, output)
        results.append(
            {
                "name": rule.get("name", rule["id"]),
                "passed": ok,
                "score": 1.0 if ok else 0.0,
                "weight": rule.get("weight", 1),
                "comment": comment,
            }
        )
    return results


def evaluate(ctx):
    output = (ctx.observation.output or "") if getattr(ctx, "observation", None) else ""
    if not isinstance(output, str):
        output = json.dumps(output, ensure_ascii=False)

    status = (getattr(ctx, "metadata", None) or {}).get("execution_status")
    if status and status != "success":
        return {
            "scores": [
                {
                    "name": "task_completed",
                    "value": False,
                    "dataType": "BOOLEAN",
                    "comment": f"执行状态异常：{status}",
                }
            ]
        }

    results = _run_all(output)
    total = sum(r["weight"] for r in results) or 1
    weighted = sum(r["score"] * r["weight"] for r in results) / total
    failed = [f"{r['name']}: {r['comment']}" for r in results if not r["passed"]]
    return {
        "scores": [
            {
                "name": "task_completed",
                "value": weighted >= THRESHOLD,
                "dataType": "BOOLEAN",
                "comment": f"加权分 {weighted:.2f}/{THRESHOLD}；未过规则：" + ("；".join(failed) or "无"),
            }
        ]
    }


if __name__ == "__main__":
    import sys

    class _Obs:
        def __init__(self, text):
            self.output = text

    class _Ctx:
        def __init__(self, text):
            self.observation = _Obs(text)
            self.metadata = {}

    print(json.dumps(evaluate(_Ctx(sys.stdin.read())), ensure_ascii=False, indent=2))
`;
}

/** 导出包的使用说明——把「怎么交给助手」写进包里，避免回到文档里翻话术。 */
export function emitLoopxReadme(skillName: string, exported: LoopxExport, threshold: number): string {
  return `# ${skillName} · SH-LoopX 评测助手案例包

由 SkillFuse 导出。包含：

| 文件 | 内容 |
|---|---|
| \`loopx_cases.json\` | ${exported.cases.length} 条正式案例（已带业务确认的标准答案） |
| \`loopx_structural_cases.json\` | ${exported.structuralOnly.length} 条结构判定案例（尚无标准答案，只判结构） |
| \`loopx_evaluator.py\` | 自定义代码评分器，加权分 ≥ ${threshold} 判为 task_completed |
| \`loopx_manifest.json\` | 每条案例的来源、标签与分流原因（本地留痕，不要粘给助手） |

助手的业务 JSON 字段是封闭的——只认 \`task\` / \`constraints\` / \`expected_result\`，
多一个键会被 \`normalize_evaluation_materials\` 拒绝，所以条目 metadata 单独放在 manifest 里。

## 用法（在 Claude Code 中）

1. 粘贴 \`loopx_cases.json\`：
   > 将这些材料整理为 \`${skillName}\` 的评测案例，追加到已选数据集；列出缺项、重复或冲突，先不要保存。
2. 需要规则判定时再粘贴 \`loopx_evaluator.py\`：
   > 这套案例使用自定义代码规则判定，代码如下……请展示案例和规则的变更预览。
3. 检查预览无误后：
   > 确认保存以上案例和评分规则。

## 注意

- 结构判定案例的 \`expected_result\` 只是结构要求的留痕，评分器不读它——判定完全来自规则。要转成正式案例，请由业务补上标准答案后重新导出。
- 不要用被测 skill 自己的输出充当标准答案。
- 保存动作必须走助手的 preview → 人工确认 → confirm，本包不直接写远端。
${exported.skipped.length > 0 ? `- 有 ${exported.skipped.length} 条条目因缺少 task 被跳过。\n` : ""}`;
}
