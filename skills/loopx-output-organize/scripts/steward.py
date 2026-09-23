"""产出管家：创建课题、执行和版本，并维护三层台账。"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from ledger import (
    DONE_STATUSES, LEDGER_NAME, build_run_ledger, build_task_ledger,
    build_version_ledger, count_trace_steps, read_ledger, scan_artifacts,
    sha256_file,
    update_compare_index, write_ledger,
)
from outroot import (
    VERSION_SUBDIRS, next_run_number, next_version_number, parse_run_number,
    parse_version_number, resolve_output_root, run_dir_name, sanitize_name,
    task_dir_name, temp_dir_name, unique_dir, version_dir_name,
)


STATE_NAME = ".当前状态.json"  # 工具内部状态，不属于规范展示目录。
FINAL_STATUSES = ("成功", "部分完成", "失败")
SKILL_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def project_root():
    """从当前工作目录向上找 .git，作为产出落盘的项目根。

    必须以 cwd 为起点而不是脚本位置：skill 脚本装在 skill 仓库里，
    用户干活的项目是另一个目录，按脚本位置找会把所有产出都落到 skill 仓库。
    """
    cwd = Path.cwd().resolve()
    for path in (cwd, *cwd.parents):
        if (path / ".git").exists():
            return path
    return cwd


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def relative(root, path):
    return path.relative_to(root).as_posix()


def read_state(root):
    path = root / STATE_NAME
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def write_state(root, state):
    root.mkdir(parents=True, exist_ok=True)
    with (root / STATE_NAME).open("w", encoding="utf-8") as target:
        json.dump(state, target, ensure_ascii=False, indent=2)
        target.write("\n")


def task_dirs(root):
    if not root.is_dir():
        return []
    return sorted(path for path in root.iterdir() if path.is_dir()
                  and path.name.startswith(("【课题】", "【临时】")))


def find_task(root, name, temp=None):
    clean = sanitize_name(name)
    candidates = [root / (temp_dir_name(clean) if temp else task_dir_name(clean))]
    if temp is None:
        candidates.append(root / temp_dir_name(clean))
    return next((path for path in candidates if path.is_dir()), None)


def task_slug(root, name, explicit=None):
    """生成课题的标准 ID。

    优先用调用方给的英文 slug——标准 ID 会出现在 diff 命令和排查现场，
    q3-risk-review 比一串十六进制有用得多。没给时退回中文名的 UTF-8
    十六进制编码：可读性差，但合法、稳定，且能从 ID 无损还原出中文名。
    """
    if explicit:
        if not SKILL_SLUG.fullmatch(explicit):
            raise ValueError("--slug 必须是小写英文 slug，例如 q3-risk-review")
        slug = explicit
    else:
        slug = "task-" + name.encode("utf-8").hex()
    for path in task_dirs(root):
        ledger_path = path / LEDGER_NAME
        if ledger_path.is_file() and read_ledger(ledger_path).get("课题ID") == slug:
            raise ValueError(f"课题 ID 已由其它目录使用: {path}")
    return slug


FRONTMATTER_VERSION = re.compile(r"^\s{2,}version:\s*['\"]?([^'\"\s]+)", re.MULTILINE)


def resolve_skill_meta(args, skill_cn):
    """确定这一版是哪个版本的业务 skill 跑出来的。

    版本对比要回答「指标变化是提示词改动带来的还是输入变了」，
    而这只有在台账记下当时的 skill 版本和源文件摘要时才答得出来。
    --skill-file 指向业务 skill 的 SKILL.md 时自动提取；
    --skill-version 可显式覆盖；都没给才退回 unknown 占位。
    """
    version = getattr(args, "skill_version", None)
    digest = "0" * 64
    path = getattr(args, "skill_file", None)
    if path:
        source = Path(path).expanduser()
        if not source.is_file():
            raise ValueError(f"--skill-file 不存在: {path}")
        digest = sha256_file(source)
        if not version:
            matched = FRONTMATTER_VERSION.search(source.read_text(encoding="utf-8"))
            version = matched.group(1) if matched else None
    return {"名称": args.skill, "中文名": skill_cn,
            "skill版本": version or "unknown", "来源sha256": digest}


def task_begin(root, args):
    name = sanitize_name(args.name)
    task = find_task(root, name, args.temp)
    if task:
        data = read_ledger(task / LEDGER_NAME)
    else:
        task = root / (temp_dir_name(name) if args.temp else task_dir_name(name))
        slug = task_slug(root, name, getattr(args, "slug", None))
        task.mkdir(parents=True)
        (task / "版本对比").mkdir()
        goal = args.goal or "待补充"
        criteria = [args.criteria] if args.criteria else ["待补充"]
        (task / "课题说明.md").write_text(
            f"# {name}\n\n## 目标\n{goal}\n\n## 验收标准\n{criteria[0]}\n\n## 累计进展\n\n## 已尝试方案\n",
            encoding="utf-8",
        )
        data = build_task_ledger(
            slug, relative(root, task), slug, now(), "进行中", [], [],
            {"课题名slug映射": {name: slug}}, [], goal, criteria, [],
        )
        write_ledger(task / LEDGER_NAME, data)
    write_state(root, {"课题": relative(root, task), "执行": None})
    return {"课题目录": str(task.resolve()), "课题ID": data["课题ID"], "状态": data["状态"]}


def run_begin(root, args):
    task = find_task(root, args.task)
    if task is None:
        raise FileNotFoundError(f"课题不存在: {args.task}")
    task_data = read_ledger(task / LEDGER_NAME)
    number = next_run_number(task)
    run = unique_dir(task, run_dir_name(number, datetime.now().astimezone()))
    run.mkdir()
    for name in ("我的需求", "最终交付", "执行记录", "各环节产出"):
        (run / name).mkdir()
    (run / "本次说明.md").write_text("# 本次执行\n\n状态：进行中\n", encoding="utf-8")
    run_id = f"{task_data['课题ID']}/run-{number}"
    data = build_run_ledger(run_id, relative(root, run), task_data["课题ID"],
                            run_id, now(), "进行中", [], [], None, {}, [], [])
    write_ledger(run / LEDGER_NAME, data)
    task_data["累计执行列表"].append(run_id)
    task_data["children"].append(run_id)
    write_ledger(task / LEDGER_NAME, task_data)
    write_state(root, {"课题": relative(root, task), "执行": relative(root, run)})
    return {"执行目录": str(run.resolve()), "执行ID": run_id, "状态": "进行中"}


def current_run(root):
    state = read_state(root)
    if not state.get("课题") or not state.get("执行"):
        raise ValueError("没有当前执行，请先运行 run-begin")
    task = (root / state["课题"]).resolve()
    run = (root / state["执行"]).resolve()
    if not task.is_relative_to(root) or not run.parent == task or not run.is_dir():
        raise ValueError("当前执行状态无效")
    return task, run


def version_entries(task, skill_cn):
    entries = {}
    for run in task.iterdir():
        if not run.is_dir() or parse_run_number(run.name) is None:
            continue
        skill_dir = run / "各环节产出" / skill_cn
        if not skill_dir.is_dir():
            continue
        for path in skill_dir.iterdir():
            number = parse_version_number(path.name)
            if number is not None and path.is_dir():
                entries[number] = path
    return entries


def alloc(root, args):
    if not SKILL_SLUG.fullmatch(args.skill):
        raise ValueError("skill 必须是小写英文 slug")
    task, run = current_run(root)
    if read_ledger(run / LEDGER_NAME)["状态"] != "进行中":
        raise ValueError("当前执行已收尾")
    skill_cn = sanitize_name(args.skill_cn)
    number = next_version_number(task, skill_cn)
    entries = version_entries(task, skill_cn)
    baseline = None
    if args.baseline != "none":
        base_number = number - 1 if args.baseline == "latest" else int(args.baseline)
        if base_number > 0:
            baseline = entries.get(base_number)
            if baseline is None:
                raise ValueError(f"基线版本不存在: {base_number}")
    # --parent 指向调用方的版本目录时挂到它的「内部调用/」下，保留嵌套的从属关系；
    # 版本号仍按（课题, skill）统一计数，不随父 skill 重置，版本线才连得起来。
    parent_dir = getattr(args, "parent", None)
    if parent_dir:
        parent = Path(parent_dir).resolve()
        if not (parent / LEDGER_NAME).is_file():
            raise ValueError(f"--parent 不是有效的版本目录: {parent_dir}")
        version = parent / "内部调用" / skill_cn / version_dir_name(number)
    else:
        version = run / "各环节产出" / skill_cn / version_dir_name(number)
    version.mkdir(parents=True)
    for name in VERSION_SUBDIRS:
        (version / name).mkdir()
    (task / "版本对比" / skill_cn).mkdir(parents=True, exist_ok=True)
    run_data = read_ledger(run / LEDGER_NAME)
    task_id = run_data["课题ID"]
    version_id = f"{task_id}/{args.skill}/v{number}"
    inputs = []
    if baseline:
        inputs.append({"类型": "产物", "引用": read_ledger(baseline / LEDGER_NAME)["标准ID"], "角色": "基线"})
    skill = resolve_skill_meta(args, skill_cn)
    data = build_version_ledger(version_id, relative(root, version), task_id,
                                run_data["执行ID"], number, number - 1 or None,
                                skill, now(), "进行中", inputs, [], None, {}, [])
    write_ledger(version / LEDGER_NAME, data)
    if parent_dir:
        # 嵌套关系要能从台账查到，不能只体现在目录层级上。
        parent_ledger = Path(parent_dir).resolve() / LEDGER_NAME
        parent_data = read_ledger(parent_ledger)
        if version_id not in parent_data["children"]:
            parent_data["children"] = [*parent_data["children"], version_id]
            write_ledger(parent_ledger, parent_data)
    return {"目录": str(version.resolve()), "版本号": number, "标准ID": version_id,
            "基线目录": str(baseline.resolve()) if baseline else None,
            "env": {"SKILLFUSE_OUTPUT_DIR": str(version.resolve()),
                    "SKILLFUSE_BASELINE_DIR": str(baseline.resolve()) if baseline else None,
                    "SKILLFUSE_OUTPUT_VERSION": str(number)}}


def commit(root, args):
    version = Path(args.dir).resolve()
    if not version.is_relative_to(root) or not version.is_dir():
        raise ValueError("版本目录不在产出根内")
    old = read_ledger(version / LEDGER_NAME)
    if old["kind"] != "版本" or old["状态"] != "进行中":
        raise ValueError("版本不是进行中状态")
    if args.status in DONE_STATUSES and not args.primary:
        raise ValueError("完成态必须指定 --primary")
    metrics = json.loads(args.metrics) if args.metrics else {}
    if not isinstance(metrics, dict):
        raise ValueError("metrics 必须是 JSON 对象")
    artifacts = scan_artifacts(version, args.primary)
    trace = count_trace_steps(version)
    data = build_version_ledger(
        old["标准ID"], old["中文目录名"], old["课题ID"], old["执行ID"],
        old["版本号"], old["上一版版本号"], old["skill"], old["创建时间"],
        args.status, old["inputs"], artifacts, trace, metrics, old["children"],
    )
    task = root / Path(old["中文目录名"]).parts[0]
    write_ledger(version / LEDGER_NAME, data)
    update_compare_index(task, old["skill"]["中文名"], old["版本号"], version, args.status)
    return {"目录": str(version), "标准ID": old["标准ID"], "状态": args.status,
            "产物数": len(artifacts)}


def adopted_versions(run):
    selected = []
    output = run / "各环节产出"
    for skill_dir in sorted(output.iterdir()):
        if not skill_dir.is_dir():
            continue
        choices = []
        for version in skill_dir.iterdir():
            number = parse_version_number(version.name)
            if number is None or not (version / LEDGER_NAME).is_file():
                continue
            data = read_ledger(version / LEDGER_NAME)
            if data["状态"] in DONE_STATUSES:
                choices.append((number, data))
        if choices:
            selected.append(max(choices, key=lambda item: item[0])[1])
    return selected


def scan_run_artifacts(run, primary_rel):
    primary = Path(primary_rel) if primary_rel else None
    if primary and (primary.is_absolute() or ".." in primary.parts
                    or not (run / primary).is_file()):
        raise FileNotFoundError(primary_rel)
    artifacts = []
    # 执行目录还含各 skill 的独立台账，只收录执行层的交付和记录。
    for directory, category in (("最终交付", "报告"), ("执行记录", "执行记录")):
        for path in sorted((run / directory).rglob("*")):
            if path.is_file():
                rel = path.relative_to(run)
                artifacts.append({"相对路径": rel.as_posix(), "类型": category,
                                  "角色": "主交付物" if rel == primary else "附属",
                                  "sha256": sha256_file(path), "字节数": path.stat().st_size})
    if primary and not any(item["角色"] == "主交付物" for item in artifacts):
        raise ValueError("执行主交付物必须位于 最终交付/ 或 执行记录/")
    return artifacts


def run_finish(root, args):
    task, run = current_run(root)
    old = read_ledger(run / LEDGER_NAME)
    if old["状态"] != "进行中":
        raise ValueError("当前执行已收尾")
    status = args.status
    if status in DONE_STATUSES and not args.primary:
        raise ValueError("完成态必须指定 --primary")
    chosen = adopted_versions(run)
    steps = [{"顺序": i, "skill名称": data["skill"]["名称"],
              "最终采用版本ID": data["标准ID"]}
             for i, data in enumerate(chosen, 1)]
    artifacts = scan_run_artifacts(run, args.primary)
    trace = count_trace_steps(run)
    data = build_run_ledger(old["标准ID"], old["中文目录名"], old["课题ID"],
                            old["执行ID"], old["创建时间"], status, old["inputs"],
                            artifacts, trace, old["metrics"],
                            [item["标准ID"] for item in chosen], steps)
    lines = ["# 本次执行", "", f"状态：{status}", "", "## 最终采用版本"]
    lines.extend(f"{step['顺序']}. {step['skill名称']}：{step['最终采用版本ID']}" for step in steps)
    lines.extend(["", "## 结论", args.summary or "待补充", ""])
    write_ledger(run / LEDGER_NAME, data)
    (run / "本次说明.md").write_text("\n".join(lines), encoding="utf-8")
    return {"执行目录": str(run), "执行ID": old["执行ID"], "状态": status, "steps": steps}


def status(root):
    state = read_state(root)
    task_rel = state.get("课题")
    run_rel = state.get("执行")
    task = root / task_rel if task_rel else None
    versions = {}
    if task and task.is_dir():
        for run in task.iterdir():
            if not run.is_dir() or parse_run_number(run.name) is None:
                continue
            output = run / "各环节产出"
            if not output.is_dir():
                continue
            for skill in output.iterdir():
                if skill.is_dir():
                    numbers = [parse_version_number(p.name) for p in skill.iterdir() if p.is_dir()]
                    numbers = [n for n in numbers if n is not None]
                    if numbers:
                        versions[skill.name] = max(versions.get(skill.name, 0), *numbers)
    return {"当前课题": str(task.resolve()) if task and task.is_dir() else None,
            "当前执行": str((root / run_rel).resolve()) if run_rel and (root / run_rel).is_dir() else None,
            "各skill最新版本号": versions}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def parser():
    p = JsonArgumentParser(description="产出管家")
    p.add_argument("--output-root", help="产出根目录")
    commands = p.add_subparsers(dest="command", required=True)
    task = commands.add_parser("task-begin")
    task.add_argument("--name", required=True)
    task.add_argument("--slug", help="课题的英文标准 ID，如 q3-risk-review；不给则按中文名自动生成")
    task.add_argument("--goal")
    task.add_argument("--criteria")
    task.add_argument("--temp", action="store_true")
    run = commands.add_parser("run-begin")
    run.add_argument("--task", required=True)
    alloc_parser = commands.add_parser("alloc")
    alloc_parser.add_argument("--skill", required=True)
    alloc_parser.add_argument("--skill-cn", required=True)
    alloc_parser.add_argument("--baseline", default="latest")
    alloc_parser.add_argument("--parent", help="调用方的版本目录；给出时本版挂在其 内部调用/ 下")
    alloc_parser.add_argument("--skill-file", help="业务 skill 的 SKILL.md 路径，用于记录其版本与源文件摘要")
    alloc_parser.add_argument("--skill-version", help="业务 skill 版本，显式指定时覆盖从 --skill-file 读到的值")
    commit_parser = commands.add_parser("commit")
    commit_parser.add_argument("--dir", required=True)
    commit_parser.add_argument("--primary")
    commit_parser.add_argument("--status", required=True, choices=FINAL_STATUSES)
    commit_parser.add_argument("--metrics")
    finish = commands.add_parser("run-finish")
    finish.add_argument("--primary")
    finish.add_argument("--summary")
    finish.add_argument("--status", default="成功", choices=FINAL_STATUSES)
    commands.add_parser("status")
    return p


def main():
    try:
        args = parser().parse_args()
        root = resolve_output_root(args.output_root, project_root())
        handlers = {"task-begin": task_begin, "run-begin": run_begin,
                    "alloc": alloc, "commit": commit, "run-finish": run_finish,
                    "status": lambda output_root, _: status(output_root)}
        result = handlers[args.command](root, args)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
