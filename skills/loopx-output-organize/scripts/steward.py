"""产出管家 v2 命令入口。"""

import argparse
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sys

import events
import flow
import handoff as handoff_module
import layout
import ledger
import state
import views


FRONTMATTER_VERSION = re.compile(r"^\s{2,}version:\s*['\"]?([^'\"\s]+)", re.MULTILINE)
SKILL_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_skill_meta(args, skill_cn):
    version = args.skill_version
    digest = "0" * 64
    if args.skill_file:
        source = Path(args.skill_file).expanduser()
        if not source.is_file():
            raise ValueError(f"--skill-file 不存在: {args.skill_file}")
        digest = ledger.sha256_file(source)
        if not version:
            matched = FRONTMATTER_VERSION.search(source.read_text(encoding="utf-8"))
            version = matched.group(1) if matched else None
    return {"名称": args.skill, "中文名": skill_cn,
            "skill版本": version or "unknown", "来源sha256": digest}


def task_dirs(root):
    return sorted(path.parent for path in root.glob("*/*/课题.json")
                  if path.parent.name.startswith(("【课题】", "【临时】")))


def find_task(root, selector):
    if selector is None:
        selected = layout.read_state(root).get("课题")
        task = (root / selected).resolve() if selected else None
        if task and task.is_relative_to(root) and task in task_dirs(root):
            return task
        raise ValueError("没有当前课题，请先运行 task-begin")
    matches = [task for task in task_dirs(root) if task.name == selector
               or ledger.read_json(task / layout.TASK_META)["课题ID"] == selector]
    if len(matches) != 1:
        raise ValueError(f"课题匹配数量为 {len(matches)}: {selector}；候选: "
                         + "、".join(str(path) for path in matches))
    return matches[0]


def emit(task, type_, fields):
    return events.append_event(task, type_, fields, session=layout.session_id())


@contextmanager
def transaction(root):
    # 命令间串行化，避免失败回滚误删另一命令刚分配的版本。
    existed = root.exists()
    root.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(root, os.O_RDONLY)
    try:
        if events.fcntl is not None:
            events.fcntl.flock(descriptor, events.fcntl.LOCK_EX)
        paths = set(root.rglob("*"))
        names = {layout.LEDGER_NAME, layout.TASK_META, layout.FLOW_FILE,
                 layout.STATE_FILE, events.LOG_NAME}
        originals = {path: path.read_text(encoding="utf-8") for path in paths
                     if path.is_file() and path.name in names}
        try:
            yield
        except Exception:
            for path in sorted(set(root.rglob("*")) - paths, key=lambda p: len(p.parts), reverse=True):
                if path.is_dir() and not path.is_symlink():
                    path.rmdir()
                else:
                    path.unlink()
            for path, content in originals.items():
                if not path.exists() or path.read_text(encoding="utf-8") != content:
                    path.write_text(content, encoding="utf-8")
            if not existed:
                root.rmdir()
            raise
    finally:
        os.close(descriptor)


def task_begin(root, args):
    name = layout.sanitize_name(args.name)
    if args.slug is not None and not SKILL_SLUG.fullmatch(args.slug):
        raise ValueError("--slug 必须是小写英文 slug")
    source = flow.find_template(args.flow_template) if args.flow_template else args.flow
    definition = flow.normalize_flow(flow.load_flow_source(Path(source))) if source else flow.implicit_flow()
    task = layout.task_dir_path(root, definition["流程"], name, args.temp)
    if not task.exists():
        slug = args.slug or "task-" + name.encode("utf-8").hex()
        if any(ledger.read_json(path / layout.TASK_META)["课题ID"] == slug for path in task_dirs(root)):
            raise ValueError(f"课题 ID 已由其它目录使用: {slug}")
        meta = {"schema_version": "2.0", "课题ID": slug, "名称": name,
                "智能体": definition["流程"], "临时": args.temp, "创建时间": now(),
                "继承": args.inherit, "目标": args.goal or "待补充", "验收标准": args.criteria or []}
        problems = ledger.validate_task_meta(meta)
        if problems:
            raise ValueError("；".join(problems))
        task.mkdir(parents=True)
        write_json(task / layout.TASK_META, meta)
        write_json(task / layout.FLOW_FILE, definition)
        (task / "课题说明.md").write_text(
            f"# {name}\n\n" + (f"继承：{args.inherit}\n\n" if args.inherit else "")
            + f"## 目标\n{meta['目标']}\n\n## 验收标准\n"
            + "\n".join(f"- {item}" for item in meta["验收标准"]) + "\n", encoding="utf-8")
        emit(task, "开课题", {"流程": definition["流程"], "流程版本": definition["流程版本"], "继承": args.inherit})
    meta = ledger.read_json(task / layout.TASK_META)
    layout.write_state(root, {"智能体": meta["智能体"], "课题": task.relative_to(root).as_posix()})
    return {"课题目录": str(task), "课题ID": meta["课题ID"]}, task


