"""交接检查与主交付物快照。"""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import shutil

from events import append_event, next_number
from layout import HANDOFF_DIR, handoff_dir_name, node_dir, version_dir_name, version_ref
from ledger import sha256_file
from state import TaskState


def handoff_scope(flow: dict, node_id: str) -> list[str]:
    stage = flow["节点"][node_id]["阶段"]
    removed = set(flow["已移出"])
    return [node for node in flow["顺序"]
            if node not in removed and flow["节点"][node]["阶段"] == stage]


def check_handoff(state: TaskState, node_id: str) -> list[str]:
    node = state.flow["节点"].get(node_id)
    if node is None:
        return [f"节点不存在：{node_id}"]
    problems = []
    if not node.get("交接"):
        problems.append(f"节点 {node_id} 没有定义交接")
    # 最终交接按流程位置判定，不依赖交接名称。
    final = next((key for key in reversed(state.flow["顺序"])
                  if state.flow["节点"][key].get("交接")), None)
    if node_id == final:
        problems.extend(f"未关闭未解决项#{item['编号']}：{item['描述']}"
                        for item in state.open_issues())
    for scoped in handoff_scope(state.flow, node_id):
        current = state.current(scoped)
        if current == "跳过":
            continue
        if not isinstance(current, int):
            problems.append(f"节点 {scoped} 当前采用为空")
            continue
        validity = state.validity(scoped, current)
        if validity != "当前采用":
            problems.append(f"节点 {scoped} 有效性为{validity}")
        if state.flow["节点"][scoped]["门禁"]:
            verdict = (state.ledgers[scoped][current].get("评审结论") or {}).get("结论")
            if verdict not in ("通过", "带问题通过"):
                problems.append(f"门禁节点 {scoped} 结论不是通过或带问题通过：{verdict or '无'}")
    return problems


def _version_items(state: TaskState, scope: list[str]) -> tuple[dict, list[tuple[Path, Path]]]:
    versions = {}
    copies = []
    for node in scope:
        current = state.current(node)
        if current == "跳过":
            versions[node] = {"引用": "跳过", "主交付物": None, "sha256": None}
            continue
        if not isinstance(current, int):
            versions[node] = {"引用": None, "主交付物": None, "sha256": None}
            continue
        ledger = state.ledgers[node][current]
        primary = next((item for item in ledger.get("artifacts", []) if item.get("角色") == "主交付物"), None)
        reference = version_ref(node, current)
        if primary is None:
            versions[node] = {"引用": reference, "主交付物": None, "sha256": None}
            continue
        source = node_dir(state.task_dir, state.flow, node) / version_dir_name(current) / primary["相对路径"]
        relative = Path("交付物") / state.flow["节点"][node]["目录"][-1] / source.name
        if not source.is_file():
            raise FileNotFoundError(source)
        versions[node] = {"引用": reference, "主交付物": relative.as_posix(),
                          "sha256": sha256_file(source)}
        copies.append((source, relative))
    return versions, copies


def _description(manifest: dict, state: TaskState, scope: list[str], problems: list[str]) -> str:
    lines = [f"# 交接#{manifest['编号']} {manifest['名称']}",
             f"交接节点：{manifest['节点']}"]
    current = state.current(manifest["节点"])
    verdict = None
    if isinstance(current, int):
        verdict = (state.ledgers[manifest["节点"]][current].get("评审结论") or {}).get("结论")
    lines.append(f"评审结论：{verdict or '无'}")
    lines.extend(["", "## 范围内各节点采用版本"])
    lines.extend(f"- {node}：{manifest['版本'][node]['引用'] or '无'}" for node in scope)
    lines.extend(["", "## 带过去的未解决项"])
    issues = {item["编号"]: item for item in state.open_issues()}
    lines.extend(f"- #{issue}：{issues[issue]['描述']}" for issue in manifest["未解决项"])
    if not manifest["未解决项"]:
        lines.append("- 无")
    if manifest["人工确认"] is not None:
        lines.extend(["", "## 人工确认原因", manifest["人工确认"]])
        lines.extend(f"- {problem}" for problem in problems)
    return "\n".join(lines) + "\n"


def create_handoff(state: TaskState, node_id: str, *, session: str,
                   confirm: str | None, now: datetime) -> dict:
    problems = check_handoff(state, node_id)
    if problems and not confirm:
        raise ValueError("无法交接：" + "；".join(problems))
    if node_id not in state.flow["节点"] or not state.flow["节点"][node_id].get("交接"):
        raise ValueError("无法交接：" + "；".join(problems))
    scope = handoff_scope(state.flow, node_id)
    versions, copies = _version_items(state, scope)
    number = next_number(state.events, "交接")
    name = state.flow["节点"][node_id]["交接"]
    issues = [item["编号"] for item in state.open_issues()]
    manifest = {"编号": number, "名称": name, "节点": node_id, "创建时间": now.astimezone().isoformat(),
                "版本": versions, "未解决项": issues, "人工确认": confirm}
    directory = state.task_dir / HANDOFF_DIR / handoff_dir_name(number, name, now)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "交付物").mkdir()
    for source, relative in copies:
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    (directory / "清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (directory / "交接说明.md").write_text(_description(manifest, state, scope, problems), encoding="utf-8")
    references = {node: item["引用"] for node, item in versions.items()}
    append_event(state.task_dir, "交接",
                 {"编号": number, "名称": name, "节点": node_id, "清单": references,
                  "未解决项": issues, "人工确认": confirm, "问题": problems},
                 session=session, now=now)
    return manifest
