"""课题目录、版本编号与引用格式。"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path


VERSION_SUBDIRS = ("报告", "数据", "执行记录", "日志")
NESTED_DIR = "内部调用"
HANDOFF_DIR = "交接与交付"
LEDGER_NAME = "产出台账.json"
TASK_META = "课题.json"
FLOW_FILE = "流程定义.json"
IMPLICIT_AGENT = "单独调用"
STATE_FILE = ".当前状态.json"

_VERSION_PATTERN = re.compile(r"第([1-9][0-9]*)版\Z")
_NODE_PATTERN = re.compile(r"([^/@#:\s\x00-\x1f\x7f]+)@v([1-9][0-9]*)\Z")
_SKIP_PATTERN = re.compile(r"([^/@#:\s\x00-\x1f\x7f]+)@跳过\Z")
_HANDOFF_PATTERN = re.compile(r"交接#([1-9][0-9]*)\Z")
_SLUG_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


def project_root(start: Path | None = None) -> Path:
    current = Path.cwd().resolve() if start is None else Path(start).resolve()
    if current.is_file():
        current = current.parent
    for directory in (current, *current.parents):
        if (directory / ".git").exists():
            return directory
    return Path.cwd().resolve()


def resolve_output_root(explicit: str | None, project_root: Path) -> Path:
    project_root = project_root.resolve()
    chosen = explicit if explicit is not None else os.environ.get("SKILLFUSE_OUTPUT_ROOT")
    root = project_root / "产出" if chosen is None else Path(chosen)
    if not root.is_absolute():
        root = project_root / root
    root = root.resolve()
    if not root.is_relative_to(project_root):
        raise ValueError("产出根必须位于项目根目录内")
    return root


def sanitize_name(name: str) -> str:
    cleaned = "".join(
        char for char in name
        if char not in "/\\" and unicodedata.category(char) != "Cc"
    ).strip()
    if not cleaned or cleaned in (".", ".."):
        raise ValueError("目录名称清洗后不能为空或路径点段")
    return cleaned


def validate_node_id(node_id: str) -> None:
    if not isinstance(node_id, str) or not node_id or any(
        char in "/@#:" or char.isspace() or unicodedata.category(char) == "Cc"
        for char in node_id
    ):
        raise ValueError("无效节点 ID")


def task_dir_path(root: Path, agent: str, name: str, temp: bool) -> Path:
    prefix = "【临时】" if temp else "【课题】"
    return root / sanitize_name(agent) / (prefix + sanitize_name(name))


def node_dir(task_dir: Path, flow: dict, node_id: str) -> Path:
    return task_dir.joinpath(*flow["节点"][node_id]["目录"])


def version_dir_name(n: int) -> str:
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        raise ValueError("版本序号必须为正整数")
    return f"第{n}版"


def parse_version_number(name: str) -> int | None:
    match = _VERSION_PATTERN.fullmatch(name)
    return int(match.group(1)) if match else None


def list_versions(node_dir: Path) -> list[int]:
    if not node_dir.is_dir():
        return []
    numbers = (parse_version_number(path.name) for path in node_dir.iterdir() if path.is_dir())
    return sorted(number for number in numbers if number is not None)


def allocate_version_dir(parent: Path) -> tuple[int, Path]:
    parent.mkdir(parents=True, exist_ok=True)
    number = max(list_versions(parent), default=0) + 1
    while True:
        directory = parent / version_dir_name(number)
        try:
            os.mkdir(directory)
            break
        except FileExistsError:
            number += 1
    for subdir in VERSION_SUBDIRS:
        (directory / subdir).mkdir()
    return number, directory


def handoff_dir_name(n: int, name: str, dt: datetime) -> str:
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        raise ValueError("交接序号必须为正整数")
    return f"交接{n}_{sanitize_name(name)}_{dt:%m%d}"


def version_ref(node_id: str, n: int) -> str:
    validate_node_id(node_id)
    version_dir_name(n)
    return f"{node_id}@v{n}"


def _version_part(part: str) -> tuple[str, int]:
    match = _NODE_PATTERN.fullmatch(part)
    if not match:
        raise ValueError(f"无效引用：{part}")
    validate_node_id(match.group(1))
    return match.group(1), int(match.group(2))


def parse_ref(ref: str) -> dict:
    if not isinstance(ref, str):
        raise ValueError("无效引用")
    result = {"课题": None, "节点": "", "版本": None, "跳过": False, "交接": None, "嵌套": []}
    handoff = _HANDOFF_PATTERN.fullmatch(ref)
    if handoff:
        result["交接"] = int(handoff.group(1))
        return result
    parts = ref.split("/")
    # 首段含 @ 的斜杠引用是嵌套调用，否则是跨课题引用。
    if len(parts) == 2 and "@" not in parts[0]:
        slug = parts.pop(0)
        if not _SLUG_PATTERN.fullmatch(slug):
            raise ValueError("无效课题引用")
        result["课题"] = slug
    if not parts or len(parts) > 2 or (result["课题"] is not None and len(parts) != 1):
        raise ValueError("无效引用")
    if len(parts) == 1 and result["课题"] is None:
        skipped = _SKIP_PATTERN.fullmatch(parts[0])
        if skipped:
            result["节点"] = skipped.group(1)
            validate_node_id(result["节点"])
            result["跳过"] = True
            return result
    handoff = _HANDOFF_PATTERN.fullmatch(parts[0]) if len(parts) == 1 else None
    if handoff:
        result["交接"] = int(handoff.group(1))
        return result
    result["节点"], result["版本"] = _version_part(parts[0])
    if len(parts) == 2:
        nested_node, nested_version = _version_part(parts[1])
        result["嵌套"] = [{"节点": nested_node, "版本": nested_version}]
    return result


def read_state(root: Path) -> dict:
    path = root / STATE_FILE
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def write_state(root: Path, state: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    with (root / STATE_FILE).open("w", encoding="utf-8") as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def session_id() -> str:
    for key in ("SKILLFUSE_SESSION", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID"):
        if os.environ.get(key):
            return os.environ[key]
    return f"local-{datetime.now().astimezone():%Y%m%d}"
