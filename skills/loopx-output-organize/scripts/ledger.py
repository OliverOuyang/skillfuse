"""产出台账的构造、校验与文件索引读写。"""

from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import tempfile
from typing import List, Optional


LEDGER_NAME = "产出台账.json"
KINDS = {"版本", "执行", "课题"}
STATUSES = {"进行中", "成功", "部分完成", "失败"}
# 完成态才强制完整产物；进行中与失败态放宽，保住现场优先于满足格式。
DONE_STATUSES = {"成功", "部分完成"}
ARTIFACT_TYPES = {"报告", "数据", "执行记录", "日志"}
# 嵌套调用的子 skill 版本挂在这个子目录下，自成一棵独立的版本树。
NESTED_DIR = "内部调用"
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$")
SHA256 = re.compile(r"^[a-fA-F0-9]{64}$")
COMMON = {"schema_version", "kind", "标准ID", "中文目录名", "课题ID", "创建时间", "状态", "inputs", "artifacts", "metrics", "children"}
BRANCH = {
    # 「执行记录」对版本台账是条件必填：失败版本可能来不及写 trace，见 validate_ledger。
    "版本": ({"执行ID", "版本号", "上一版版本号", "skill"}, {"steps", "目标", "验收标准", "累计执行列表"}),
    # 「执行记录」对执行台账同样是条件必填：run-begin 时还没有 trace。
    "执行": ({"执行ID", "steps"}, {"版本号", "上一版版本号", "skill", "目标", "验收标准", "累计执行列表"}),
    "课题": ({"目标", "验收标准", "累计执行列表"}, {"执行ID", "版本号", "上一版版本号", "skill", "执行记录", "steps"}),
}


def sha256_file(path: Path) -> str:
    """分块读取文件，以免大产物占满内存。"""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan_artifacts(version_dir: Path, primary_rel: Optional[str]) -> List[dict]:
    """按相对路径确定产物类别，并从实际文件计算摘要和大小。"""
    primary = Path(primary_rel) if primary_rel else None
    if primary is not None and (primary.is_absolute() or ".." in primary.parts or not (version_dir / primary).is_file()):
        raise FileNotFoundError(primary_rel)
    artifacts = []
    for path in sorted(version_dir.rglob("*")):
        if not path.is_file() or path == version_dir / LEDGER_NAME:
            continue
        relative = path.relative_to(version_dir)
        category = relative.parts[0]
        # 嵌套调用的子 skill 产物归子台账管，父台账不重复记账。
        if category == NESTED_DIR:
            continue
        if category not in ARTIFACT_TYPES:
            raise ValueError(f"无法判定产物类型: {relative.as_posix()}")
        artifacts.append({
            "相对路径": relative.as_posix(),
            "类型": category,
            "角色": "主交付物" if relative == primary else "附属",
            "sha256": sha256_file(path),
            "字节数": path.stat().st_size,
        })
    return artifacts


def count_trace_steps(version_dir: Path) -> Optional[dict]:
    """汇总 JSONL 的有效步骤，单独报告坏行以便排查记录损坏。"""
    # 只统计本版自己的 trace；嵌套子 skill 的记录归它自己的台账。
    files = sorted(f for f in (version_dir / "执行记录").rglob("*.jsonl")
                   if NESTED_DIR not in f.relative_to(version_dir).parts)
    if not files:
        return None
    result = {"路径": files[0].relative_to(version_dir).as_posix(), "步骤数": 0, "失败数": 0, "坏行数": 0}
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


def _trace_for_ledger(trace: Optional[dict]) -> Optional[dict]:
    """坏行数供调用方诊断，台账只保留 schema 规定的三项。

    trace 为 None 表示这一版没留下执行记录（失败版本常见），此时不写该字段。
    """
    if trace is None:
        return None
    return {key: trace[key] for key in ("路径", "步骤数", "失败数")}


