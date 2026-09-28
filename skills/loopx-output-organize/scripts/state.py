"""从课题事件与版本台账推算当前状态。"""

from __future__ import annotations

from pathlib import Path

from events import read_events
from layout import FLOW_FILE, LEDGER_NAME, TASK_META, list_versions, node_dir, parse_ref, version_dir_name
from ledger import DONE_STATUSES, read_json


class TaskState:
    def __init__(self, task_dir: Path, flow: dict, meta: dict, events: list[dict],
                 ledgers: dict[str, dict[int, dict]]):
        self.task_dir = task_dir
        self.flow = flow
        self.meta = meta
        self.events = events
        self.ledgers = ledgers
        self._current = {}
        self._reasons_cache = {}
        self._handoffs = sorted((event for event in events if event.get("类型") == "交接"),
                                key=lambda event: event["序号"])
        for event in sorted(events, key=lambda item: item["序号"]):
            node = event.get("节点")
            if event.get("类型") == "提交" and event.get("执行状态") in DONE_STATUSES:
                self._current[node] = event["版本"]
            elif event.get("类型") == "采用":
                self._current[node] = event["版本"]
            elif event.get("类型") == "跳过":
                self._current[node] = "跳过"

    def current(self, node_id: str) -> int | str | None:
        return self._current.get(node_id)

    def _dependency_reasons(self, reference: str, active: set[tuple[str, int]]) -> list[str]:
        parsed = parse_ref(reference)
        handoff_number = parsed["交接"]
        if handoff_number is not None:
            handoff = next((item for item in self._handoffs if item["编号"] == handoff_number), None)
            if handoff is None:
                return [f"交接#{handoff_number} 不存在"]
            latest = self.latest_handoff(handoff["名称"])
            return ([] if latest["编号"] == handoff_number else
                    [f"交接#{handoff_number} 已被交接#{latest['编号']} 取代"])
        if parsed["课题"] is not None or parsed["嵌套"]:
            return []  # 跨课题与嵌套引用不属于本课题的有效性依赖图。
        node = parsed["节点"]
        adopted = self.current(node)
        if parsed["跳过"]:
            return [] if adopted == "跳过" else [f"{node} 不再是跳过状态"]
        version = parsed["版本"]
        if adopted != version:
            current_text = f"第{adopted}版" if isinstance(adopted, int) else (adopted or "无")
            return [f"依赖 {node} 当前采用{current_text}，本版用的是第{version}版"]
        if version not in self.ledgers.get(node, {}):
            return [f"依赖 {reference} 的台账不存在"]
        dependency_reasons = self._reasons(node, version, active)
        if dependency_reasons:
            cycle = next((reason for reason in dependency_reasons if "依赖链出现循环" in reason), None)
            return [f"依赖 {reference} 已过期" + (f"（{cycle}）" if cycle else "")]
        return []

    def _reasons(self, node_id: str, version: int, active: set[tuple[str, int]]) -> tuple[str, ...]:
        key = (node_id, version)
        if key in self._reasons_cache:
            return self._reasons_cache[key]
        if key in active:
            return (f"依赖链出现循环：{node_id}@v{version}",)
        ledger = self.ledgers[node_id][version]
        if ledger["执行状态"] not in DONE_STATUSES or self.current(node_id) != version:
            return ()
        active.add(key)
        try:
            reasons = tuple(reason for item in ledger["输入"] if item["角色"] == "依赖"
                            for reason in self._dependency_reasons(item["引用"], active))
        finally:
            active.remove(key)
        self._reasons_cache[key] = reasons
        return reasons

    def validity(self, node_id: str, version: int) -> str:
        status = self.ledgers[node_id][version]["执行状态"]
        if status in ("进行中", "失败"):
            return status
        if self.current(node_id) != version:
            return "已替代"
        return "过期" if self._reasons(node_id, version, set()) else "当前采用"

    def stale_reasons(self, node_id: str, version: int) -> list[str]:
        return list(self._reasons(node_id, version, set()))

    def pending_triggers(self, node_id: str) -> list[dict]:
        consumed = {(ledger["触发"]["类型"], ledger["触发"]["编号"])
                    for ledger in self.ledgers.get(node_id, {}).values()
                    if ledger["执行状态"] in DONE_STATUSES}
        return [event for event in sorted(self.events, key=lambda item: item["序号"])
                if event.get("类型") in ("打回", "补证") and node_id in event.get("目标", [])
                and (event["类型"], event["编号"]) not in consumed]

    def rounds(self, node_id: str) -> int:
        return len(self.ledgers.get(node_id, {}))

    def open_issues(self) -> list[dict]:
        issues = {}
        for event in sorted(self.events, key=lambda item: item["序号"]):
            if event.get("类型") == "未解决项":
                if event.get("动作") == "新增":
                    issues[event["编号"]] = event
                elif event.get("动作") == "关闭":
                    issues.pop(event["编号"], None)
        return list(issues.values())

    def handoffs(self, name: str | None = None) -> list[dict]:
        return [item for item in self._handoffs if name is None or item["名称"] == name]

    def latest_handoff(self, name: str) -> dict | None:
        return max(self.handoffs(name), key=lambda item: item["编号"], default=None)

    def handoff_outdated(self, handoff: dict) -> list[str]:
        return [node for node, reference in handoff["清单"].items()
                if reference != ("跳过" if self.current(node) == "跳过" else
                                 f"{node}@v{self.current(node)}")]

    def _dependencies_ready(self, node_id: str) -> bool:
        for dependency in self.flow["节点"][node_id]["依赖"]:
            if dependency.startswith("交接:"):
                if self.latest_handoff(dependency.removeprefix("交接:")) is None:
                    return False
                continue
            adopted = self.current(dependency)
            if adopted == "跳过":
                continue
            if not isinstance(adopted, int) or self.validity(dependency, adopted) != "当前采用":
                return False
        return True

    def todo(self) -> list[dict]:
        result = []
        for node in self.flow["顺序"]:
            reasons = []
            adopted = self.current(node)
            if isinstance(adopted, int) and self.validity(node, adopted) == "过期":
                reasons.append("当前采用已过期：" + "；".join(self.stale_reasons(node, adopted)))
            reasons.extend(f"待重做：{event['类型']}#{event['编号']} 未消费"
                           for event in self.pending_triggers(node))
            if not self.ledgers.get(node) and self._dependencies_ready(node) and adopted is None:
                reasons.append("依赖已就绪但未开始")
            if reasons:
                result.append({"节点": node, "原因": "；".join(reasons)})
        return result


def load_task_state(task_dir: Path) -> TaskState:
    flow = read_json(task_dir / FLOW_FILE)
    meta = read_json(task_dir / TASK_META)
    events, _ = read_events(task_dir)
    ledgers = {}
    for node in flow["节点"]:
        directory = node_dir(task_dir, flow, node)
        ledgers[node] = {version: read_json(directory / version_dir_name(version) / LEDGER_NAME)
                         for version in list_versions(directory)}
    return TaskState(task_dir, flow, meta, events, ledgers)
