"""版本台账的构造、校验和产物索引。"""

from __future__ import annotations

import copy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

from flow import EXECUTORS, GENERIC_VERDICTS
from layout import LEDGER_NAME, NESTED_DIR, VERSION_SUBDIRS, validate_node_id


SCHEMA_VERSION = "2.0"
STATUSES = ("进行中", "成功", "部分完成", "失败")
DONE_STATUSES = ("成功", "部分完成")
TRACE_REQUIRED = ("skill", "代码", "智能体")
TRIGGER_TYPES = ("首次", "打回", "补证", "循环", "外部接收", "重跑")

_FIELDS = {"schema_version", "引用", "节点", "版本", "课题", "中文目录名", "执行方",
           "外部团队", "skill", "创建时间", "完成时间", "执行状态", "触发", "输入",
           "基线", "评审结论", "未解决项", "artifacts", "metrics", "children", "会话"}
_ARTIFACT_FIELDS = {"相对路径", "类型", "角色", "sha256", "字节数"}
_SHA256 = re.compile(r"[a-fA-F0-9]{64}\Z")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_REF = re.compile(r"[^/@#:\s\x00-\x1f\x7f]+@v[1-9][0-9]*(?:/[^/@#:\s\x00-\x1f\x7f]+@v[1-9][0-9]*)?\Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan_artifacts(version_dir: Path, primary_rel: str | None) -> list[dict]:
    primary = Path(primary_rel) if primary_rel else None
    if primary is not None and (primary.is_absolute() or ".." in primary.parts
                                or not (version_dir / primary).is_file()):
        raise FileNotFoundError(primary_rel)
    artifacts = []
    for path in sorted(version_dir.rglob("*")):
        if not path.is_file() or path == version_dir / LEDGER_NAME:
            continue
        relative = path.relative_to(version_dir)
        category = relative.parts[0]
        # 子版本独立记账，父版本只收四区中的文件。
        if category == NESTED_DIR:
            continue
        if category not in VERSION_SUBDIRS:
            raise ValueError(f"无法判定产物类型: {relative.as_posix()}")
        artifacts.append({"相对路径": relative.as_posix(), "类型": category,
                          "角色": "主交付物" if relative == primary else "附属",
                          "sha256": sha256_file(path), "字节数": path.stat().st_size})
    return artifacts


def count_trace_steps(version_dir: Path) -> dict | None:
    files = sorted(path for path in (version_dir / "执行记录").rglob("*.jsonl")
                   if NESTED_DIR not in path.relative_to(version_dir).parts)
    if not files:
        return None
    result = {"路径": files[0].relative_to(version_dir).as_posix(),
              "步骤数": 0, "失败数": 0, "坏行数": 0}
    for path in files:
        with path.open("r", encoding="utf-8") as source:
            for line in source:
                try:
                    step = json.loads(line)
                except json.JSONDecodeError:
                    result["坏行数"] += 1
                    continue
                result["步骤数"] += 1
                if isinstance(step, dict) and step.get("status") == "fail":
                    result["失败数"] += 1
    return result


def new_version_ledger(**fields) -> dict:
    data = {"schema_version": SCHEMA_VERSION, "外部团队": None, "skill": None,
            "完成时间": None, "执行状态": "进行中", "触发": {"类型": "首次", "编号": None},
            "输入": [], "基线": None, "评审结论": None, "未解决项": [],
            "artifacts": [], "metrics": {}, "children": []}
    data.update(copy.deepcopy(fields))
    problems = validate_version_ledger(data)
    if problems:
        raise ValueError("台账无效: " + "; ".join(problems))
    return data


def finalize_version_ledger(ledger: dict, **fields) -> dict:
    data = copy.deepcopy(ledger)
    data.update(copy.deepcopy(fields))
    problems = validate_version_ledger(data)
    if problems:
        raise ValueError("台账无效: " + "; ".join(problems))
    return data


def _object(value, label, required, allowed, problems):
    if not isinstance(value, dict):
        problems.append(f"{label} 必须是对象")
        return False
    for key in sorted(required - value.keys()):
        problems.append(f"{label} 缺少 {key}")
    for key in sorted(value.keys() - allowed):
        problems.append(f"{label} 不允许 {key}")
    return True


def _string(value, nullable=False):
    return (nullable and value is None) or isinstance(value, str) and bool(value)


def _relative(value):
    return (_string(value) and not value.startswith("/") and "\r" not in value
            and "\n" not in value and ".." not in value.split("/"))


def _nonnegative(value):
    return type(value) is int and value >= 0


def _timestamp(value):
    try:
        return isinstance(value, str) and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except (ValueError, TypeError):
        return False


def _check_field(data, key, predicate, problems):
    if key in data:
        try:
            valid = predicate(data[key])
        except (TypeError, ValueError):
            valid = False
        if not valid:
            problems.append(f"{key} 无效")


def _check_parts(data, problems):
    if not isinstance(data.get("引用"), str) or not _REF.fullmatch(data["引用"]):
        problems.append("引用 无效")
    elif "/" not in data["引用"] and data.get("版本") is not None:
        if data["引用"] != f"{data.get('节点')}@v{data['版本']}":
            problems.append("引用 与节点、版本不一致")
    try:
        validate_node_id(data.get("节点"))
    except ValueError:
        problems.append("节点 无效")
    _check_field(data, "版本", lambda v: type(v) is int and v > 0, problems)
    for key in ("课题", "会话", "中文目录名", "创建时间"):
        _check_field(data, key, _string if key != "创建时间" else _timestamp, problems)
    _check_field(data, "完成时间", lambda v: v is None or _timestamp(v), problems)
    _check_field(data, "执行方", lambda v: v in EXECUTORS, problems)
    _check_field(data, "执行状态", lambda v: v in STATUSES, problems)
    _check_field(data, "外部团队", lambda v: _string(v, True), problems)


def _check_trigger(data, problems):
    trigger = data.get("触发")
    if not _object(trigger, "触发", {"类型", "编号"}, {"类型", "编号"}, problems):
        return
    if trigger.get("类型") not in TRIGGER_TYPES:
        problems.append("触发.类型 无效")
    number = trigger.get("编号")
    if trigger.get("类型") in ("打回", "补证"):
        if type(number) is not int or number < 1:
            problems.append("触发.编号 必须是正整数")
    elif number is not None:
        problems.append("触发.编号 必须为 null")
    if data.get("外部团队") and trigger.get("类型") != "外部接收":
        problems.append("外部团队 需要外部接收触发")


def _check_skill(data, problems):
    skill = data.get("skill")
    if skill is None:
        return
    keys = {"名称", "中文名", "skill版本", "来源sha256"}
    if _object(skill, "skill", keys, keys, problems):
        for key in ("名称", "中文名", "skill版本"):
            _check_field(skill, key, _string, problems)
        _check_field(skill, "名称", lambda v: isinstance(v, str) and bool(_SLUG.fullmatch(v)), problems)
        _check_field(skill, "来源sha256", lambda v: isinstance(v, str) and bool(_SHA256.fullmatch(v)), problems)


def _check_lists(data, problems):
    inputs = data.get("输入")
    if isinstance(inputs, list):
        for index, item in enumerate(inputs):
            label = f"输入[{index}]"
            if _object(item, label, {"引用", "角色"}, {"引用", "角色"}, problems):
                _check_field(item, "引用", _string, problems)
                _check_field(item, "角色", lambda v: v in ("依赖", "基线", "参考"), problems)
    else:
        problems.append("输入 必须是数组")
    issues = data.get("未解决项")
    if isinstance(issues, list):
        keys = {"描述", "指标", "标准", "差值"}
        for index, item in enumerate(issues):
            if _object(item, f"未解决项[{index}]", keys, keys, problems):
                for key in keys:
                    _check_field(item, key, lambda v: isinstance(v, str) and (key != "描述" or bool(v)), problems)
    else:
        problems.append("未解决项 必须是数组")
    children = data.get("children")
    if not isinstance(children, list) or any(not _string(v) for v in children) or len(set(map(str, children))) != len(children):
        problems.append("children 必须是无重复引用数组")


def _check_artifacts(data, problems):
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list):
        problems.append("artifacts 必须是数组")
        return
    primary_count = 0
    for index, item in enumerate(artifacts):
        label = f"artifacts[{index}]"
        if not _object(item, label, _ARTIFACT_FIELDS, _ARTIFACT_FIELDS, problems):
            continue
        _check_field(item, "相对路径", _relative, problems)
        _check_field(item, "类型", lambda v: v in VERSION_SUBDIRS, problems)
        _check_field(item, "角色", lambda v: v in ("主交付物", "附属"), problems)
        _check_field(item, "sha256", lambda v: isinstance(v, str) and bool(_SHA256.fullmatch(v)), problems)
        _check_field(item, "字节数", _nonnegative, problems)
        primary_count += item.get("角色") == "主交付物"
    expected = data.get("执行状态") in DONE_STATUSES
    if (expected and primary_count != 1) or (not expected and primary_count > 1):
        problems.append("主交付物数量无效")