def flow_check(root, args):
    definition = flow.normalize_flow(flow.load_flow_source(Path(args.flow)))
    return {"节点数": len(definition["节点"]), "交接点": definition["交接点"], "问题": []}, None


def flow_update(root, args):
    task = find_task(root, args.task)
    definition, summary = flow.update_flow(ledger.read_json(task / layout.FLOW_FILE),
                                           flow.load_flow_source(Path(args.flow)))
    write_json(task / layout.FLOW_FILE, definition)
    emit(task, "流程变更", {"摘要": summary, "原因": args.reason})
    return summary, task


def require_node(current, node):
    if node not in current.flow["节点"] or node in current.flow["已移出"]:
        raise ValueError(f"节点不存在或已移出: {node}")
    return current.flow["节点"][node]


def dependency_inputs(current, node, force):
    inputs = []
    for dependency in node["依赖"]:
        if dependency.startswith("交接:"):
            latest = current.latest_handoff(dependency[3:])
            reference = f"交接#{latest['编号']}" if latest else None
        else:
            selected = current.current(dependency)
            reference = (f"{dependency}@跳过" if selected == "跳过" else
                         layout.version_ref(dependency, selected) if isinstance(selected, int) else None)
        if reference:
            inputs.append({"引用": reference, "角色": "依赖"})
        elif not force:
            raise ValueError(f"依赖未就绪: {dependency}；需要 --force-deps")
    return inputs


def loop_definitions(current, node_id):
    return [node["循环"] for key, node in current.flow["节点"].items()
            if node["循环"] and (key == node_id or node["循环"]["与"] == node_id)]


def allocation_trigger(current, node_id, args):
    if args.external:
        return {"类型": "外部接收", "编号": None}
    pending = current.pending_triggers(node_id)
    if pending:
        earliest = min(pending, key=lambda item: item["序号"])
        return {"类型": earliest["类型"], "编号": earliest["编号"]}
    previous = bool(current.ledgers.get(node_id))
    return {"类型": "循环" if previous and loop_definitions(current, node_id)
            else "重跑" if previous else "首次", "编号": None}


def baseline_for(current, node_id, node, explicit):
    versions = current.ledgers.get(node_id, {})
    if explicit == "none" or (explicit is None and node["基线"] == "无"):
        return None
    if explicit is not None and "/" in explicit:
        parsed = layout.parse_ref(explicit)
        if not parsed["课题"] or parsed["版本"] is None or parsed["嵌套"]:
            raise ValueError("跨课题基线必须为 <课题ID>/<节点>@vN")
        baseline_directory(current.task_dir, explicit)
        return {"引用": explicit, "策略": node["基线"]}
    if explicit is not None:
        number = int(explicit)
        if number not in versions:
            raise ValueError(f"基线版本不存在: {number}")
    elif node["基线"] == "固定首版":
        number = 1 if 1 in versions else None
    else:
        number = max((n for n, data in versions.items() if data["执行状态"] in ledger.DONE_STATUSES), default=None)
    return {"引用": layout.version_ref(node_id, number), "策略": node["基线"]} if number else None


