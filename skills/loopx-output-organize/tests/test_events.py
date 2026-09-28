"""事件日志契约测试。"""

import json
import multiprocessing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from events import EVENT_TYPES, LOG_NAME, append_event, next_number, read_events


def _append_many(task_dir, worker):
    for number in range(25):
        append_event(Path(task_dir), "分配", {"节点": f"{worker}-{number}"}, session=str(worker))


class EventTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.task = Path(self.temporary.name) / "课题"

    def test_append_and_read(self):
        self.assertEqual(read_events(self.task), ([], []))
        fields = {"节点": "2.2"}
        timestamp = datetime(2026, 9, 28, 10, tzinfo=timezone(timedelta(hours=8)))
        first = append_event(self.task, "分配", fields, session="s1", now=timestamp)
        second = append_event(self.task, "提交", {"节点": "2.2"}, session="s2")
        self.assertEqual(fields, {"节点": "2.2"})
        self.assertEqual((first["序号"], second["序号"]), (1, 2))
        self.assertEqual(first["类型"], "分配")
        self.assertEqual(first["会话"], "s1")
        self.assertIsNotNone(datetime.fromisoformat(first["时间"]).utcoffset())
        self.assertEqual(read_events(self.task), ([first, second], []))
        self.assertEqual(tuple(EVENT_TYPES), ("开课题", "分配", "提交", "打回", "补证",
                                              "采用", "跳过", "交接", "未解决项", "流程变更"))
        self.assertEqual(LOG_NAME, "流转记录.jsonl")
        with self.assertRaises(ValueError):
            append_event(self.task, "不存在", {}, session="s")

    def test_bad_lines_skipped(self):
        self.task.mkdir()
        with (self.task / LOG_NAME).open("w", encoding="utf-8") as stream:
            stream.write('{"序号": 3, "类型": "提交"}\nnot-json\n[]\n{"序号": 0}\n')
        events, problems = read_events(self.task)
        self.assertEqual([event["序号"] for event in events], [3])
        self.assertEqual(len(problems), 3)
        self.assertTrue(any("第2行" in problem for problem in problems))
        self.assertEqual(append_event(self.task, "采用", {}, session="s")["序号"], 4)

    def test_next_number(self):
        events = [
            {"类型": "打回", "编号": 1}, {"类型": "补证", "编号": 1},
            {"类型": "打回", "编号": 2}, {"类型": "交接", "编号": 1},
            {"类型": "未解决项", "编号": 1, "动作": "新增"},
            {"类型": "未解决项", "编号": 1, "动作": "关闭"},
            {"类型": "未解决项", "编号": 2, "动作": "新增"},
        ]
        self.assertEqual(next_number([], "打回"), 1)
        self.assertEqual([next_number(events, kind) for kind in
                          ("打回", "补证", "交接", "未解决项")], [3, 2, 2, 3])
        self.assertEqual(next_number([{"类型": "未解决项", "编号": 9, "动作": "关闭"}],
                                     "未解决项"), 1)

    def test_multiprocess_append(self):
        context = multiprocessing.get_context("spawn")
        processes = [context.Process(target=_append_many, args=(str(self.task), worker))
                     for worker in range(4)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(30)
            self.assertEqual(process.exitcode, 0)
        events, problems = read_events(self.task)
        self.assertEqual(problems, [])
        self.assertEqual([event["序号"] for event in events], list(range(1, 101)))
        with (self.task / LOG_NAME).open("r", encoding="utf-8") as stream:
            self.assertEqual(sum(1 for line in stream if json.loads(line)), 100)


if __name__ == "__main__":
    unittest.main()
