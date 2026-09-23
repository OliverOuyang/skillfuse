"""推导产出目录名称与编号，不读写台账内容。"""

import os
import re
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Optional
from unittest.mock import patch


VERSION_SUBDIRS = ("报告", "数据", "执行记录", "日志")

_RUN_PATTERN = re.compile(r"^第([1-9][0-9]*)次执行_[0-9]{4}(?:上午|下午|晚上)(?:_(?:[2-9]|[1-9][0-9]+))?$")
_VERSION_PATTERN = re.compile(r"^第([1-9][0-9]*)版$")


def resolve_output_root(explicit: Optional[str], project_root: Path) -> Path:
    """按参数、环境、默认值选根目录，并解析链接以阻止越界。"""
    project_root = project_root.resolve()
    chosen = explicit if explicit is not None else os.environ.get("SKILLFUSE_OUTPUT_ROOT")
    root = project_root / "产出" if chosen is None else Path(chosen)
    if not root.is_absolute():
        root = project_root / root
    root = root.resolve()
    if not root.is_relative_to(project_root):
        raise ValueError("产出根必须位于项目根目录内")
    return root


def period_label(dt: datetime) -> str:
    """按小时划分三个时段，保证执行目录名稳定。"""
    if dt.hour < 12:
        return "上午"
    if dt.hour < 18:
        return "下午"
    return "晚上"


def sanitize_name(name: str) -> str:
    """移除路径分隔符和控制字符，避免名称改变目录层级。"""
    cleaned = "".join(
        char for char in name
        if char not in "/\\" and unicodedata.category(char) != "Cc"
    ).strip()
    if not cleaned or cleaned in (".", ".."):
        raise ValueError("目录名称清洗后不能为空或路径点段")
    return cleaned


def task_dir_name(name: str) -> str:
    """为正式课题加固定前缀，便于与临时区区分。"""
    return f"【课题】{sanitize_name(name)}"


def temp_dir_name(desc: str) -> str:
    """为未定课题的描述加临时区前缀。"""
    return f"【临时】{sanitize_name(desc)}"


def run_dir_name(n: int, dt: datetime) -> str:
    """把课题内执行序号和日期时段编码进可读目录名。"""
    if n < 1:
        raise ValueError("执行序号必须为正整数")
    return f"第{n}次执行_{dt:%m%d}{period_label(dt)}"


def version_dir_name(n: int) -> str:
    """以固定格式表示 skill 在课题内的版本序号。"""
    if n < 1:
        raise ValueError("版本序号必须为正整数")
    return f"第{n}版"


def unique_dir(parent: Path, name: str) -> Path:
    """选择尚未占用的可读目录名，保留已有产出。"""
    candidate = parent / name
    suffix = 2
    while candidate.exists() or candidate.is_symlink():
        candidate = parent / f"{name}_{suffix}"
        suffix += 1
    return candidate


def parse_run_number(dirname: str) -> Optional[int]:
    """只识别规范执行目录，忽略其它课题条目。"""
    match = _RUN_PATTERN.fullmatch(dirname)
    return int(match.group(1)) if match else None


def parse_version_number(dirname: str) -> Optional[int]:
    """只识别规范版本目录，避免索引文件干扰计数。"""
    match = _VERSION_PATTERN.fullmatch(dirname)
    return int(match.group(1)) if match else None


def next_run_number(task_dir: Path) -> int:
    """取课题中已有执行目录的最大序号，供新执行连续编号。"""
    if not task_dir.is_dir():
        return 1
    numbers = (
        parse_run_number(path.name)
        for path in task_dir.iterdir()
        if path.is_dir()
    )
    return max((number for number in numbers if number is not None), default=0) + 1


def _version_numbers(output_dir: Path, skill_name: str):
    """遍历直接产出及内部调用，汇集同一 skill 的版本。"""
    if not output_dir.is_dir():
        return
    for skill_dir in output_dir.iterdir():
        if not skill_dir.is_dir():
            continue
        for version_dir in skill_dir.iterdir():
            number = parse_version_number(version_dir.name)
            if number is None or not version_dir.is_dir():
                continue
            if skill_dir.name == skill_name:
                yield number
            yield from _version_numbers(version_dir / "内部调用", skill_name)


def next_version_number(task_dir: Path, skill_cn: str) -> int:
    """跨所有执行及内部调用取同一 skill 的最大版本号。"""
    skill_name = sanitize_name(skill_cn)
    if not task_dir.is_dir():
        return 1
    numbers = (
        number
        for run_dir in task_dir.iterdir()
        if run_dir.is_dir() and parse_run_number(run_dir.name) is not None
        for number in _version_numbers(run_dir / "各环节产出", skill_name)
    )
    return max(numbers, default=0) + 1


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temporary:
        project = Path(temporary).resolve()
        task = project / task_dir_name("中文课题")
        task.mkdir()

        first = unique_dir(task, "重复")
        first.mkdir()
        assert unique_dir(task, "重复") == task / "重复_2"
        (task / "重复_2").mkdir()
        assert unique_dir(task, "重复") == task / "重复_3"

        morning = datetime(2026, 9, 23, 11, 59)
        noon = datetime(2026, 9, 23, 12, 0)
        afternoon = datetime(2026, 9, 23, 17, 59)
        evening = datetime(2026, 9, 23, 18, 0)
        assert [period_label(dt) for dt in (morning, noon, afternoon, evening)] == [
            "上午", "下午", "下午", "晚上"
        ]

        run1 = task / run_dir_name(1, morning)
        run2 = task / run_dir_name(2, noon)
        (run1 / "各环节产出" / "分析" / "第1版").mkdir(parents=True)
        (run2 / "各环节产出" / "分析" / "第2版").mkdir(parents=True)
        assert next_run_number(task) == 3
        assert next_version_number(task, "分析") == 3

        (run2 / "各环节产出" / "报告" / "第1版" / "内部调用" / "取数" / "第1版").mkdir(parents=True)
        assert next_version_number(task, "取数") == 2

        with patch.dict(os.environ):
            os.environ.pop("SKILLFUSE_OUTPUT_ROOT", None)
            assert resolve_output_root(None, project) == project / "产出"
        try:
            resolve_output_root("../越界", project)
        except ValueError:
            pass
        else:
            raise AssertionError("越界路径未被拒绝")

    print("OK")
