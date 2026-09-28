"""版本台账 v2 契约测试。"""

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "scripts"))
from layout import LEDGER_NAME
from ledger import (DONE_STATUSES, SCHEMA_VERSION, STATUSES, TRACE_REQUIRED,
                    TRIGGER_TYPES, count_trace_steps, finalize_version_ledger,
                    new_version_ledger, read_json, scan_artifacts, sha256_file,
                    validate_task_meta, validate_version_ledger, write_ledger)

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    Draft202012Validator = None


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        (self.project / ".git").mkdir()
        with (BASE / "references" / "产出台账.schema.json").open("r", encoding="utf-8") as source:
            self.schema = json.load(source)

    def ledger(self, executor="代码"):
        return new_version_ledger(引用="2.2@v3", 节点="2.2", 版本=3, 课题="q3-bcard",
                                  中文目录名="智能体/【课题】测试/2.2/第3版", 执行方=executor,
                                  创建时间="2026-09-28T10:00:00+00:00", 会话="local-20260928")

    def artifact(self, role="主交付物"):
        return {"相对路径": "报告/结果.md", "类型": "报告", "角色": role,
                "sha256": "a" * 64, "字节数": 12}

    def assert_both(self, data, valid):
        self.assertEqual(not validate_version_ledger(data), valid, validate_version_ledger(data))
        if Draft202012Validator is None:
            return
        validator = Draft202012Validator(self.schema, format_checker=FormatChecker())
        self.assertEqual(validator.is_valid(data), valid, list(validator.iter_errors(data)))

    def test_round_record_schema_and_copy(self):
        original = self.ledger()
        record = {"本轮调整": "调整参数"}
        updated = finalize_version_ledger(original, 轮次记录=record)
        record["本轮调整"] = "修改入参"
        self.assertEqual(updated["轮次记录"], {"本轮调整": "调整参数"})
        self.assertNotIn("轮次记录", original)
        self.assert_both(updated, True)
        for value in (None, [], {"本轮调整": ""}, {"复评结果": 0.4}, {"复评结果": False}):
            with self.subTest(value=value):
                self.assert_both({**original, "轮次记录": value}, False)

    def test_constants_and_cases(self):
        self.assertEqual((SCHEMA_VERSION, STATUSES, DONE_STATUSES, TRACE_REQUIRED, TRIGGER_TYPES),
                         ("2.0", ("进行中", "成功", "部分完成", "失败"),
                          ("成功", "部分完成"), ("skill", "代码", "智能体"),
                          ("首次", "打回", "补证", "循环", "外部接收", "重跑")))
        pending = self.ledger()
        code = finalize_version_ledger(pending, 执行状态="成功", artifacts=[self.artifact()],
                                       执行记录={"路径": "执行记录/trace.jsonl", "步骤数": 1, "失败数": 0})
        human = finalize_version_ledger(self.ledger("人工"), 执行状态="成功", artifacts=[self.artifact()])
        missing_trace = copy.deepcopy(code)
        del missing_trace["执行记录"]
        missing_trace["执行方"] = "skill"
        failed = finalize_version_ledger(pending, 执行状态="失败")
        two_primary = copy.deepcopy(code)
        two_primary["artifacts"].append({**self.artifact(), "相对路径": "报告/另一个.md"})
        bad_verdict = copy.deepcopy(human)
        bad_verdict["评审结论"] = {"结论": "随意", "原文": None, "理由": "", "目标": []}
        bad_external = copy.deepcopy(pending)
        bad_external["外部团队"] = "风控"
        nested = copy.deepcopy(code)
        nested.update({"引用": "2.2@v3/取数@v1", "节点": "取数", "版本": 1, "输入": []})
        for name, data, valid in (
            ("进行中占位", pending, True), ("代码成功", code, True),
            ("人工成功", human, True), ("skill缺trace", missing_trace, False),
            ("失败无产物", failed, True), ("两个主交付物", two_primary, False),
            ("非法门禁结论", bad_verdict, False), ("外部团队触发错误", bad_external, False),
            ("嵌套台账", nested, True),
        ):
            with self.subTest(name=name):
                self.assert_both(data, valid)
        self.assertEqual(pending["执行状态"], "进行中")
        self.assertEqual(pending["artifacts"], [])
        with self.assertRaises(ValueError):
            finalize_version_ledger(pending, 执行状态="成功")
        mismatch = copy.deepcopy(code)
        mismatch["引用"] = "2.2@v4"
        self.assertTrue(validate_version_ledger(mismatch))

    def test_scan_hash_trace_and_io(self):
        version = self.project / "第1版"
        for directory in ("报告", "数据", "执行记录", "日志", "内部调用/取数/第1版/报告"):
            (version / directory).mkdir(parents=True)
        (version / "报告/结果.md").write_text("报告", encoding="utf-8")
        (version / "内部调用/取数/第1版/报告/子.md").write_text("子", encoding="utf-8")
        (version / LEDGER_NAME).write_text("{}", encoding="utf-8")
        self.assertEqual(sha256_file(version / "报告/结果.md"), hashlib.sha256("报告".encode("utf-8")).hexdigest())
        artifacts = scan_artifacts(version, "报告/结果.md")
        self.assertEqual([item["相对路径"] for item in artifacts], ["报告/结果.md"])
        self.assertEqual(artifacts[0]["角色"], "主交付物")
        with self.assertRaises(FileNotFoundError):
            scan_artifacts(version, "报告/不存在.md")
        (version / "额外.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(ValueError):
            scan_artifacts(version, None)
        (version / "额外.txt").unlink()
        self.assertIsNone(count_trace_steps(version))
        (version / "执行记录/trace.jsonl").write_text('{"status":"ok"}\n坏行\n{"status":"fail"}\n', encoding="utf-8")
        (version / "内部调用/取数/第1版/报告/trace.jsonl").write_text('{"status":"fail"}\n', encoding="utf-8")
        self.assertEqual(count_trace_steps(version), {"路径": "执行记录/trace.jsonl", "步骤数": 2, "失败数": 1, "坏行数": 1})
        ledger = self.ledger()
        path = version / LEDGER_NAME
        write_ledger(path, ledger)
        self.assertEqual(read_json(path), ledger)
        with self.assertRaises(ValueError):
            write_ledger(path, {"schema_version": "1.0"})
        self.assertEqual(read_json(path), ledger)

    def test_task_meta(self):
        meta = {"schema_version": "2.0", "课题ID": "q3-bcard", "名称": "测试", "智能体": "智能体",
                "临时": False, "创建时间": "2026-09-28T10:00:00+00:00", "继承": None,
                "目标": "完成", "验收标准": ["通过"]}
        self.assertEqual(validate_task_meta(meta), [])
        bad = {**meta, "课题ID": "大写 ID", "临时": "否"}
        self.assertTrue(validate_task_meta(bad))