def _check_optional(data, problems):
    baseline = data.get("基线")
    if baseline is not None and _object(baseline, "基线", {"引用", "策略"}, {"引用", "策略"}, problems):
        _check_field(baseline, "引用", _string, problems)
        _check_field(baseline, "策略", lambda v: v in ("上一版", "固定首版", "无"), problems)
    verdict = data.get("评审结论")
    if verdict is not None and _object(verdict, "评审结论", {"结论", "原文", "理由", "目标"}, {"结论", "原文", "理由", "目标"}, problems):
        _check_field(verdict, "结论", lambda v: v in GENERIC_VERDICTS, problems)
        _check_field(verdict, "原文", lambda v: v is None or isinstance(v, str), problems)
        _check_field(verdict, "理由", lambda v: isinstance(v, str), problems)
        targets = verdict.get("目标")
        if not isinstance(targets, list):
            problems.append("评审结论.目标 必须是数组")
        else:
            for target in targets:
                try:
                    validate_node_id(target)
                except ValueError:
                    problems.append("评审结论.目标 含无效节点")
    trace = data.get("执行记录")
    if "执行记录" in data and _object(trace, "执行记录", {"路径", "步骤数", "失败数"}, {"路径", "步骤数", "失败数"}, problems):
        _check_field(trace, "路径", _relative, problems)
        for key in ("步骤数", "失败数"):
            _check_field(trace, key, _nonnegative, problems)
        if _nonnegative(trace.get("步骤数")) and _nonnegative(trace.get("失败数")) and trace["失败数"] > trace["步骤数"]:
            problems.append("执行记录.失败数 不能超过步骤数")
    if data.get("执行状态") in DONE_STATUSES and data.get("执行方") in TRACE_REQUIRED and "执行记录" not in data:
        problems.append("完成态缺少 执行记录")
    _check_field(data, "metrics", lambda v: isinstance(v, dict), problems)
    _check_field(data, "轮次记录", lambda v: isinstance(v, dict) and all(
        isinstance(key, str) and _string(value) for key, value in v.items()), problems)


