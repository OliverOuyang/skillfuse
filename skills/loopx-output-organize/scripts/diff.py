"""对比 v2 节点版本，支持同一产出根内的跨课题对比。"""

from __future__ import annotations

import json
import sys

import layout
import ledger
from verify import JsonArgumentParser, READ_ERRORS, safe_path, select_tasks, validate_flow


def find_task(root, selector):
    if selector is not None:
        return select_tasks(root, selector)[0]
    selected = layout.read_state(root).get("课题")
    if selected:
        task = safe_path(root, selected)
        if task.is_dir():
            return task
    raise ValueError("没有当前课题，请指定 --task")


def find_version(task, node_id, number):
    definition = validate_flow(ledger.read_json(task / layout.FLOW_FILE))
    directory = layout.node_dir(task, definition, node_id) / layout.version_dir_name(number)
    data = ledger.read_json(directory / layout.LEDGER_NAME)
    problems = ledger.validate_version_ledger(data)
    if problems:
        raise ValueError("台账无效：" + "；".join(problems))
    if data["节点"] != node_id or data["版本"] != number:
        raise ValueError("台账与节点版本目录不符")
    return data


def metrics_diff(before, after):
    result = {}
    for name in sorted(before.keys() | after.keys()):
        old, new = before.get(name), after.get(name)
        change = "新增" if name not in before else "消失" if name not in after else "保留"
        # 布尔值表示类别，不按 Python 的整数子类计算差值。
        numeric = type(old) in (int, float) and type(new) in (int, float)
        result[name] = {"变化": change, "from": old, "to": new,
                        "差值": round(new - old, 6) if change == "保留" and numeric else None}
    return result


def artifact_diff(before, after):
    old = {item["相对路径"]: item["sha256"].lower() for item in before}
    new = {item["相对路径"]: item["sha256"].lower() for item in after}
    common = old.keys() & new.keys()
    return {"新增文件": sorted(new.keys() - old.keys()),
            "删除文件": sorted(old.keys() - new.keys()),
            "sha256变化的文件": sorted(path for path in common if old[path] != new[path]),
            "未变化的文件数": sum(old[path] == new[path] for path in common)}


def trace_diff(before, after):
    old, new = before.get("执行记录") or {}, after.get("执行记录") or {}
    return {key: {"from": old.get(key), "to": new.get(key),
                  "差值": new[key] - old[key] if key in old and key in new else None}
            for key in ("步骤数", "失败数")}


def baseline_relation(before, after):
    cross_task = before["课题"] != after["课题"]
    reference = (after.get("基线") or {}).get("引用")
    expected = before["课题"] + "/" + before["引用"]
    is_baseline = reference == expected or not cross_task and reference == before["引用"]
    description = "基线关系已确认" if is_baseline else "to 版未以 from 版为基线，对比结论可能不可靠"
    if cross_task:
        description = f"跨课题对比：{before['课题']} → {after['课题']}；" + description
    return {"to版以from版为基线": is_baseline,
            "from版本ID": expected if cross_task else before["引用"],
            "to版基线引用": [reference] if reference else [], "说明": description}


def version_summary(data):
    return {**{key: data[key] for key in ("版本", "执行状态", "触发", "评审结论", "创建时间")},
            "skill版本": (data.get("skill") or {}).get("skill版本")}


def compare(before, after):
    artifacts = artifact_diff(before["artifacts"], after["artifacts"])
    metrics = metrics_diff(before["metrics"], after["metrics"])
    trace = trace_diff(before, after)
    baseline = baseline_relation(before, after)
    summary = (f"{before['课题']}/{before['引用']}（{before['执行状态']}）对比 "
               f"{after['课题']}/{after['引用']}（{after['执行状态']}）："
               f"新增 {len(artifacts['新增文件'])} 个文件，删除 {len(artifacts['删除文件'])} 个，"
               f"sha256 变化 {len(artifacts['sha256变化的文件'])} 个，"
               f"未变化 {artifacts['未变化的文件数']} 个；指标 {len(metrics)} 项。{baseline['说明']}。")
    return {"from": version_summary(before), "to": version_summary(after), "metrics": metrics,
            "产物清单": artifacts, "执行记录": trace, "基线关系": baseline, "文本摘要": summary}


def main():
    try:
        parser = JsonArgumentParser(description="对比 v2 节点的两个版本")
        parser.add_argument("--output-root")
        parser.add_argument("--task")
        parser.add_argument("--from-task")
        parser.add_argument("--node", required=True)
        parser.add_argument("--from", dest="from_version", type=int, required=True)
        parser.add_argument("--to", dest="to_version", type=int, required=True)
        args = parser.parse_args()
        if args.from_version < 1 or args.to_version < 1:
            raise ValueError("--from 与 --to 必须是正整数")
        root = layout.resolve_output_root(args.output_root, layout.project_root())
        task = find_task(root, args.task)
        source = find_task(root, args.from_task) if args.from_task else task
        before = find_version(source, args.node, args.from_version)
        after = find_version(task, args.node, args.to_version)
        print(json.dumps(compare(before, after), ensure_ascii=False))
        return 0
    except READ_ERRORS as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
