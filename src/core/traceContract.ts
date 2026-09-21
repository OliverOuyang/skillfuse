/**
 * trace 契约、案例与接入模板的单一事实来源。
 *
 * 规则只判断真实落盘的契约实体；同一份常量同时供检查页复制，避免文案与校验标准漂移。
 */

export const CANONICAL_SPANS: string[] = [
  "skill.activate",
  "skill.load",
  "skill.run_script",
  "tool.execute",
  "guardrail.check",
  "human.review",
];

export const TRACE_STEP_SCHEMA = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Skill trace 步骤记录",
  "type": "object",
  "required": ["ts", "step", "status", "duration_ms"],
  "properties": {
    "ts": { "type": "string", "format": "date-time" },
    "step": {
      "type": "string",
      "enum": ["skill.activate", "skill.load", "skill.run_script", "tool.execute", "guardrail.check", "human.review"]
    },
    "status": { "type": "string", "enum": ["ok", "fail", "skip"] },
    "duration_ms": { "type": "number", "minimum": 0 },
    "attrs": { "type": "object" },
    "error": {
      "type": "object",
      "required": ["type", "message"],
      "properties": {
        "type": { "type": "string" },
        "message": { "type": "string" }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}`;

export const TRACE_EXAMPLE_JSONL = `{"ts":"2026-09-21T01:00:00.000Z","step":"skill.activate","status":"ok","duration_ms":3,"attrs":{"gen_ai.skill.name":"loopx-risk-report"}}
{"ts":"2026-09-21T01:00:00.004Z","step":"skill.load","status":"ok","duration_ms":8,"attrs":{"gen_ai.skill.resource":"references/policy.md"}}
{"ts":"2026-09-21T01:00:00.013Z","step":"skill.run_script","status":"ok","duration_ms":21,"attrs":{"gen_ai.skill.script":"scripts/build_report.py"}}
{"ts":"2026-09-21T01:00:00.035Z","step":"tool.execute","status":"ok","duration_ms":42,"attrs":{"gen_ai.skill.tool":"warehouse.query"}}
{"ts":"2026-09-21T01:00:00.078Z","step":"guardrail.check","status":"fail","duration_ms":2,"error":{"type":"PolicyViolation","message":"输出包含未验证数据，已阻止发布"}}
{"ts":"2026-09-21T01:00:00.081Z","step":"human.review","status":"skip","duration_ms":0,"attrs":{"gen_ai.skill.fallback":"返回安全摘要并等待人工复核"}}`;

export const TRACE_HELPER_PY = `"""向 stderr 写入符合 trace 契约的单行 JSON。"""

import json
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone


def _write(step, status, started, attrs=None, error=None):
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "step": step,
        "status": status,
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
    }
    if attrs:
        record["attrs"] = attrs
    if error:
        record["error"] = error
    print(json.dumps(record, ensure_ascii=False), file=sys.stderr, flush=True)


@contextmanager
def emit_step(step, attrs=None):
    started = time.perf_counter()
    try:
        yield
    except Exception as exc:
        _write(step, "fail", started, attrs, {"type": type(exc).__name__, "message": str(exc)})
        raise
    else:
        _write(step, "ok", started, attrs)`;

export const TRACE_SECTION_MD = `## 可观测性与 trace

每个步骤向 stderr 输出一行 JSONL，\`step\` 只能使用以下 span：

- \`skill.activate\`：确认 skill 被触发
- \`skill.load\`：加载 references 等资源
- \`skill.run_script\`：运行 scripts/ 下的脚本
- \`tool.execute\`：调用外部工具
- \`guardrail.check\`：执行安全或质量检查
- \`human.review\`：等待人工复核

每行必须包含 ISO8601 格式的 \`ts\`、\`step\`、\`status\` 和 \`duration_ms\`；\`status\` 只允许 \`ok\`、\`fail\`、\`skip\`。\`attrs\` 承载 \`gen_ai.skill.*\` 属性，失败时用 \`error.type\` 与 \`error.message\` 记录原因。

脚本通过 \`from trace_emit import emit_step\` 引入辅助函数，并用 \`with emit_step("skill.run_script"):\` 包裹实际步骤。`;
