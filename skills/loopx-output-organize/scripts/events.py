"""课题事件的只追加日志。"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None


EVENT_TYPES = ("开课题", "分配", "提交", "打回", "补证", "采用", "跳过", "交接", "未解决项", "流程变更")
LOG_NAME = "流转记录.jsonl"


def _parse_lines(lines) -> tuple[list[dict], list[str]]:
    events = []
    problems = []
    for number, line in enumerate(lines, 1):
        try:
            event = json.loads(line)
            if not isinstance(event, dict) or type(event.get("序号")) is not int or event["序号"] < 1:
                raise ValueError("事件缺少有效序号")
            events.append(event)
        except (ValueError, KeyError) as error:
            problems.append(f"第{number}行：{error}")
    return events, problems


def append_event(task_dir: Path, type_: str, fields: dict, *, session: str, now: datetime | None = None) -> dict:
    if type_ not in EVENT_TYPES:
        raise ValueError(f"未知事件类型：{type_}")
    task_dir.mkdir(parents=True, exist_ok=True)
    with (task_dir / LOG_NAME).open("a+", encoding="utf-8") as stream:
        if fcntl is not None:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            # 序号须在同一把锁内读取并分配，避免跨进程重复。
            stream.seek(0)
            events, _ = _parse_lines(stream)
            timestamp = datetime.now().astimezone() if now is None else now.astimezone()
            event = dict(fields)
            event.update({
                "序号": max((item["序号"] for item in events), default=0) + 1,
                "时间": timestamp.isoformat(), "会话": session, "类型": type_,
            })
            stream.seek(0, 2)
            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            return event
        finally:
            if fcntl is not None:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def read_events(task_dir: Path) -> tuple[list[dict], list[str]]:
    path = task_dir / LOG_NAME
    if not path.exists():
        return [], []
    with path.open("r", encoding="utf-8") as stream:
        return _parse_lines(stream)


def next_number(events: list[dict], type_: str) -> int:
    return max((event["编号"] for event in events
                if event.get("类型") == type_ and (type_ != "未解决项" or event.get("动作") == "新增")),
               default=0) + 1
