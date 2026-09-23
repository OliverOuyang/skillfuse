"""检查产出树的版本台账、文件和版本索引。"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

from ledger import NESTED_DIR, DONE_STATUSES, LEDGER_NAME, read_ledger, sha256_file, validate_ledger
from outroot import VERSION_SUBDIRS, parse_run_number, parse_version_number, resolve_output_root
from steward import project_root


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def issue(issues, root, path, message, remedy, level="error"):
    issues.append({"级别": level, "位置": path.relative_to(root).as_posix(),
                   "说明": message, "怎么修": remedy})


def load_ledger(root, directory, issues, kind):
    path = directory / LEDGER_NAME
    if not path.is_file():
        issue(issues, root, directory, f"缺少{kind}台账", f"恢复 {LEDGER_NAME} 并补齐真实记录")
        return None
    try:
        data = read_ledger(path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        issue(issues, root, path, f"无法读取台账：{exc}", "修复为 UTF-8 JSON 台账")
        return None
    errors = validate_ledger(data)
    for error in errors:
        issue(issues, root, path, f"台账无效：{error}", "按产出台账 schema 修正字段")
    if isinstance(data, dict):
        if data.get("kind") != kind:
            issue(issues, root, path, f"kind 应为{kind}", "修正台账 kind")
        actual = directory.relative_to(root).as_posix()
        if data.get("中文目录名") != actual:
            issue(issues, root, path, f"中文目录名与实际路径不符：{actual}", "将中文目录名改为实际相对路径")
        return data
    return None


def check_artifacts(root, directory, data, issues):
    records = data.get("artifacts")
    if not isinstance(records, list):
        return
    listed = set()
    for item in records:
        if not isinstance(item, dict) or not isinstance(item.get("相对路径"), str):
            continue
        rel = Path(item["相对路径"])
        if rel.is_absolute() or ".." in rel.parts or rel.as_posix() == LEDGER_NAME:
            issue(issues, root, directory / LEDGER_NAME, "产物路径无效", "改为版本目录内的相对文件路径")
            continue
        if rel.as_posix() in listed:
            issue(issues, root, directory / LEDGER_NAME, f"产物重复记账：{rel}", "保留一条真实记录")
        listed.add(rel.as_posix())
        path = directory / rel
        if not path.is_file() or not path.resolve().is_relative_to(directory.resolve()):
            issue(issues, root, path, "台账产物不存在或指向目录外", "恢复原文件，或修正台账并重新生成摘要")
            continue
        try:
            digest = sha256_file(path)
            size = path.stat().st_size
        except OSError as exc:
            issue(issues, root, path, f"无法读取产物：{exc}", "恢复文件读取权限后重试")
            continue
        if digest.lower() != str(item.get("sha256", "")).lower():
            issue(issues, root, path, "sha256 与台账不符，文件可能被篡改或替换", "恢复原文件；若是合法新产出，请另建版本并重新记账")
        if size != item.get("字节数"):
            issue(issues, root, path, "字节数与台账不符", "恢复原文件；若是合法新产出，请另建版本并重新记账")
    # 只核对本版自己的文件：内部调用/ 下是嵌套子 skill 的独立版本树，
    # 由 version_dirs 单独遍历并对照它自己的台账，父台账不重复记账。
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path != directory / LEDGER_NAME:
            relative = path.relative_to(directory)
            if NESTED_DIR in relative.parts:
                continue
            rel = relative.as_posix()
            if rel not in listed:
                issue(issues, root, path, "文件未记入台账", "将文件纳入该版本的 artifacts 并记录真实摘要")


def version_dirs(output):
    if not output.is_dir():
        return
    for skill_dir in sorted(output.iterdir()):
        if not skill_dir.is_dir():
            continue
        for directory in sorted(skill_dir.iterdir()):
            number = parse_version_number(directory.name)
            if number is None or not directory.is_dir():
                continue
            yield skill_dir.name, number, directory
            yield from version_dirs(directory / "内部调用")


def select_tasks(root, selector):
    tasks = sorted(path for path in root.iterdir() if path.is_dir()
                   and path.name.startswith(("【课题】", "【临时】")))
    if selector is None:
        return tasks
    matches = []
    for task in tasks:
        if selector in (task.name, task.name[4:]):
            matches.append(task)
        elif (task / LEDGER_NAME).is_file():
            try:
                if read_ledger(task / LEDGER_NAME).get("课题ID") == selector:
                    matches.append(task)
            except (OSError, UnicodeError, ValueError, AttributeError):
                pass
    if len(matches) != 1:
        raise ValueError(f"课题匹配数量为 {len(matches)}：{selector}")
    return matches


def check_indexes(root, task, versions, issues):
    index_root = task / "版本对比"
    for skill_cn, numbered in versions.items():
        committed = {n: pair for n, pair in numbered.items()
                     if pair[1] is not None and pair[1].get("状态") != "进行中"}
        index_dir = index_root / skill_cn
        for number, (directory, data) in committed.items():
            index = index_dir / f"第{number}版"
            check_index(root, task, index, number, directory, data, issues)
        if committed:
            number = max(committed)
            directory, data = committed[number]
            check_index(root, task, index_dir / "最新版", number, directory, data, issues)
        if index_dir.is_dir():
            for index in index_dir.iterdir():
                number = parse_version_number(index.name)
                if number is not None and number not in numbered:
                    issue(issues, root, index, "索引没有对应的版本目录", "恢复版本目录或清理错误索引")
    if index_root.is_dir():
        for skill_dir in index_root.iterdir():
            if skill_dir.is_dir() and skill_dir.name not in versions:
                issue(issues, root, skill_dir, "索引 skill 没有对应的版本目录", "恢复版本目录或清理错误索引")


def check_index(root, task, index, number, directory, data, issues):
    if not index.is_file():
        issue(issues, root, index, "缺少版本对比索引", "按版本台账重建索引")
        return
    try:
        with index.open("r", encoding="utf-8") as source:
            entry = json.load(source)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        issue(issues, root, index, f"索引无法读取：{exc}", "修复为 UTF-8 JSON 索引")
        return
    expected = directory.relative_to(task).as_posix()
    if not isinstance(entry, dict) or entry.get("版本号") != number or entry.get("相对路径") != expected or entry.get("状态") != data.get("状态"):
        issue(issues, root, index, f"索引与版本目录或台账不一致，应指向第{number}版 {expected}", "按实际版本目录和台账状态重建索引")
    target = entry.get("相对路径") if isinstance(entry, dict) else None
    if not isinstance(target, str) or not (task / target).is_dir() or not (task / target).resolve().is_relative_to(task.resolve()):
        issue(issues, root, index, "索引指向的目录不存在或越出课题", "修正相对路径并恢复目标目录")


def check_task(root, task, issues, counts):
    task_data = load_ledger(root, task, issues, "课题")
    counts["课题"] += 1
    versions = defaultdict(dict)
    id_to_version = {}
    all_data = []
    for run in sorted(task.iterdir()):
        if not run.is_dir() or parse_run_number(run.name) is None:
            continue
        counts["执行"] += 1
        load_ledger(root, run, issues, "执行")
        for skill_cn, number, directory in version_dirs(run / "各环节产出"):
            counts["版本"] += 1
            data = load_ledger(root, directory, issues, "版本")
            if number in versions[skill_cn]:
                issue(issues, root, directory, f"{skill_cn} 第{number}版重复", "保留历史并为重跑分配新版本号")
            versions[skill_cn][number] = (directory, data)
            for subdir in VERSION_SUBDIRS:
                if not (directory / subdir).is_dir():
                    issue(issues, root, directory / subdir, "缺少版本固定分区", "恢复该目录")
            if data is None:
                continue
            all_data.append((directory, data))
            if data.get("版本号") != number:
                issue(issues, root, directory / LEDGER_NAME, "台账版本号与目录名不符", "修正台账与版本索引")
            skill = data.get("skill")
            if not isinstance(skill, dict) or skill.get("中文名") != skill_cn:
                issue(issues, root, directory / LEDGER_NAME, "skill 中文名与目录名不符", "修正 skill.中文名")
            if task_data and data.get("课题ID") != task_data.get("课题ID"):
                issue(issues, root, directory / LEDGER_NAME, "课题ID 与所在课题不符", "修正课题关联")
            if data.get("状态") in DONE_STATUSES:
                artifacts = data.get("artifacts")
                if not isinstance(artifacts, list) or sum(item.get("角色") == "主交付物" for item in artifacts if isinstance(item, dict)) != 1:
                    issue(issues, root, directory / LEDGER_NAME, "完成态缺少唯一主交付物", "指定一项真实的主交付物")
                if not isinstance(data.get("执行记录"), dict):
                    issue(issues, root, directory / LEDGER_NAME, "完成态缺少执行记录", "补齐执行记录 JSONL 及台账引用")
            check_artifacts(root, directory, data, issues)
            standard_id = data.get("标准ID")
            if isinstance(standard_id, str):
                id_to_version[standard_id] = directory
    for skill_cn, numbered in versions.items():
        numbers = sorted(numbered)
        for missing in sorted(set(range(1, numbers[-1] + 1)) - set(numbers)):
            issue(issues, root, task, f"{skill_cn} 缺少第{missing}版，版本号不连续", "恢复缺失版本目录和台账")
        for number, (directory, data) in numbered.items():
            if data and data.get("上一版版本号") != (number - 1 or None):
                issue(issues, root, directory / LEDGER_NAME, "上一版版本号回指错误", "改为紧邻上一版的版本号")
    check_indexes(root, task, versions, issues)
    for directory, data in all_data:
        inputs = data.get("inputs")
        for item in inputs if isinstance(inputs, list) else []:
            if isinstance(item, dict) and item.get("类型") == "产物" and item.get("角色") in ("基线", "上游"):
                if item.get("引用") not in id_to_version:
                    issue(issues, root, directory / LEDGER_NAME, f"{item['角色']}引用的版本不存在：{item.get('引用')}", "修正引用 ID 或恢复被引用版本")


def main():
    try:
        parser = JsonArgumentParser(description="体检产出树")
        parser.add_argument("--output-root")
        parser.add_argument("--task")
        args = parser.parse_args()
        root = resolve_output_root(args.output_root, project_root())
        if not root.is_dir():
            raise FileNotFoundError(f"产出根不存在：{root}")
        issues = []
        counts = {"课题": 0, "执行": 0, "版本": 0}
        for task in select_tasks(root, args.task):
            check_task(root, task, issues, counts)
        counts.update({"error": sum(i["级别"] == "error" for i in issues),
                       "warning": sum(i["级别"] == "warning" for i in issues)})
        print(json.dumps({"问题": issues, "汇总": counts}, ensure_ascii=False))
        return 1 if counts["error"] else 0
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
