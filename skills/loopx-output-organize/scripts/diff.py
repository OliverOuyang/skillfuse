"""对比同一课题和 skill 的两个产出版本。"""

import argparse
import json
import sys
from ledger import LEDGER_NAME, read_ledger, validate_ledger
from outroot import parse_run_number, parse_version_number, resolve_output_root
from steward import project_root


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def find_task(root, selector):
    matches = []
    for path in root.iterdir():
        if not path.is_dir() or not path.name.startswith(("【课题】", "【临时】")):
            continue
        if selector in (path.name, path.name[4:]):
            matches.append(path)
        elif (path / LEDGER_NAME).is_file():
            try:
                if read_ledger(path / LEDGER_NAME).get("课题ID") == selector:
                    matches.append(path)
            except (OSError, UnicodeError, ValueError, AttributeError):
                pass
    if len(matches) != 1:
        raise ValueError(f"课题匹配数量为 {len(matches)}：{selector}")
    return matches[0]


def walk_versions(output):
    if not output.is_dir():
        return
    for skill_dir in output.iterdir():
        if not skill_dir.is_dir():
            continue
        for version in skill_dir.iterdir():
            number = parse_version_number(version.name)
            if number is not None and version.is_dir():
                yield skill_dir.name, number, version
                yield from walk_versions(version / "内部调用")


def find_version(task, skill_cn, number):
    matches = []
    for run in task.iterdir():
        if run.is_dir() and parse_run_number(run.name) is not None:
            matches.extend(path for name, n, path in walk_versions(run / "各环节产出")
                           if name == skill_cn and n == number)
    if len(matches) != 1:
        raise ValueError(f"{skill_cn} 第{number}版匹配数量为 {len(matches)}")
    path = matches[0]
    data = read_ledger(path / LEDGER_NAME)
    errors = validate_ledger(data)
    if errors:
        raise ValueError(f"第{number}版台账无效：{'；'.join(errors)}")
    if data.get("kind") != "版本" or data.get("版本号") != number or data.get("skill", {}).get("中文名") != skill_cn:
        raise ValueError(f"第{number}版台账与目录不符")
    return data


def metrics_diff(before, after):
    result = {}
    for name in sorted(before.keys() | after.keys()):
        old, new = before.get(name), after.get(name)
        if name not in before:
            state = "新增"
        elif name not in after:
            state = "消失"
        else:
            state = "保留"
        # bool 虽属 Python 数值类型，这里仍按类别值处理。
        numeric = (type(old) in (int, float) and type(new) in (int, float))
        result[name] = {"变化": state, "from": old, "to": new,
                        "差值": new - old if state == "保留" and numeric else None}
    return result


def artifact_diff(before, after):
    old = {item["相对路径"]: item["sha256"] for item in before}
    new = {item["相对路径"]: item["sha256"] for item in after}
    common = old.keys() & new.keys()
    return {"新增文件": sorted(new.keys() - old.keys()),
            "删除文件": sorted(old.keys() - new.keys()),
            "sha256变化的文件": sorted(path for path in common if old[path].lower() != new[path].lower()),
            "未变化的文件数": sum(old[path].lower() == new[path].lower() for path in common)}


def trace_diff(before, after):
    old = before.get("执行记录") or {}
    new = after.get("执行记录") or {}
    return {key: {"from": old.get(key), "to": new.get(key),
                  "差值": new[key] - old[key] if key in old and key in new else None}
            for key in ("步骤数", "失败数")}


def compare(before, after):
    baseline_refs = [item.get("引用") for item in after["inputs"]
                     if item.get("类型") == "产物" and item.get("角色") == "基线"]
    is_baseline = before["标准ID"] in baseline_refs
    baseline = {"to版以from版为基线": is_baseline, "from版本ID": before["标准ID"],
                "to版基线引用": baseline_refs,
                "说明": "基线关系已确认" if is_baseline else "to 版未引用 from 版作为基线，对比结论不可靠"}
    artifacts = artifact_diff(before["artifacts"], after["artifacts"])
    metrics = metrics_diff(before["metrics"], after["metrics"])
    trace = trace_diff(before, after)
    summary = (f"第{before['版本号']}版（{before['状态']}，skill {before['skill']['skill版本']}）"
               f"对比第{after['版本号']}版（{after['状态']}，skill {after['skill']['skill版本']}）："
               f"新增 {len(artifacts['新增文件'])} 个文件，删除 {len(artifacts['删除文件'])} 个，"
               f"sha256 变化 {len(artifacts['sha256变化的文件'])} 个，未变化 {artifacts['未变化的文件数']} 个；"
               f"指标 {len(metrics)} 项。{baseline['说明']}。")
    return {"from": {key: before[key] for key in ("版本号", "状态", "创建时间")}
            | {"skill版本": before["skill"]["skill版本"]},
            "to": {key: after[key] for key in ("版本号", "状态", "创建时间")}
            | {"skill版本": after["skill"]["skill版本"]},
            "metrics": metrics, "产物清单": artifacts, "执行记录": trace,
            "基线关系": baseline, "文本摘要": summary}


def main():
    try:
        parser = JsonArgumentParser(description="对比两个产出版本")
        parser.add_argument("--output-root")
        parser.add_argument("--task", required=True)
        parser.add_argument("--skill-cn", required=True)
        parser.add_argument("--from", dest="from_version", type=int, required=True)
        parser.add_argument("--to", dest="to_version", type=int, required=True)
        args = parser.parse_args()
        if args.from_version < 1 or args.to_version < 1 or args.from_version == args.to_version:
            raise ValueError("--from 与 --to 必须是不同的正整数")
        root = resolve_output_root(args.output_root, project_root())
        task = find_task(root, args.task)
        before = find_version(task, args.skill_cn, args.from_version)
        after = find_version(task, args.skill_cn, args.to_version)
        if before["课题ID"] != after["课题ID"] or before["skill"]["名称"] != after["skill"]["名称"]:
            raise ValueError("两个版本的课题 ID 或 skill 名称不一致")
        print(json.dumps(compare(before, after), ensure_ascii=False))
        return 0
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