def allocation_plan(current, args):
    if args.parent:
        parent = Path(args.parent).resolve()
        if not parent.is_relative_to(current.task_dir):
            raise ValueError("父版本不属于当前课题")
        data = ledger.read_json(parent / layout.LEDGER_NAME)
        if ledger.validate_version_ledger(data) or "/" in data["引用"]:
            raise ValueError("父台账无效或超出契约支持的嵌套层级")
        node_id = args.skill_cn or args.node
        layout.validate_node_id(node_id)
        directory = parent / layout.NESTED_DIR / layout.sanitize_name(node_id)
        return node_id, directory, "skill", [], None, {"类型": "外部接收" if args.external else "首次", "编号": None}, data
    node_id = args.node
    if node_id not in current.flow["节点"] and current.flow["流程"] == layout.IMPLICIT_AGENT:
        node_id = args.skill_cn or node_id
        definition = flow.with_node(current.flow, node_id)
        if definition != current.flow:
            write_json(current.task_dir / layout.FLOW_FILE, definition)
            emit(current.task_dir, "流程变更", {"摘要": {"新增": [node_id], "移出": [], "改名": []}, "原因": "单独调用自动添加节点"})
        current = state.load_task_state(current.task_dir)
    node = require_node(current, node_id)
    for loop in loop_definitions(current, node_id):
        limit = loop.get("最大轮次")
        if limit is not None and current.rounds(node_id) >= limit and not args.override:
            raise ValueError("达到循环上限，需要 --override")
    if args.external and not node["可外部交付"] and not args.override:
        raise ValueError("节点不可外部交付，需要 --override")
    inputs = dependency_inputs(current, node, args.force_deps)
    baseline = baseline_for(current, node_id, node, args.baseline)
    if baseline:
        inputs.append({"引用": baseline["引用"], "角色": "基线"})
    return (node_id, layout.node_dir(current.task_dir, current.flow, node_id), node["执行方"],
            inputs, baseline, allocation_trigger(current, node_id, args), None)


def baseline_directory(task, reference):
    parsed = layout.parse_ref(reference)
    target = find_task(task.parent.parent, parsed["课题"]) if parsed["课题"] else task
    definition = ledger.read_json(target / layout.FLOW_FILE)
    if parsed["节点"] not in definition["节点"]:
        raise ValueError(f"基线节点不存在: {reference}")
    directory = layout.node_dir(target, definition, parsed["节点"]) / layout.version_dir_name(parsed["版本"])
    if not (directory / layout.LEDGER_NAME).is_file():
        raise ValueError(f"基线版本不存在: {reference}")
    return str(directory)


def rework_requirement(current, trigger):
    if trigger["类型"] not in ("打回", "补证"):
        return None
    event = next(item for item in current.events
                 if item["类型"] == trigger["类型"] and item.get("编号") == trigger["编号"])
    return {key: event[key] for key in ("类型", "编号", "来源", "原因")}


def allocation_result(task, directory, data, previous):
    baseline = data["基线"]
    baseline_dir = baseline_directory(task, baseline["引用"]) if baseline else None
    previous_dir = str(directory.parent / layout.version_dir_name(previous)) if previous else None
    return {"目录": str(directory), "节点": data["节点"], "版本": data["版本"], "引用": data["引用"],
            "输入": data["输入"], "触发": data["触发"], "基线目录": baseline_dir, "上一版目录": previous_dir,
            "env": {"SKILLFUSE_OUTPUT_DIR": str(directory), "SKILLFUSE_BASELINE_DIR": baseline_dir,
                    "SKILLFUSE_PREVIOUS_DIR": previous_dir, "SKILLFUSE_OUTPUT_VERSION": str(data["版本"]),
                    "SKILLFUSE_NODE": data["节点"], "SKILLFUSE_TASK_DIR": str(task)}}