def _build(kind: str, standard_id: str, directory_name: str, task_id: str,
           created_at: str, status: str, inputs: List[dict], artifacts: List[dict],
           metrics: dict, children: List[str], **fields) -> dict:
    """共享公共字段，避免三层台账出现不同的默认值。"""
    if not isinstance(artifacts, list):
        raise ValueError("artifacts 必须是列表")
    primary_count = sum(isinstance(item, dict) and item.get("角色") == "主交付物"
                        for item in artifacts)
    # 进行中（刚开目录）与失败（没跑出东西）都允许没有产物、没有主交付物：
    # 保住现场比满足格式更重要。只有完成态才按 schema 要求恰好一个主交付物。
    if status not in DONE_STATUSES:
        if primary_count > 1:
            raise ValueError("进行中或失败的台账至多一个主交付物")
    elif not artifacts or primary_count != 1:
        raise ValueError("schema 要求构造出的台账至少有一个产物且恰好一个主交付物")
    data = {
        "schema_version": "1.0", "kind": kind, "标准ID": standard_id,
        "中文目录名": directory_name, "课题ID": task_id, "创建时间": created_at,
        "状态": status, "inputs": inputs, "artifacts": artifacts,
        "metrics": metrics, "children": children,
    }
    data.update(fields)
    errors = validate_ledger(data)
    if errors:
        raise ValueError("台账无效: " + "; ".join(errors))
    return data


def build_version_ledger(standard_id: str, directory_name: str, task_id: str,
                         run_id: str, version: int, previous_version: Optional[int],
                         skill: dict, created_at: str, status: str, inputs: List[dict],
                         artifacts: List[dict], trace: dict, metrics: dict,
                         children: List[str]) -> dict:
    """构造单个 skill 版本台账，并检查版本链与必填记录。"""
    extra = {"执行ID": run_id, "版本号": version,
             "上一版版本号": previous_version, "skill": skill}
    # 没有执行记录时整个字段省略，而不是写 null——schema 里它是 object。
    trace_field = _trace_for_ledger(trace)
    if trace_field is not None:
        extra["执行记录"] = trace_field
    return _build("版本", standard_id, directory_name, task_id, created_at, status,
                  inputs, artifacts, metrics, children, **extra)


def build_run_ledger(standard_id: str, directory_name: str, task_id: str,
                     run_id: str, created_at: str, status: str, inputs: List[dict],
                     artifacts: List[dict], trace: dict, metrics: dict,
                     children: List[str], steps: List[dict]) -> dict:
    """构造一次执行台账，使采用的各 skill 版本可追溯。"""
    extra = {"执行ID": run_id, "steps": steps}
    # run-begin 时还没有编排 trace，此时整个字段省略而不是写 null。
    trace_field = _trace_for_ledger(trace)
    if trace_field is not None:
        extra["执行记录"] = trace_field
    return _build("执行", standard_id, directory_name, task_id, created_at, status,
                  inputs, artifacts, metrics, children, **extra)


def build_task_ledger(standard_id: str, directory_name: str, task_id: str,
                      created_at: str, status: str, inputs: List[dict],
                      artifacts: List[dict], metrics: dict, children: List[str],
                      goal: str, acceptance_criteria: List[str], run_ids: List[str]) -> dict:
    """构造跨执行的课题台账，保留目标与累计执行顺序。"""
    return _build("课题", standard_id, directory_name, task_id, created_at, status,
                  inputs, artifacts, metrics, children, 目标=goal,
                  验收标准=acceptance_criteria, 累计执行列表=run_ids)


def write_ledger(path: Path, data: dict) -> None:
    """用可读的中文 JSON 落盘，并拒绝写入无效台账。"""
    errors = validate_ledger(data)
    if errors:
        raise ValueError("台账无效: " + "; ".join(errors))
    with path.open("w", encoding="utf-8") as target:
        json.dump(data, target, ensure_ascii=False, indent=2)
        target.write("\n")


def read_ledger(path: Path) -> dict:
    """按 UTF-8 还原台账供后续校验或比较。"""
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def _positive_int(value) -> bool:
    return type(value) is int and value >= 1


def _nonnegative_int(value) -> bool:
    return type(value) is int and value >= 0


def _string(value, pattern=None) -> bool:
    return isinstance(value, str) and bool(value) and (pattern is None or bool(pattern.fullmatch(value)))


