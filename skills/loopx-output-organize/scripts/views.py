"""由课题派生状态生成可读视图。"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from layout import node_dir, parse_ref
from state import TaskState, load_task_state


_INDEX = re.compile(r"(?:当前采用_.*|已跳过)\.md\Z")


def _cell(value) -> str:
    return str(value if value is not None else "—").replace("|", "\\|").replace("\n", "<br>")


def _table(headers: tuple[str, ...], rows: list[tuple]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(_cell(value) for value in row) + " |" for row in rows)
    return "\n".join(lines)


def _ordered_nodes(state: TaskState) -> list[str]:
    return list(state.flow["顺序"]) + [node for node in state.flow["已移出"]
                                             if node not in state.flow["顺序"]]


def _short_time(value: str) -> str:
    if not value or value == "—":
        return "—"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().strftime("%m-%d %H:%M")


def _node_label(state: TaskState, node: str) -> str:
    data = state.flow["节点"][node]
    name = data.get("名称")
    label = f"{node} {name}" if name and name != node else node
    return ("　　" if len(data["目录"]) > 2 else "") + label


def _dependency_sources(state: TaskState, reference: str, visit) -> list[str]:
    parsed = parse_ref(reference)
    number = parsed["交接"]
    if number is not None:
        handoff = next((item for item in state.handoffs() if item["编号"] == number), None)
        if handoff is None:
            return [f"交接#{number} 不存在"]
        latest = state.latest_handoff(handoff["名称"])
        return ([] if latest["编号"] == number else
                [f"交接#{number} 已被交接#{latest['编号']} 取代"])
    if parsed["课题"] is not None or parsed["嵌套"]:
        return []
    node, version = parsed["节点"], parsed["版本"]
    adopted = state.current(node)
    if parsed["跳过"]:
        return [] if adopted == "跳过" else [f"{node} 已不再跳过"]
    if adopted != version:
        current_text = f"第{adopted}版" if isinstance(adopted, int) else (adopted or "无")
        return [f"上游 {node} 已更新（第{version}版 → {current_text}）"]
    if version not in state.ledgers.get(node, {}):
        return [f"依赖 {reference} 的台账不存在"]
    return visit(node, version)


def _source_reasons(state: TaskState, node: str, version: int) -> list[str]:
    cache, active = {}, set()

    def visit(identifier, number):
        key = (identifier, number)
        if key in cache:
            return cache[key]
        if key in active:
            return [f"依赖链出现循环：{identifier}@v{number}"]
        if state.validity(identifier, number) != "过期":
            return []
        active.add(key)
        reasons = [reason for item in state.ledgers[identifier][number]["输入"]
                   if item["角色"] == "依赖"
                   for reason in _dependency_sources(state, item["引用"], visit)]
        active.remove(key)
        # 菱形依赖只展示一次源头，缓存避免同一链重复追溯。
        cache[key] = list(dict.fromkeys(reasons))
        return cache[key]

    return visit(node, version)


def _todo_rows(state: TaskState) -> list[tuple]:
    rows = []
    for item in state.todo():
        node, reason = item["节点"], item["原因"]
        current = state.current(node)
        if isinstance(current, int) and state.validity(node, current) == "过期":
            old = "当前采用已过期：" + "；".join(state.stale_reasons(node, current))
            reason = reason.replace(old, "；".join(_source_reasons(state, node, current)), 1)
        rows.append((node, reason))
    return rows


def _node_status(state: TaskState, node: str) -> tuple[str, str, str]:
    current = state.current(node)
    pending = state.pending_triggers(node)
    notes = []
    if node in state.flow["已移出"]:
        notes.append("已移出流程")
    if state.flow["节点"][node].get("待核对"):
        notes.append("待核对")
    if current == "跳过":
        adopted, validity = "跳过", "已跳过"
        notes.append("已跳过")
    elif isinstance(current, int):
        adopted = f"第{current}版"
        validity = state.validity(node, current)
        if validity == "当前采用":
            validity = "有效"
        notes.extend(_source_reasons(state, node, current))
    else:
        adopted, validity = "—", "无"
    notes.extend(f"待重做（{event['类型']}#{event['编号']}）" for event in pending)
    return adopted, validity, "；".join(notes) or "—"


def _flow_sections(state: TaskState) -> list[str]:
    sections = ["## 按流程"]
    stages = []
    for node in state.flow["顺序"]:
        stage = state.flow["节点"][node]["阶段"]
        if stage not in stages:
            stages.append(stage)
    for stage in stages:
        data = next(state.flow["节点"][node] for node in state.flow["顺序"]
                    if state.flow["节点"][node]["阶段"] == stage)
        # 规范化流程仅在目录中保留最外层分组名。
        group = data["目录"][0] if stage else ""
        name = group.removeprefix(f"{stage}_") if group != stage else ""
        sections.append(f"### {stage} {name}".rstrip())
        sections.append(_node_table(state, [node for node in state.flow["顺序"]
                                            if state.flow["节点"][node]["阶段"] == stage]))
    if state.flow["已移出"]:
        sections.append("### 已移出节点")
        sections.append(_node_table(state, [node for node in _ordered_nodes(state)
                                            if node in state.flow["已移出"]]))
    return sections


def _node_table(state: TaskState, nodes: list[str]) -> str:
    rows = []
    for node in nodes:
        data = state.flow["节点"][node]
        adopted, validity, notes = _node_status(state, node)
        returns = sum(event.get("类型") == "打回" and node in event.get("目标", [])
                      for event in state.events)
        supplements = sum(event.get("类型") == "补证" and node in event.get("目标", [])
                          for event in state.events)
        rows.append((_node_label(state, node), data["执行方"], adopted, validity,
                     state.rounds(node), f"{returns}/{supplements}", notes))
    return _table(("节点", "执行方", "当前采用", "有效性", "版本数", "打回/补证", "备注"), rows)


def _assignment_section(state: TaskState) -> str:
    groups = {}
    for node in _ordered_nodes(state):
        executor = state.flow["节点"][node]["执行方"]
        groups.setdefault(executor, []).append(node)
    lines = ["## 按分工"]
    labels = {"skill": "Skill 分析", "代码": "固定代码", "人工": "人工确认",
              "配置": "共用配置", "智能体": "智能体", "报告整合": "报告整合"}
    for executor, nodes in groups.items():
        lines.append(f"### {labels[executor]}")
        rows = []
        for node in nodes:
            for version, ledger in sorted(state.ledgers.get(node, {}).items()):
                skill = ledger.get("skill") or {}
                rows.append((skill.get("名称", "—") if executor == "skill" else "—",
                             node, f"第{version}版"))
        if executor == "skill":
            # 同一 skill 的产出集中展示，便于查找跨节点版本。
            rows.sort(key=lambda row: (row[0], nodes.index(row[1]), row[2]))
        lines.append(_table(("skill 名称", "节点", "产出版本"), rows))
    return "\n\n".join(lines)


def _handoff_section(state: TaskState) -> str:
    lines = ["## 交接"]
    rows = [(f"交接#{item['编号']}", item["名称"], item["节点"], _short_time(item["时间"]))
            for item in state.handoffs()]
    lines.append(_table(("编号", "名称", "节点", "时间"), rows))
    for item in state.handoffs():
        outdated = state.handoff_outdated(item)
        if outdated:
            lines.append(f"交接#{item['编号']} 之后以下节点有更新：{'、'.join(outdated)}")
    return "\n\n".join(lines)


def _version_history(state: TaskState, node: str) -> list[dict]:
    rows = []
    for number, data in sorted(state.ledgers.get(node, {}).items()):
        trigger = data["触发"]
        label = trigger["类型"]
        if trigger["编号"] is not None:
            label += f"#{trigger['编号']}"
        rows.append({"版本": number, "执行状态": data["执行状态"],
                     "有效性": state.validity(node, number), "触发": label,
                     "评审结论": (data.get("评审结论") or {}).get("结论"),
                     "创建时间": data["创建时间"]})
    return rows


def _version_lines(state: TaskState) -> str:
    lines = ["## 版本线"]
    for node in _ordered_nodes(state):
        history = _version_history(state, node)
        if len(history) < 2:
            continue
        versions = []
        for item in history:
            parts = [item["触发"]]
            if state.flow["节点"][node]["门禁"] and item["评审结论"]:
                parts.append(item["评审结论"])
            parts.append("有效" if item["有效性"] == "当前采用" else item["有效性"])
            versions.append(f"第{item['版本']}版 " + "·".join(parts))
        lines.append(_node_label(state, node).strip() + "：" + " → ".join(versions))
    return "\n\n".join(lines)


def _history_table(state: TaskState, node: str) -> str:
    headers = ("版本", "执行状态", "有效性", "触发", "评审结论", "创建时间")
    # 仅压缩视图展示，保留历史数据中的原始状态与时间。
    rows = [(f"第{item['版本']}版", item["执行状态"],
             "有效" if item["有效性"] == "当前采用" else item["有效性"],
             item["触发"], item["评审结论"], _short_time(item["创建时间"]))
            for item in _version_history(state, node)]
    return "\n## 版本历史\n\n" + _table(headers, rows) + "\n"


def render_overview(state: TaskState) -> str:
    latest = max((item.get("时间", "") for item in state.events), default="—")
    lines = [f"# 总览 · {state.meta['名称']}",
             _table(("项目", "内容"), [
                 ("课题", state.meta["名称"]), ("智能体", state.meta["智能体"]),
                 ("流程版本", state.flow["流程版本"]), ("最后更新", _short_time(latest)),
                 ("待办数", len(state.todo())), ("未关闭未解决项数", len(state.open_issues()))])]
    lines.extend(_flow_sections(state))
    lines.append(_version_lines(state))
    lines.append(_assignment_section(state))
    lines.append(_handoff_section(state))
    lines.extend(["## 待办", _table(("节点", "原因"),
                                 _todo_rows(state))])
    return "\n\n".join(lines) + "\n"


def render_issues(state: TaskState) -> str:
    issues = {}
    for event in sorted(state.events, key=lambda item: item["序号"]):
        if event.get("类型") != "未解决项":
            continue
        if event.get("动作") == "新增":
            issues[event["编号"]] = {**event, "状态": "未关闭", "处理": ""}
        elif event.get("动作") == "关闭" and event["编号"] in issues:
            issues[event["编号"]].update(状态="已关闭", 处理=event.get("处理", "") + "：" + event.get("原因", ""))
    ordered = sorted(issues.values(), key=lambda item: (item["状态"] == "已关闭", item["编号"]))
    rows = [(item.get("编号"), item.get("来源"), item.get("描述"), item.get("指标"),
             item.get("标准"), item.get("差值"), item["状态"], item["处理"]) for item in ordered]
    return "# 未解决项\n\n" + _table(("编号", "来源", "描述", "指标", "标准", "差值", "状态", "处理"), rows) + "\n"


def _index_name(state: TaskState, node: str) -> str | None:
    current = state.current(node)
    pending = bool(state.pending_triggers(node))
    if current == "跳过":
        name = "已跳过"
    elif isinstance(current, int):
        name = f"当前采用_第{current}版"
        if state.validity(node, current) == "过期":
            name += "_已过期"
    elif state.ledgers.get(node):
        name = "当前采用_无"
    else:
        return None
    return name + ("_待重做" if pending else "") + ".md"


def write_views(state: TaskState) -> None:
    (state.task_dir / "总览.md").write_text(render_overview(state), encoding="utf-8")
    (state.task_dir / "未解决项.md").write_text(render_issues(state), encoding="utf-8")
    for node in _ordered_nodes(state):
        directory = node_dir(state.task_dir, state.flow, node)
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if path.is_file() and _INDEX.fullmatch(path.name):
                path.unlink()
        name = _index_name(state, node)
        if name:
            adopted, validity, notes = _node_status(state, node)
            (directory / name).write_text(
                f"# {_node_label(state, node).strip()}\n\n当前采用：{adopted}\n\n有效性：{validity}\n\n过期原因及待重做来源：{notes}\n" + _history_table(state, node),
                encoding="utf-8")


def write_root_index(output_root: Path) -> None:
    lines = ["# 总索引"]
    output_root.mkdir(parents=True, exist_ok=True)
    for agent_dir in sorted(path for path in output_root.iterdir() if path.is_dir()):
        rows = []
        for task_dir in sorted(path for path in agent_dir.iterdir()
                               if path.is_dir() and path.name.startswith(("【课题】", "【临时】"))):
            try:
                state = load_task_state(task_dir)
                if not isinstance(state.flow.get("顺序"), list):
                    raise ValueError("流程定义缺少顺序")
                latest = max((item.get("时间", "") for item in state.events), default="—")
                rows.append((task_dir.name, len(state.todo()), len(state.open_issues()), _short_time(latest)))
            except (OSError, ValueError, KeyError, TypeError) as error:
                rows.append((task_dir.name, "错误", "错误", f"读取失败：{error}"))
        if rows:
            lines.extend([f"## {agent_dir.name}", _table(("课题", "当前待办数", "未关闭未解决项数", "最后事件时间"), rows)])
    (output_root / "总索引.md").write_text("\n\n".join(lines) + "\n", encoding="utf-8")