def alloc(root, args):
    task = find_task(root, args.task)
    current = state.load_task_state(task)
    node_id, directory, executor, inputs, baseline, trigger, parent = allocation_plan(current, args)
    requirement = rework_requirement(current, trigger)
    if requirement:
        inputs = [*inputs, {"引用": requirement["来源"], "角色": "参考"}]
    skill = resolve_skill_meta(args, args.skill_cn or node_id) if args.skill else None
    if not args.skill and (args.skill_file or args.skill_version):
        raise ValueError("--skill-file / --skill-version 需要 --skill")
    previous = max(layout.list_versions(directory), default=None)
    number, version = layout.allocate_version_dir(directory)
    reference = layout.version_ref(node_id, number)
    if parent:
        reference = parent["引用"] + "/" + reference
    data = ledger.new_version_ledger(**{
        "引用": reference, "节点": node_id, "版本": number, "课题": current.meta["课题ID"],
        "中文目录名": version.relative_to(root).as_posix(), "执行方": executor,
        "外部团队": args.external, "skill": skill, "创建时间": now(), "会话": layout.session_id(),
        "输入": inputs, "基线": baseline, "触发": trigger})
    ledger.write_ledger(version / layout.LEDGER_NAME, data)
    if parent:
        ledger.write_ledger(Path(args.parent).resolve() / layout.LEDGER_NAME,
                            {**parent, "children": [*parent["children"], reference]})
    fields = {"节点": reference if parent else node_id, "版本": number, "触发": trigger, "基线": baseline["引用"] if baseline else None}
    # 人工放行原因只记事件，不增加契约限定的台账字段。
    confirmations = [reason for reason in (args.force_deps, args.override) if reason]
    if confirmations:
        fields["人工确认"] = "；".join(confirmations)
    emit(task, "分配", fields)
    return {**allocation_result(task, version, data, previous), "重做要求": requirement}, task


def review(current, data, args):
    nested = "/" in data["引用"]
    node = current.flow["节点"].get(data["节点"]) if not nested else None
    gate = bool(node and node["门禁"])
    if args.verdict and not gate:
        raise ValueError("非门禁节点不能带 --verdict")
    if gate and args.status in ledger.DONE_STATUSES and not args.verdict:
        raise ValueError("门禁完成态必须带 --verdict")
    if not args.verdict:
        return None
    verdict = flow.resolve_verdict(current.flow, data["节点"], args.verdict)
    targets = list(dict.fromkeys(args.to.split(","))) if args.to else []
    for target in targets:
        require_node(current, target)
    if verdict in ("整改后复验", "补证后再判"):
        if not targets:
            raise ValueError("整改或补证必须带 --to")
        allowed = node["可打回至"] if verdict == "整改后复验" else node["可补证至"]
        confirm = any(target not in allowed for target in targets)
        if verdict == "整改后复验":
            confirm |= any(flow.is_cross_stage(current.flow, data["节点"], target) for target in targets)
            confirm |= node["不达标处理"] == "带问题通过"
        if confirm and not args.confirm:
            raise ValueError("该目标或不达标处理需要 --confirm")
    if verdict == "带问题通过" and not args.issue:
        raise ValueError("带问题通过必须至少一个 --issue")
    return {"结论": verdict, "原文": args.verdict if args.verdict != verdict else None,
            "理由": args.reason or "", "目标": targets}


def review_events(current, data, args):
    verdict = data["评审结论"]
    result = []
    if verdict and verdict["结论"] in ("整改后复验", "补证后再判"):
        kind = "打回" if verdict["结论"] == "整改后复验" else "补证"
        fields = {"编号": events.next_number(current.events, kind), "来源": data["引用"],
                  "目标": verdict["目标"], "原因": args.reason or "", "人工确认": args.confirm}
        if kind == "打回":
            fields["跨阶段"] = any(flow.is_cross_stage(current.flow, data["节点"], target) for target in verdict["目标"])
        result.append(emit(current.task_dir, kind, fields))
    number = events.next_number(current.events, "未解决项")
    for offset, issue in enumerate(data["未解决项"]):
        result.append(emit(current.task_dir, "未解决项", {**issue, "编号": number + offset,
                           "动作": "新增", "来源": data["引用"]}))
    # 嵌套事件以完整引用隔离，避免同名调用改变流程节点的当前采用。
    event_node = data["引用"] if "/" in data["引用"] else data["节点"]
    result.append(emit(current.task_dir, "提交", {"节点": event_node, "版本": data["版本"],
                       "执行状态": data["执行状态"], "评审结论": verdict["结论"] if verdict else None}))
    return result