def _relative_path(value) -> bool:
    return (_string(value) and not value.startswith("/") and "\r" not in value
            and "\n" not in value and ".." not in value.split("/"))


def _object(value, required, allowed, label, errors) -> bool:
    if not isinstance(value, dict):
        errors.append(f"{label} 必须是对象")
        return False
    for key in sorted(required - value.keys()):
        errors.append(f"{label} 缺少 {key}")
    for key in sorted(value.keys() - allowed):
        errors.append(f"{label} 不允许 {key}")
    return True


def validate_ledger(data: dict) -> List[str]:
    """手写校验 schema 的结构约束，并允许失败现场没有主交付物。"""
    errors = []
    all_fields = COMMON | set().union(*(required | forbidden for required, forbidden in BRANCH.values()))
    if not _object(data, COMMON, all_fields, "台账", errors):
        return errors
    if data.get("schema_version") != "1.0":
        errors.append("schema_version 必须为 1.0")
    kind = data.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        errors.append("kind 无效")
    else:
        required, forbidden = BRANCH[kind]
        for key in sorted(required - data.keys()):
            errors.append(f"{kind}台账缺少 {key}")
        for key in sorted(forbidden & data.keys()):
            errors.append(f"{kind}台账不允许 {key}")
    for key in ("标准ID", "课题ID", "执行ID"):
        if key in data and not _string(data[key], ID):
            errors.append(f"{key} 格式无效")
    if "中文目录名" in data and not _string(data["中文目录名"]):
        errors.append("中文目录名不能为空")
    if "创建时间" in data:
        try:
            value = data["创建时间"]
            if not isinstance(value, str) or datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
                raise ValueError
        except (ValueError, AttributeError, TypeError):
            errors.append("创建时间 必须是带时区的日期时间")
    if not isinstance(data.get("状态"), str) or data.get("状态") not in STATUSES:
        errors.append("状态 无效")
    # 只有跑成功或部分完成的版本才必须留下执行记录；失败版本允许缺失，保住现场优先。
    # 只有版本级强制执行记录；执行级的编排顺序由 steps[] 承载，不另外强制。
    if kind == "版本" and data.get("状态") in DONE_STATUSES and "执行记录" not in data:
        errors.append("版本台账在完成态必须有 执行记录")
    if kind in ("版本", "执行") and isinstance(data.get("课题ID"), str) and isinstance(data.get("执行ID"), str) and not data["执行ID"].startswith(data["课题ID"] + "/"):
        errors.append("执行ID 应属于课题ID")
    if kind == "执行" and data.get("标准ID") != data.get("执行ID"):
        errors.append("执行台账 标准ID 应等于执行ID")
    if kind == "课题" and data.get("标准ID") != data.get("课题ID"):
        errors.append("课题台账 标准ID 应等于课题ID")
    if "版本号" in data and not _positive_int(data["版本号"]):
        errors.append("版本号 必须是正整数")
    if "上一版版本号" in data and data["上一版版本号"] is not None and not _positive_int(data["上一版版本号"]):
        errors.append("上一版版本号 必须是正整数或 null")
    if kind == "版本" and _positive_int(data.get("版本号")):
        previous = data.get("上一版版本号")
        if previous != (data["版本号"] - 1 if data["版本号"] > 1 else None):
            errors.append("上一版版本号 必须是版本号减一，第1版必须为 null")
    if "skill" in data and _object(data["skill"], {"名称", "中文名", "skill版本", "来源sha256"}, {"名称", "中文名", "skill版本", "来源sha256"}, "skill", errors):
        skill = data["skill"]
        for key, pattern in (("名称", SLUG), ("中文名", None), ("skill版本", None), ("来源sha256", SHA256)):
            if key in skill and not _string(skill[key], pattern):
                errors.append(f"skill.{key} 无效")
    if "inputs" in data:
        if not isinstance(data["inputs"], list):
            errors.append("inputs 必须是数组")
        else:
            for i, item in enumerate(data["inputs"]):
                label = f"inputs[{i}]"
                if _object(item, {"类型", "引用", "角色"}, {"类型", "引用", "角色"}, label, errors):
                    if not isinstance(item.get("类型"), str) or item.get("类型") not in {"产物", "用户", "外部"}:
                        errors.append(f"{label}.类型 无效")
                    if "引用" in item and not _string(item["引用"]):
                        errors.append(f"{label}.引用 无效")
                    if not isinstance(item.get("角色"), str) or item.get("角色") not in {"上游", "基线", "参考"}:
                        errors.append(f"{label}.角色 无效")
    if "artifacts" in data:
        artifacts = data["artifacts"]
        if not isinstance(artifacts, list):
            errors.append("artifacts 必须是数组")
        else:
            if not artifacts and data.get("状态") in DONE_STATUSES:
                errors.append("artifacts 不能为空")
            primary_count = 0
            for i, item in enumerate(artifacts):
                label = f"artifacts[{i}]"
                fields = {"相对路径", "类型", "角色", "sha256", "字节数"}
                if _object(item, fields, fields, label, errors):
                    if "相对路径" in item and not _relative_path(item["相对路径"]):
                        errors.append(f"{label}.相对路径 无效")
                    if not isinstance(item.get("类型"), str) or item.get("类型") not in ARTIFACT_TYPES:
                        errors.append(f"{label}.类型 无效")
                    if not isinstance(item.get("角色"), str) or item.get("角色") not in {"主交付物", "附属"}:
                        errors.append(f"{label}.角色 无效")
                    primary_count += item.get("角色") == "主交付物"
                    if "sha256" in item and not _string(item["sha256"], SHA256):
                        errors.append(f"{label}.sha256 无效")
                    if "字节数" in item and not _nonnegative_int(item["字节数"]):
                        errors.append(f"{label}.字节数 无效")
            if primary_count > 1 or (primary_count == 0 and data.get("状态") in DONE_STATUSES):
                errors.append("主交付物数量无效")
    if "执行记录" in data:
        trace = data["执行记录"]
        fields = {"路径", "步骤数", "失败数"}
        if _object(trace, fields, fields, "执行记录", errors):
            if "路径" in trace and not _relative_path(trace["路径"]):
                errors.append("执行记录.路径 无效")
            for key in ("步骤数", "失败数"):
                if key in trace and not _nonnegative_int(trace[key]):
                    errors.append(f"执行记录.{key} 无效")
            if _nonnegative_int(trace.get("步骤数")) and _nonnegative_int(trace.get("失败数")) and trace["失败数"] > trace["步骤数"]:
                errors.append("执行记录.失败数 不能超过步骤数")
    if "metrics" in data and not isinstance(data["metrics"], dict):
        errors.append("metrics 必须是对象")
    for key in ("children", "累计执行列表"):
        if key in data:
            values = data[key]
            if not isinstance(values, list) or any(not _string(value, ID) for value in values) or len(values) != len(set(map(str, values))):
                errors.append(f"{key} 必须是无重复 ID 数组")
    if "steps" in data:
        steps = data["steps"]
        # run-begin 时执行还没跑任何 skill，steps 允许为空；收尾时才应有内容。
        if not isinstance(steps, list) or (not steps and data.get("状态") in DONE_STATUSES):
            errors.append("steps 在完成态必须是非空数组")
        else:
            for i, step in enumerate(steps):
                label = f"steps[{i}]"
                fields = {"顺序", "skill名称", "最终采用版本ID"}
                if _object(step, fields, fields, label, errors):
                    if "顺序" in step and not _positive_int(step["顺序"]):
                        errors.append(f"{label}.顺序 无效")
                    if "skill名称" in step and not _string(step["skill名称"], SLUG):
                        errors.append(f"{label}.skill名称 无效")
                    if "最终采用版本ID" in step and not _string(step["最终采用版本ID"], ID):
                        errors.append(f"{label}.最终采用版本ID 无效")
    if "目标" in data and not _string(data["目标"]):
        errors.append("目标 不能为空")
    if "验收标准" in data:
        criteria = data["验收标准"]
        if not isinstance(criteria, list) or not criteria or any(not _string(value) for value in criteria):
            errors.append("验收标准 必须是非空字符串数组")
    return errors


