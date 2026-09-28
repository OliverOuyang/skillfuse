"""路径与版本分配契约测试。"""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from layout import (FLOW_FILE, HANDOFF_DIR, IMPLICIT_AGENT, LEDGER_NAME, NESTED_DIR,
                    STATE_FILE, TASK_META, VERSION_SUBDIRS, allocate_version_dir,
                    handoff_dir_name, list_versions, node_dir, parse_ref,
                    parse_version_number, project_root, read_state,
                    resolve_output_root, sanitize_name, session_id, task_dir_path,
                    validate_node_id, version_dir_name, version_ref, write_state)


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name).resolve()
        (self.project / ".git").mkdir()

    def test_cross_task_handoff_reference(self):
        self.assertEqual(parse_ref("q3-bcard/交接#2"),
                         {"课题": "q3-bcard", "节点": "", "版本": None,
                          "跳过": False, "交接": 2, "嵌套": []})
        for reference in ("Q/交接#1", "q/交接#0", "q/交接#01", "q/交接#2/more"):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                parse_ref(reference)

    def test_constants_and_project_root(self):
        self.assertEqual(VERSION_SUBDIRS, ("报告", "数据", "执行记录", "日志"))
        self.assertEqual((NESTED_DIR, HANDOFF_DIR, LEDGER_NAME, TASK_META, FLOW_FILE,
                          IMPLICIT_AGENT, STATE_FILE),
                         ("内部调用", "交接与交付", "产出台账.json", "课题.json",
                          "流程定义.json", "单独调用", ".当前状态.json"))
        child = self.project / "a" / "b"
        child.mkdir(parents=True)
        self.assertEqual(project_root(child), self.project)
        with patch("pathlib.Path.cwd", return_value=child):
            self.assertEqual(project_root(), self.project)
            self.assertEqual(project_root(self.project.parent), child.resolve())

    def test_resolve_output_root_and_escape(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_output_root(None, self.project), self.project / "产出")
            with patch.dict(os.environ, {"SKILLFUSE_OUTPUT_ROOT": "env"}):
                self.assertEqual(resolve_output_root(None, self.project), self.project / "env")
                self.assertEqual(resolve_output_root("explicit", self.project), self.project / "explicit")
        outside = self.project.parent / (self.project.name + "-outside")
        (self.project / "link").symlink_to(self.project.parent, target_is_directory=True)
        for value in ("../escape", "link/escape", str(outside)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                resolve_output_root(value, self.project)

    def test_names_ids_and_paths(self):
        self.assertEqual(sanitize_name(" a/b\\c\x00 "), "abc")
        for name in ("", ".", "..", " / "):
            with self.assertRaises(ValueError):
                sanitize_name(name)
        for node_id in ("2.2", "口径与标签"):
            self.assertIsNone(validate_node_id(node_id))
        for node_id in ("", "a/b", "a@b", "a#b", "a:b", "a b", "a\x00b"):
            with self.subTest(node_id=node_id), self.assertRaises(ValueError):
                validate_node_id(node_id)
        task = task_dir_path(self.project, "B/卡", "课题", False)
        self.assertEqual(task, self.project / "B卡" / "【课题】课题")
        self.assertEqual(task_dir_path(self.project, "B卡", "草稿", True),
                         self.project / "B卡" / "【临时】草稿")
        flow = {"节点": {"2.2": {"目录": ["2_开发", "2.2_模型"]}}}
        self.assertEqual(node_dir(task, flow, "2.2"), task / "2_开发" / "2.2_模型")

    def test_version_numbers_and_allocation(self):
        parent = self.project / "节点"
        self.assertEqual(list_versions(parent), [])
        for number in (1, 3):
            (parent / version_dir_name(number)).mkdir(parents=True)
        (parent / "第2版.txt").write_text("x", encoding="utf-8")
        self.assertEqual(parse_version_number("第3版"), 3)
        for name in ("第0版", "第01版", "第3版.txt", "第-1版"):
            self.assertIsNone(parse_version_number(name))
        self.assertEqual(list_versions(parent), [1, 3])
        number, directory = allocate_version_dir(parent)
        self.assertEqual((number, directory), (4, parent / "第4版"))
        self.assertEqual({path.name for path in directory.iterdir()}, set(VERSION_SUBDIRS))
        for invalid in (0, -1):
            with self.assertRaises(ValueError):
                version_dir_name(invalid)

    def test_concurrent_allocation(self):
        parent = self.project / "并发"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: allocate_version_dir(parent), range(2)))
        self.assertEqual(sorted(number for number, _ in results), [1, 2])
        self.assertTrue(all(all((path / subdir).is_dir() for subdir in VERSION_SUBDIRS)
                            for _, path in results))

    def test_refs(self):
        self.assertEqual(version_ref("2.2", 3), "2.2@v3")
        self.assertEqual(handoff_dir_name(2, "结论/交付", datetime(2026, 9, 28)),
                         "交接2_结论交付_0928")
        base = {"课题": None, "节点": "2.2", "版本": 3, "跳过": False,
                "交接": None, "嵌套": []}
        self.assertEqual(parse_ref("2.2@v3"), base)
        self.assertEqual(parse_ref("1.3@跳过"),
                         {**base, "节点": "1.3", "版本": None, "跳过": True})
        self.assertEqual(parse_ref("交接#2"),
                         {**base, "节点": "", "版本": None, "交接": 2})
        self.assertEqual(parse_ref("q3-bcard/2.2@v3"), {**base, "课题": "q3-bcard"})
        self.assertEqual(parse_ref("2.2@v3/取数@v1"),
                         {**base, "嵌套": [{"节点": "取数", "版本": 1}]})
        for ref in ("", "2.2@v0", "2.2@v03", "bad//id@v1", "交接#0", "交接#01",
                    "2.2@跳过/取数@v1", "q/1.3@跳过", "q/2.2@v3/取数@v1",
                    "Q/2.2@v3", "2.2@v3/取数@跳过", "2.2@v3/取数@v1/more@v1"):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                parse_ref(ref)

    def test_state_and_session(self):
        root = self.project / "产出"
        self.assertEqual(read_state(root), {})
        state = {"当前课题": "甲"}
        write_state(root, state)
        state["当前课题"] = "乙"
        self.assertEqual(read_state(root), {"当前课题": "甲"})
        with (root / STATE_FILE).open("r", encoding="utf-8") as stream:
            self.assertEqual(json.load(stream)["当前课题"], "甲")
        with patch.dict(os.environ, {"SKILLFUSE_SESSION": "a", "CLAUDE_SESSION_ID": "b",
                                     "CODEX_SESSION_ID": "c"}):
            self.assertEqual(session_id(), "a")
            os.environ.pop("SKILLFUSE_SESSION")
            self.assertEqual(session_id(), "b")
            os.environ.pop("CLAUDE_SESSION_ID")
            self.assertEqual(session_id(), "c")
            os.environ.pop("CODEX_SESSION_ID")
            self.assertRegex(session_id(), r"^local-\d{8}$")


if __name__ == "__main__":
    unittest.main()
