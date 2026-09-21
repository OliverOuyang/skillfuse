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
import { PY_CONTRACT_ENGINE } from "./pyContractEngine";
import { normalizeContract } from "./contract";
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
 * 人工答案与 facts 级契约进 `cases`；structure 级契约进 `structuralOnly`。
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

    const contract = normalizeContract(item.expectedOutput);
    const target = contract.verification_level === "facts" ? cases : structuralOnly;
    target.push({ task, ...(constraints ? { constraints } : {}), expected_result: contract });
    manifest.push(
      contract.verification_level === "facts"
        ? { index, kind: "case", task, metadata }
        : {
            index,
            kind: "structural",
            task,
            metadata,
            reason: "关键指标未由业务确认，本条只判结构与禁止内容，不判数值。",
          },
    );
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
  return `# -*- coding: utf-8 -*-
"""SH-LoopX 评测助手 · 自定义代码评分器（由 SkillFuse 导出）。

先检查执行状态与契约格式，再跑全局规则和案例契约，最后压扁为助手唯一支持的
布尔指标 task_completed。各层明细保留在 comment 里以便回溯。

只读取实际答案与执行状态；不读取工具轨迹、SQL 证明、查询编号或 skill 触发字段。
发布前请用「符合标准 / 不符合标准 / 业务失败」三类样例验证。
"""

import json
import re

RULES = json.loads(r'''${JSON.stringify(active).replace(/'/g, "\\u0027")}''')

# 加权分达到该阈值即判为完成；1.0 表示全部规则必须通过
THRESHOLD = ${threshold}


${PY_RULE_ENGINE}


${PY_CONTRACT_ENGINE}


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


def _get(value, key, default=None):
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default) if value is not None else default


def _read_contract(ctx):
    experiment = _get(ctx, "experiment")
    item = _get(ctx, "item")
    candidates = [
        _get(experiment, "itemExpectedOutput"),
        _get(item, "expected_output"),
        _get(item, "expectedOutput"),
        _get(ctx, "expected_output"),
    ]
    for candidate in candidates:
        if candidate is None or candidate == "":
            continue
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except Exception:
                continue
        if isinstance(candidate, dict):
            return candidate
    return None


def _score(value, comment):
    return {
        "scores": [
            {
                "name": "task_completed",
                "value": value,
                "dataType": "BOOLEAN",
                "comment": comment,
            }
        ]
    }


def evaluate(ctx):
    observation = _get(ctx, "observation")
    output = _get(observation, "output", "")
    if not isinstance(output, str):
        output = json.dumps(output, ensure_ascii=False)

    # 助手不一定回传 execution_status；缺省视为正常，只有明确的非 success 才判失败
    status = _get(_get(ctx, "metadata", {}), "execution_status")
    if status and status != "success":
        return _score(False, f"执行状态异常：{status}")

    contract = _read_contract(ctx)
    l1_status, l1_comment = _check_format(output, contract.get("format", "text")) if contract else ("pass", "无契约")
    if l1_status == "fail":
        return _score(
            False,
            f"L1 格式:失败（{l1_comment}） | L2 规则 0/{len(RULES)}（加权 0.00/{THRESHOLD}） | "
            "L3 契约 通过0/跳过0/失败0；失败明细：未执行；跳过明细：无",
        )

    results = _run_all(output)
    total = sum(r["weight"] for r in results) or 1
    weighted = sum(r["score"] * r["weight"] for r in results) / total
    rule_passed = sum(1 for result in results if result["passed"])
    if weighted < THRESHOLD:
        failed = "；".join(f"{r['name']}: {r['comment']}" for r in results if not r["passed"])
        return _score(
            False,
            f"L1 格式:通过（{l1_comment}） | L2 规则 {rule_passed}/{len(results)}（加权 {weighted:.2f}/{THRESHOLD}） | "
            f"L3 契约 通过0/跳过0/失败0；失败明细：L2 未通过：{failed or '无'}；跳过明细：无",
        )

    contract_results = _run_contract(output, contract)
    passed = [result for result in contract_results if result["status"] == "pass"]
    skipped = [result for result in contract_results if result["status"] == "skip"]
    failed = [result for result in contract_results if result["status"] == "fail"]
    if contract is None:
        l3_detail = "未拿到 itemExpectedOutput，仅完成结构判定"
        skip_detail = "无"
    else:
        l3_detail = "；".join(f"{result['name']}: {result['comment']}" for result in failed) or "无"
        skip_detail = "；".join(f"{result['name']}: {result['comment']}" for result in skipped) or "无"
    comment = (
        f"L1 格式:通过（{l1_comment}） | L2 规则 {rule_passed}/{len(results)}（加权 {weighted:.2f}/{THRESHOLD}） | "
        f"L3 契约 通过{len(passed)}/跳过{len(skipped)}/失败{len(failed)}；失败明细：{l3_detail}；跳过明细：{skip_detail}"
    )
    return _score(not failed, comment)


if __name__ == "__main__":
    import sys

    class _Obs:
        def __init__(self, text):
            self.output = text

    class _Ctx:
        def __init__(self, text, contract):
            self.observation = _Obs(text)
            self.metadata = {"execution_status": "success"}
            self.expected_output = contract

    if len(sys.argv) < 2:
        raise SystemExit("用法：python loopx_evaluator.py <output_file> [contract_file]")
    with open(sys.argv[1], encoding="utf-8") as output_file:
        output = output_file.read()
    contract = None
    if len(sys.argv) > 2:
        with open(sys.argv[2], encoding="utf-8") as contract_file:
            contract = json.load(contract_file)
    print(json.dumps(evaluate(_Ctx(output, contract)), ensure_ascii=False, indent=2))
`;
}