def update_compare_index(task_dir: Path, skill_cn: str, version: int,
                         version_dir: Path, status: str) -> Path:
    """只新增历史索引，并使最新版始终指向最大编号。"""
    if not _positive_int(version) or not isinstance(status, str) or status not in STATUSES or not isinstance(skill_cn, str) or not skill_cn or skill_cn in {".", ".."} or "/" in skill_cn or "\\" in skill_cn:
        raise ValueError("索引参数无效")
    relative = version_dir.resolve().relative_to(task_dir.resolve()).as_posix()
    index_dir = task_dir / "版本对比" / skill_cn
    if not index_dir.is_dir():
        raise FileNotFoundError(index_dir)
    target = index_dir / f"第{version}版"
    entry = {"版本号": version, "相对路径": relative, "状态": status}
    try:
        with target.open("x", encoding="utf-8") as output:
            json.dump(entry, output, ensure_ascii=False, indent=2)
            output.write("\n")
    except FileExistsError:
        with target.open("r", encoding="utf-8") as source:
            if json.load(source) != entry:
                raise ValueError(f"已有历史索引与新记录冲突: {target}")
    versions = []
    for path in index_dir.iterdir():
        match = re.fullmatch(r"第([1-9][0-9]*)版", path.name)
        if match and path.is_file():
            versions.append((int(match.group(1)), path))
    latest_version, latest_path = max(versions)
    with latest_path.open("r", encoding="utf-8") as source:
        latest_entry = json.load(source)
    latest = index_dir / "最新版"
    with latest.open("w", encoding="utf-8") as output:
        json.dump(latest_entry, output, ensure_ascii=False, indent=2)
        output.write("\n")
    return target


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temporary:
        task = Path(temporary) / "【课题】测试"
        version_dir = task / "第1次执行" / "各环节产出" / "测试技能" / "第1版"
        for category in ("报告", "数据", "执行记录", "日志"):
            (version_dir / category).mkdir(parents=True)
        report = version_dir / "报告" / "中文报告.md"
        report.write_text("测试内容", encoding="utf-8")
        (version_dir / "数据" / "明细.csv").write_text("名称,值\n甲,1\n", encoding="utf-8")
        (version_dir / "日志" / "运行.log").write_text("完成\n", encoding="utf-8")
        (version_dir / "执行记录" / "trace.jsonl").write_text(
            '{"status":"ok"}\n坏行\n{"status":"fail"}\n', encoding="utf-8")
        artifacts = scan_artifacts(version_dir, "报告/中文报告.md")
        assert {item["类型"] for item in artifacts} == ARTIFACT_TYPES
        assert sum(item["角色"] == "主交付物" for item in artifacts) == 1
        trace = count_trace_steps(version_dir)
        assert trace == {"路径": "执行记录/trace.jsonl", "步骤数": 2, "失败数": 1, "坏行数": 1}
        base = build_version_ledger(
            "test-task/test-skill/v1", "【课题】测试/第1次执行/各环节产出/测试技能/第1版",
            "test-task", "test-task/run-1", 1, None,
            {"名称": "test-skill", "中文名": "测试技能", "skill版本": "1.0", "来源sha256": "a" * 64},
            "2026-09-23T12:00:00+08:00", "成功", [], artifacts, trace, {}, [])
        assert validate_ledger(base) == []
        write_ledger(version_dir / LEDGER_NAME, base)
        assert read_ledger(version_dir / LEDGER_NAME) == base
        failed = dict(base, 状态="失败", artifacts=scan_artifacts(version_dir, None))
        assert validate_ledger(failed) == []
        missing_primary = dict(base, artifacts=scan_artifacts(version_dir, None))
        assert any("主交付物" in error for error in validate_ledger(missing_primary))
        backwards = dict(base, 版本号=2, 上一版版本号=2)
        assert any("上一版版本号" in error for error in validate_ledger(backwards))
        index_dir = task / "版本对比" / "测试技能"
        index_dir.mkdir(parents=True)
        for number in (1, 3, 2):
            update_compare_index(task, "测试技能", number, version_dir, "失败" if number == 3 else "成功")
        with (index_dir / "最新版").open("r", encoding="utf-8") as source:
            assert json.load(source)["版本号"] == 3
    print("OK")
