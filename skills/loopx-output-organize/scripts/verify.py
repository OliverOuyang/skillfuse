"""只读检查 v2 课题、版本、引用及交接快照。"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import events
import flow
import layout
import ledger


READ_ERRORS = (OSError, UnicodeError, ValueError, TypeError, KeyError, AttributeError)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def issue(root, path, message, remedy, level="error"):
    return {"级别": level, "位置": path.relative_to(root).as_posix(),
            "说明": message, "怎么修": remedy}


def task_dirs(root):
    # 按目录发现课题，缺失元数据的课题也必须被检查。
    return sorted(path for path in root.glob("*/*") if path.is_dir()
                  and path.name.startswith(("【课题】", "【临时】")))


def select_tasks(root, selector):
    tasks = task_dirs(root)
    if selector is None:
        return tasks
    matches = []
    for task in tasks:
        if task.name == selector:
            matches.append(task)
            continue
        try:
            if ledger.read_json(task / layout.TASK_META).get("课题ID") == selector:
                matches.append(task)
        except READ_ERRORS:
            continue
    if len(matches) != 1:
        raise ValueError(f"课题匹配数量为 {len(matches)}：{selector}")
    return matches


def safe_path(directory, relative):
    if not isinstance(relative, str) or not relative:
        raise ValueError("缺少相对路径")
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"路径越界：{relative}")
    result = directory / path
    if not result.resolve().is_relative_to(directory.resolve()):
        raise ValueError(f"路径越界：{relative}")
    return result



def validate_frozen_node(identifier, node):
    layout.validate_node_id(identifier)
    required = set(flow.with_node(flow.implicit_flow(), "校验")["节点"]["校验"])
    if not isinstance(node, dict) or not required <= node.keys() or node["id"] != identifier:
        raise ValueError(f"节点 {identifier} 字段不完整或 id 不符")
    directory = node["目录"]
    if not isinstance(directory, list) or not directory or any(
            not isinstance(p, str) or layout.sanitize_name(p) != p for p in directory):
        raise ValueError(f"节点 {identifier} 目录无效")
    for key in ("门禁", "可跳过", "可外部交付", "待核对"):
        if type(node[key]) is not bool:
            raise ValueError(f"节点 {identifier} 的 {key} 必须为布尔值")
    for key in ("依赖", "可打回至", "可补证至", "门禁结论"):
        if not isinstance(node[key], list) or any(not isinstance(v, str) for v in node[key]):
            raise ValueError(f"节点 {identifier} 的 {key} 必须为字符串列表")
    if not isinstance(node["结论"], dict) or not isinstance(node["阶段"], str):
        raise ValueError(f"节点 {identifier} 结论或阶段无效")
    if not isinstance(node["名称"], str) or not node["名称"]:
        raise ValueError(f"节点 {identifier} 名称无效")

def validate_flow(data):
    required = {"schema_version", "流程", "流程版本", "顺序", "交接点", "已移出", "节点"}
    if not isinstance(data, dict) or not required <= data.keys() or data["schema_version"] != "2.0":
        raise ValueError("冻结流程缺少必填字段或 schema_version 无效")
    nodes = data["节点"]
    if not isinstance(nodes, dict) or not isinstance(data["交接点"], dict):
        raise ValueError("节点与交接点必须为对象")
    for key in ("顺序", "已移出"):
        values = data[key]
        if not isinstance(values, list) or any(not isinstance(v, str) or v not in nodes for v in values) or len(set(values)) != len(values):
            raise ValueError(f"{key} 无效")
    if set(data["顺序"]) & set(data["已移出"]) or set(nodes) != set(data["顺序"]) | set(data["已移出"]):
        raise ValueError("顺序、已移出与节点不一致")
    groups = defaultdict(list)
    directories = set()
    for identifier, node in nodes.items():
        validate_frozen_node(identifier, node)
        directory = tuple(node["目录"])
        if directory in directories:
            raise ValueError("节点目录重复")
        directories.add(directory)
        # 已移出的定义留作历史记录，不参与当前流程的依赖与交接规则。
        if identifier not in data["已移出"]:
            groups[node["阶段"]].append(node)
    # 冻结目录允许保留旧名称；只用还原的编写结构复核语义规则。
    implicit_stage = "校验分组"
    while implicit_stage in nodes or implicit_stage in groups:
        implicit_stage += "_"
    normalized = flow.normalize_flow({"流程": data["流程"], "流程版本": data["流程版本"],
                                     "分组": [{"id": stage or implicit_stage, "节点": items}
                                            for stage, items in groups.items()]})
    if data["交接点"] != normalized["交接点"]:
        raise ValueError("交接点与流程节点不一致")
    return data


def load_checked(root, path, validator):
    try:
        data = ledger.read_json(path)
        problems = validator(data)
        return data, [issue(root, path, str(p), "按 v2 契约修复文件") for p in problems]
    except READ_ERRORS as exc:
        return None, [issue(root, path, f"无法读取或校验：{exc}", "恢复合法的 UTF-8 JSON 文件")]


def load_flow(root, task):
    try:
        return validate_flow(ledger.read_json(task / layout.FLOW_FILE)), []
    except READ_ERRORS as exc:
        return None, [issue(root, task / layout.FLOW_FILE, f"流程定义无效：{exc}", "恢复合法的冻结流程定义")]


def version_dirs(directory):
    for child in sorted(directory.iterdir()):
        if not child.is_dir() or child.is_symlink() or child.name == layout.HANDOFF_DIR:
            continue
        if layout.parse_version_number(child.name) is not None:
            yield child
            nested = child / layout.NESTED_DIR
            if nested.is_dir():
                yield from version_dirs(nested)
        else:
            yield from version_dirs(child)


def check_artifacts(root, directory, data):
    problems, listed = [], set()
    records = data.get("artifacts")
    for item in records if isinstance(records, list) else []:
        try:
            relative = item["相对路径"]
            path = safe_path(directory, relative)
            if relative in listed or relative == layout.LEDGER_NAME or Path(relative).parts[0] == layout.NESTED_DIR:
                raise ValueError("产物路径重复或不属于本版产物")
            listed.add(relative)
            if ledger.sha256_file(path).lower() != str(item.get("sha256", "")).lower():
                problems.append(issue(root, path, "产物 sha256 与台账不符", "恢复原文件，合法变更请另建版本"))
            if path.stat().st_size != item.get("字节数"):
                problems.append(issue(root, path, "产物字节数与台账不符", "恢复原文件，合法变更请另建版本"))
        except READ_ERRORS as exc:
            problems.append(issue(root, directory / layout.LEDGER_NAME, f"产物无法核对：{exc}", "恢复产物并修正登记路径"))
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if relative.parts[0] == layout.NESTED_DIR or relative.as_posix() == layout.LEDGER_NAME:
            continue
        if path.is_file() and relative.as_posix() not in listed:
            problems.append(issue(root, path, "版本目录有未登记文件", "将文件纳入该版本 artifacts 并记录真实摘要"))
    return problems


def check_version(root, directory):
    data, problems = load_checked(root, directory / layout.LEDGER_NAME, ledger.validate_version_ledger)
    if not isinstance(data, dict):
        return data, problems
    if data.get("中文目录名") != directory.relative_to(root).as_posix():
        problems.append(issue(root, directory, "中文目录名与实际路径不符", "修正台账中文目录名"))
    if data.get("版本") != layout.parse_version_number(directory.name):
        problems.append(issue(root, directory, "台账版本与目录不符", "恢复对应版本目录或修正台账"))
    problems.extend(check_artifacts(root, directory, data))
    if data.get("执行状态") == "进行中":
        try:
            created = datetime.fromisoformat(data["创建时间"].replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - created > timedelta(hours=24):
                problems.append(issue(root, directory, "进行中超过 24 小时未提交", "核对执行进度后提交或记录失败", "warning"))
        except (ValueError, TypeError, KeyError):
            pass  # 时间格式错误由台账校验报告。
    return data, problems


def check_numbering(root, task, definition, directories):
    problems, parents = [], defaultdict(list)
    known = {layout.node_dir(task, definition, n) for n in definition["节点"]} if definition else set()
    for directory in directories:
        parents[directory.parent].append(layout.parse_version_number(directory.name))
    for parent, numbers in parents.items():
        if sorted(numbers) != list(range(1, max(numbers) + 1)):
            problems.append(issue(root, parent, "版本号不连续", "恢复缺失的历史版本目录"))
        if definition and layout.NESTED_DIR not in parent.relative_to(task).parts and parent not in known:
            problems.append(issue(root, parent, "目录对应的节点不在流程里", "核对冻结流程与节点目录", "warning"))
    return problems


def reference_path(root, task, reference):
    parsed = layout.parse_ref(reference)
    if parsed["课题"]:
        task = select_tasks(root, parsed["课题"])[0]
    if parsed["交接"] is not None:
        records, _ = events.read_events(task)
        if not any(item["类型"] == "交接" and item.get("编号") == parsed["交接"] for item in records):
            raise ValueError("交接不存在")
        return None
    if parsed["跳过"]:
        return None
    definition = ledger.read_json(task / layout.FLOW_FILE)
    path = safe_path(task, "/".join(definition["节点"][parsed["节点"]]["目录"]))
    path = path / layout.version_dir_name(parsed["版本"])
    for nested in parsed["嵌套"]:
        path = path / layout.NESTED_DIR / nested["节点"] / layout.version_dir_name(nested["版本"])
    return path


def check_reference(root, task, location, reference):
    try:
        path = reference_path(root, task, reference)
        if path is not None and not path.is_dir():
            raise ValueError("版本目录不存在")
        return []
    except READ_ERRORS as exc:
        return [issue(root, location, f"引用的版本不存在或无法解析：{reference}（{exc}）", "恢复被引用版本或修正引用")]


def event_references(event):
    references = []
    if event.get("类型") in ("分配", "提交", "采用"):
        node = event["节点"]
        references.append(node if "/" in node else layout.version_ref(node, event["版本"]))
    for key in ("来源", "基线", "继承"):
        if event.get(key):
            references.append(event[key])
    references.extend(ref for ref in event.get("清单", {}).values() if ref and ref != "跳过")
    return references


def check_events(root, task):
    path = task / events.LOG_NAME
    try:
        records, bad = events.read_events(task)
    except READ_ERRORS as exc:
        return [issue(root, path, f"事件日志无法读取：{exc}", "恢复事件日志")]
    problems = [issue(root, path, f"事件日志坏行：{p}", "恢复合法事件行") for p in bad]
    if [e["序号"] for e in records] != list(range(1, len(records) + 1)):
        problems.append(issue(root, path, "事件序号不连续或重复", "按真实历史恢复连续且唯一的序号"))
    seen = set()
    for event in records:
        try:
            kind = event.get("类型")
            if kind in ("打回", "补证", "交接") or kind == "未解决项" and event.get("动作") == "新增":
                key = (kind, event["编号"])
                if key in seen:
                    problems.append(issue(root, path, f"{kind}编号重复：{event['编号']}", "恢复该类事件独立且唯一的编号"))
                seen.add(key)
            for reference in event_references(event):
                problems.extend(check_reference(root, task, path, reference))
        except READ_ERRORS as exc:
            problems.append(issue(root, path, f"事件字段无效：{exc}", "按 v2 契约恢复事件字段"))
    return problems


def check_handoffs(root, task):
    problems = []
    for directory in sorted((task / layout.HANDOFF_DIR).glob("*")):
        if not directory.is_dir():
            continue
        path = directory / "清单.json"
        try:
            manifest = ledger.read_json(path)
            for item in manifest["版本"].values():
                if item["主交付物"] is None and item["sha256"] is None:
                    continue
                target = safe_path(directory, item["主交付物"])
                if ledger.sha256_file(target).lower() != str(item["sha256"]).lower():
                    problems.append(issue(root, target, "交接副本 sha256 与清单不符", "恢复交接时的主交付物副本"))
        except READ_ERRORS as exc:
            problems.append(issue(root, path, f"交接清单或副本无法核对：{exc}", "恢复清单及其交付物副本"))
    return problems


def check_task(root, task):
    _, problems = load_checked(root, task / layout.TASK_META, ledger.validate_task_meta)
    definition, errors = load_flow(root, task)
    problems.extend(errors)
    problems.extend(check_events(root, task))
    directories = list(version_dirs(task))
    problems.extend(check_numbering(root, task, definition, directories))
    for directory in directories:
        try:
            data, errors = check_version(root, directory)
            problems.extend(errors)
            inputs = data.get("输入", []) if isinstance(data, dict) else []
            for item in inputs if isinstance(inputs, list) else []:
                if isinstance(item, dict) and "引用" in item:
                    problems.extend(check_reference(root, task, directory / layout.LEDGER_NAME, item["引用"]))
        except READ_ERRORS as exc:
            problems.append(issue(root, directory, f"版本读取失败：{exc}", "修复该版本后重新体检"))
    problems.extend(check_handoffs(root, task))
    return problems, len(directories)


def main():
    problems, counts = [], {"课题": 0, "版本": 0}
    root = Path.cwd()
    try:
        parser = JsonArgumentParser(description="体检 v2 产出树")
        parser.add_argument("--output-root")
        parser.add_argument("--task")
        args = parser.parse_args()
        root = layout.resolve_output_root(args.output_root, layout.project_root())
        if not root.is_dir():
            raise ValueError(f"产出根不存在：{root}")
        for task in select_tasks(root, args.task):
            counts["课题"] += 1
            try:
                errors, number = check_task(root, task)
                problems.extend(errors)
                counts["版本"] += number
            except READ_ERRORS as exc:
                problems.append(issue(root, task, f"课题读取失败：{exc}", "修复该课题后重新体检"))
    except READ_ERRORS as exc:
        problems.append(issue(root, root, str(exc), "检查命令参数及产出根"))
    counts.update({level: sum(p["级别"] == level for p in problems) for level in ("error", "warning")})
    print(json.dumps({"问题": problems, "汇总": counts}, ensure_ascii=False))
    return 1 if counts["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