def round_fields(current, data, args):
    node = current.flow["节点"].get(data["节点"], {}) if "/" not in data["引用"] else {}
    required = (node.get("循环") or {}).get("每轮必记", [])
    record = json.loads(args.round) if args.round is not None else None
    if required and args.status in ledger.DONE_STATUSES:
        if not isinstance(record, dict):
            raise ValueError("完成态必须提供 --round 轮次记录")
        missing = [key for key in required if key not in record]
        if missing:
            raise ValueError("轮次记录缺少必记项：" + "、".join(missing))
    return {"轮次记录": record} if args.round is not None else {}


def commit(root, args):
    task = find_task(root, args.task)
    directory = Path(args.dir).resolve()
    if not directory.is_relative_to(task):
        raise ValueError("版本目录不属于当前课题")
    current = state.load_task_state(task)
    old = ledger.read_json(directory / layout.LEDGER_NAME)
    if old["执行状态"] != "进行中":
        raise ValueError("版本不是进行中状态")
    verdict = review(current, old, args)
    issues = [json.loads(item) for item in args.issue]
    issues = [{"指标": "", "标准": "", "差值": "", **item} for item in issues]
    trace = ledger.count_trace_steps(directory)
    fields = {"执行状态": args.status, "完成时间": now(), "评审结论": verdict,
              "未解决项": issues, "metrics": json.loads(args.metrics) if args.metrics else {},
              "artifacts": ledger.scan_artifacts(directory, args.primary)}
    if trace:
        fields["执行记录"] = {key: trace[key] for key in ("路径", "步骤数", "失败数")}
    fields.update(round_fields(current, old, args))
    data = ledger.finalize_version_ledger(old, **fields)
    ledger.write_ledger(directory / layout.LEDGER_NAME, data)
    emitted = review_events(current, data, args)
    nested = "/" in data["引用"]
    validity = (args.status if args.status == "失败" else "当前采用") if nested else state.load_task_state(task).validity(data["节点"], data["版本"])
    next_steps = []
    if verdict:
        if verdict["结论"] in ("整改后复验", "补证后再判"):
            next_steps = verdict["目标"]
        elif verdict["结论"] in ("通过", "带问题通过") and current.flow["节点"][data["节点"]]["交接"]:
            next_steps = [f"handoff --node {data['节点']}"]
    result = {"引用": data["引用"], "执行状态": data["执行状态"], "评审结论": verdict,
              "有效性": validity, "事件": [{"类型": item["类型"], "编号": item.get("编号")} for item in emitted], "下一步": next_steps}
    if trace and trace["坏行数"]:
        result["warning"] = [f"执行记录含 {trace['坏行数']} 个坏行"]
    return result, task


def adopt(root, args):
    task = find_task(root, args.task)
    current = state.load_task_state(task)
    require_node(current, args.node)
    data = current.ledgers.get(args.node, {}).get(args.version)
    if not data or data["执行状态"] not in ledger.DONE_STATUSES:
        raise ValueError("采用版本必须存在且为完成态")
    return emit(task, "采用", {"节点": args.node, "版本": args.version, "原因": args.reason}), task


def skip(root, args):
    task = find_task(root, args.task)
    current = state.load_task_state(task)
    node = require_node(current, args.node)
    if not node["可跳过"] and not args.confirm:
        raise ValueError("节点不可跳过，需要 --confirm")
    layout.node_dir(task, current.flow, args.node).mkdir(parents=True, exist_ok=True)
    return emit(task, "跳过", {"节点": args.node, "原因": args.reason, "人工确认": args.confirm}), task


