"""交接检查和快照测试。"""

from datetime import datetime, timezone
import json
from pathlib import Path
import unittest

import test_views

from events import read_events
from handoff import check_handoff, create_handoff, handoff_scope
from layout import HANDOFF_DIR, handoff_dir_name, node_dir
from ledger import sha256_file


class HandoffTests(unittest.TestCase):
    setUp = test_views.ViewTests.setUp
    event = test_views.ViewTests.event
    version = test_views.ViewTests.version
    state = test_views.ViewTests.state

    def _version_with_file(self, node, *, verdict=None):
        number = self.version(node, verdict=verdict)
        source = node_dir(self.task, self.flow, node) / f"第{number}版" / "报告/结果.md"
        source.parent.mkdir(exist_ok=True)
        source.write_text(f"{node} 第{number}版", encoding="utf-8")
        return number

    def _ready(self):
        self._version_with_file("1.1")
        self._version_with_file("1.2")
        self._version_with_file("1.3", verdict="通过")

    def test_final_handoff_blocks_each_issue_and_allows_confirmation(self):
        self._ready()
        for number in (1, 2):
            self.event("未解决项", 编号=number, 动作="新增", 来源="1.2@v1",
                       描述=f"问题{number}", 指标="", 标准="", 差值="")
        now = datetime.now(timezone.utc)
        with self.assertRaises(ValueError) as error:
            create_handoff(self.state(), "1.3", session="test", confirm=None, now=now)
        for number in (1, 2):
            self.assertIn(f"未关闭未解决项#{number}：问题{number}", str(error.exception))
        self.assertFalse((self.task / HANDOFF_DIR).exists())
        confirmed = create_handoff(self.state(), "1.3", session="test", confirm="人工放行", now=now)
        self.assertEqual(confirmed["未解决项"], [1, 2])
        records, _ = read_events(self.task)
        self.assertEqual(len(records[-1]["问题"]), 2)
        for number, resolution in ((1, "接受"), (2, "后续处理")):
            self.event("未解决项", 编号=number, 动作="关闭", 处理=resolution, 原因="已处置")
        self.assertEqual(check_handoff(self.state(), "1.3"), [])
        self.assertEqual(create_handoff(self.state(), "1.3", session="test", confirm=None, now=now)["未解决项"], [])

    def test_scope_and_each_blocking_condition(self):
        self.assertEqual(handoff_scope(self.flow, "1.3"), ["1.1", "1.2", "1.3"])
        self.assertIn("没有定义交接", " ".join(check_handoff(self.state(), "1.1")))
        with self.assertRaisesRegex(ValueError, "没有定义交接"):
            create_handoff(self.state(), "1.1", session="test", confirm="同意", now=datetime.now(timezone.utc))
        self.assertIn("当前采用为空", " ".join(check_handoff(self.state(), "1.3")))
        with self.assertRaises(ValueError) as error:
            create_handoff(self.state(), "1.3", session="test", confirm=None, now=datetime.now(timezone.utc))
        self.assertIn("1.1", str(error.exception))
        self.assertIn("1.2", str(error.exception))
        self.assertFalse((self.task / HANDOFF_DIR).exists())
        self._version_with_file("1.1")
        self._version_with_file("1.2")
        self._version_with_file("1.3")
        self.assertIn("结论不是通过", " ".join(check_handoff(self.state(), "1.3")))
        self._version_with_file("1.3", verdict="通过")
        self._version_with_file("1.1")
        self.version("1.2", inputs=["1.1@v1"])
        self.assertIn("有效性为过期", " ".join(check_handoff(self.state(), "1.3")))

    def test_confirm_records_all_problems(self):
        now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
        manifest = create_handoff(self.state(), "1.3", session="test", confirm="负责人同意先交接", now=now)
        self.assertEqual(manifest["人工确认"], "负责人同意先交接")
        folder = self.task / HANDOFF_DIR / handoff_dir_name(1, "甲", now)
        description = (folder / "交接说明.md").read_text(encoding="utf-8")
        self.assertIn("负责人同意先交接", description)
        self.assertIn("当前采用为空", description)
        events, _ = read_events(self.task)
        self.assertEqual(events[-1]["类型"], "交接")
        self.assertEqual(events[-1]["人工确认"], "负责人同意先交接")
        self.assertTrue(events[-1]["问题"])

    def test_success_copies_checksum_increment_and_skip(self):
        # 保留阶段交接携带问题的断言，另设更靠后的最终交接。
        self.flow["节点"]["2.3"]["交接"] = "最终"
        self.flow["交接点"]["最终"] = "2.3"
        (self.task / "流程定义.json").write_text(json.dumps(self.flow, ensure_ascii=False), encoding="utf-8")
        self._ready()
        self.event("未解决项", 编号=1, 动作="新增", 来源="1.2@v1", 描述="待跟进",
                   指标="", 标准="", 差值="")
        now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
        first = create_handoff(self.state(), "1.3", session="test", confirm=None, now=now)
        folder = self.task / HANDOFF_DIR / handoff_dir_name(1, "甲", now)
        saved = json.loads((folder / "清单.json").read_text(encoding="utf-8"))
        self.assertEqual(saved, first)
        self.assertEqual(saved["未解决项"], [1])
        for node, item in saved["版本"].items():
            target = folder / item["主交付物"]
            self.assertEqual(target.parent.name, self.flow["节点"][node]["目录"][-1])
            self.assertEqual(item["sha256"], sha256_file(target))
        description = (folder / "交接说明.md").read_text(encoding="utf-8")
        self.assertIn("评审结论：通过", description)
        self.assertIn("待跟进", description)
        second = create_handoff(self.state(), "1.3", session="test", confirm=None, now=now)
        self.assertEqual(second["编号"], 2)
        self.assertTrue((self.task / HANDOFF_DIR / handoff_dir_name(2, "甲", now)).is_dir())

    def test_skipped_node_in_manifest_without_copy(self):
        self._version_with_file("1.1")
        self.event("跳过", 节点="1.2", 原因="不需要", 人工确认="同意")
        self._version_with_file("1.3", verdict="带问题通过")
        now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
        result = create_handoff(self.state(), "1.3", session="test", confirm=None, now=now)
        self.assertEqual(result["版本"]["1.2"], {"引用": "跳过", "主交付物": None, "sha256": None})
        folder = self.task / HANDOFF_DIR / handoff_dir_name(1, "甲", now)
        self.assertFalse((folder / "交付物" / self.flow["节点"]["1.2"]["目录"][-1]).exists())
        events, _ = read_events(self.task)
        self.assertEqual(events[-1]["清单"]["1.2"], "跳过")

    def test_confirm_missing_version_has_null_artifact(self):
        now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
        result = create_handoff(self.state(), "1.3", session="test", confirm="先交空清单", now=now)
        self.assertEqual(result["版本"]["1.1"],
                         {"引用": None, "主交付物": None, "sha256": None})


if __name__ == "__main__":
    unittest.main()