/** 导出包的使用说明——把「怎么交给助手」写进包里，避免回到文档里翻话术。 */
export function emitLoopxReadme(skillName: string, exported: LoopxExport, threshold: number): string {
  return `# ${skillName} · SH-LoopX 评测助手案例包

由 SkillFuse 导出。包含：

| 文件 | 内容 |
|---|---|
| \`loopx-cases.json\` | ${exported.cases.length} 条正式案例（已带业务确认的标准答案） |
| \`loopx-structural-cases.json\` | ${exported.structuralOnly.length} 条结构判定案例（尚无标准答案，只判结构） |
| \`loopx_evaluator.py\` | 自定义代码评分器，L1/L2/L3 三层全过才判为 task_completed（见下） |
| \`loopx-manifest.json\` | 每条案例的来源、标签与分流原因（本地留痕，不要粘给助手） |

助手的业务 JSON 字段是封闭的——只认 \`task\` / \`constraints\` / \`expected_result\`，
多一个键会被 \`normalize_evaluation_materials\` 拒绝，所以条目 metadata 单独放在 manifest 里。

## 用法（在 Claude Code 中）

1. 粘贴 \`loopx-cases.json\`：
   > 将这些材料整理为 \`${skillName}\` 的评测案例，追加到已选数据集；列出缺项、重复或冲突，先不要保存。
2. 需要规则判定时再粘贴 \`loopx_evaluator.py\`：
   > 这套案例使用自定义代码规则判定，代码如下……请展示案例和规则的变更预览。
3. 检查预览无误后：
   > 确认保存以上案例和评分规则。

## 评分器判什么

| 层级 | 判定内容 | 失败结果 |
|---|---|---|
| L1 | 执行状态与契约声明的输出格式 | 立即判为未完成 |
| L2 | 全局规则的加权分 | 低于 ${threshold} 判为未完成 |
| L3 | 章节、表格、必备表述、禁止内容和已确认业务事实 | 任一失败即判为未完成；pending 事实只跳过 |

## 如何把结构级案例升级为数据级案例

在 \`expected_result.facts\` 中把 \`value\` 填成业务确认值、\`status\` 改为 \`"confirmed"\`，按需设置 \`tolerance\`，再把 \`verification_level\` 改为 \`"facts"\`。数值必须来自已确认的 SQL、报表或人工基准，不能用被测 skill 的输出反推。

## 本评测不覆盖什么

- 不判断 HTML 的浏览器渲染效果、配色排版和分析深度等主观质量。
- skill 只写文件、不在最终回复中回显内容时，评分器拿不到文件正文，无法判定。

## 注意

- 结构判定案例会读取完整验收契约，但 pending 事实只记为“关键数据未核验”，不会假装通过。
- 不要用被测 skill 自己的输出充当标准答案。
- 保存动作必须走助手的 preview → 人工确认 → confirm，本包不直接写远端。
${exported.skipped.length > 0 ? `- 有 ${exported.skipped.length} 条条目因缺少 task 被跳过。\n` : ""}`;
}