def handoff(root, args):
    task = find_task(root, args.task)
    result = handoff_module.create_handoff(state.load_task_state(task), args.node,
                 session=layout.session_id(), confirm=args.confirm, now=datetime.now().astimezone())
    return result, task


def issue_close(root, args):
    task = find_task(root, args.task)
    if args.id not in [item["编号"] for item in state.load_task_state(task).open_issues()]:
        raise ValueError("未解决项不存在或已关闭")
    return emit(task, "未解决项", {"编号": args.id, "动作": "关闭", "处理": args.resolution, "原因": args.reason}), task


def status(root, args):
    task = find_task(root, args.task)
    current = state.load_task_state(task)
    nodes = {}
    if args.node:
        require_node(current, args.node)
    for node in ([args.node] if args.node else current.flow["节点"]):
        selected = current.current(node)
        nodes[node] = {"当前采用": selected, "有效性": current.validity(node, selected) if isinstance(selected, int) else selected}
    if args.node:
        reason = next((item["原因"] for item in reversed(current.events)
                       if item["类型"] == "采用" and item["节点"] == args.node), None)
        nodes[args.node].update({"版本历史": views._version_history(current, args.node), "采用原因": reason})
    return {"当前课题": str(task), "节点": nodes, "待办": current.todo(), "未关闭未解决项": current.open_issues()}, task


class ArgumentError(ValueError):
    pass


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ArgumentError(message)


def parser():
    result = JsonArgumentParser(description="产出管家 v2")
    result.add_argument("--output-root")
    commands = result.add_subparsers(dest="command", required=True)
    specs = {
        "task-begin": ("name",), "flow-check": ("flow",), "flow-update": ("flow", "reason"),
        "alloc": ("node",), "commit": ("dir", "status"), "adopt": ("node", "version", "reason"),
        "skip": ("node", "reason"), "handoff": ("node",),
        "issue-close": ("id", "resolution", "reason"), "status": ()}
    optional = {
        "task-begin": ("slug", "goal", "inherit"), "alloc": ("skill", "skill-cn", "skill-file", "skill-version", "baseline", "parent", "external", "override", "force-deps"),
        "commit": ("primary", "metrics", "verdict", "reason", "to", "confirm", "round"),
        "status": ("node",),
        "skip": ("confirm",), "handoff": ("confirm",)}
    for name, required in specs.items():
        command = commands.add_parser(name)
        command.add_argument("--output-root", default=argparse.SUPPRESS)
        if name not in ("task-begin", "flow-check"):
            command.add_argument("--task")
        for field in required + optional.get(name, ()):
            options = {"required": field in required}
            if field in ("version", "id"):
                options["type"] = int
            if field == "status":
                options["choices"] = (*ledger.DONE_STATUSES, "失败")
            if field == "resolution":
                options["choices"] = ("接受", "已解决", "后续处理")
            command.add_argument("--" + field, **options)
        if name == "task-begin":
            group = command.add_mutually_exclusive_group()
            group.add_argument("--flow")
            group.add_argument("--flow-template")
            command.add_argument("--temp", action="store_true")
            command.add_argument("--criteria", action="append")
        if name == "commit":
            command.add_argument("--issue", action="append", default=[])
    return result


def refresh(root, task, result):
    for callback in (lambda: views.write_views(state.load_task_state(task)), lambda: views.write_root_index(root)):
        try:
            callback()
        except Exception as error:
            result.setdefault("warning", []).append(f"视图刷新失败: {error}")


def main():
    try:
        args = parser().parse_args()
        root = layout.resolve_output_root(args.output_root, layout.project_root())
        handler = globals()[args.command.replace("-", "_")]
        if args.command == "flow-check":
            result, task = handler(root, args)
        else:
            with transaction(root):
                result, task = handler(root, args)
            refresh(root, task, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2 if isinstance(error, ArgumentError) else 1


if __name__ == "__main__":
    sys.exit(main())