def validate_version_ledger(data: dict) -> list[str]:
    problems = []
    if not _object(data, "台账", _FIELDS, _FIELDS | {"执行记录", "轮次记录"}, problems):
        return problems
    if data.get("schema_version") != SCHEMA_VERSION:
        problems.append("schema_version 无效")
    _check_parts(data, problems)
    _check_trigger(data, problems)
    _check_skill(data, problems)
    _check_lists(data, problems)
    _check_artifacts(data, problems)
    _check_optional(data, problems)
    return problems


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def write_ledger(path: Path, data: dict) -> None:
    problems = validate_version_ledger(data)
    if problems:
        raise ValueError("台账无效: " + "; ".join(problems))
    with path.open("w", encoding="utf-8") as target:
        json.dump(data, target, ensure_ascii=False, indent=2)
        target.write("\n")


def validate_task_meta(data: dict) -> list[str]:
    problems = []
    keys = {"schema_version", "课题ID", "名称", "智能体", "临时", "创建时间", "继承", "目标", "验收标准"}
    if not _object(data, "课题", keys, keys, problems):
        return problems
    if data.get("schema_version") != SCHEMA_VERSION:
        problems.append("schema_version 无效")
    _check_field(data, "课题ID", lambda v: isinstance(v, str) and bool(_SLUG.fullmatch(v)) or isinstance(v, str) and bool(re.fullmatch(r"task-(?:[0-9a-f]{2})+", v)), problems)
    for key in ("名称", "智能体", "目标"):
        _check_field(data, key, _string, problems)
    _check_field(data, "临时", lambda v: type(v) is bool, problems)
    _check_field(data, "创建时间", _timestamp, problems)
    _check_field(data, "继承", lambda v: v is None or _string(v), problems)
    _check_field(data, "验收标准", lambda v: isinstance(v, list) and all(_string(item) for item in v), problems)
    return problems
