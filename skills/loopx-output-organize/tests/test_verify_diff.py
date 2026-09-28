"""通过真实 steward 命令构造课题并验证体检、对比。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import ledger


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class VerifyDiffTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        (self.project / ".git").mkdir()
        self.root = self.project / "产出"
        self.flow = self.project / "flow.json"
        write(self.flow, {"流程": "体检流程", "分组": [{"id": "阶段", "节点": [
            {"id": "a", "执行方": "代码", "交接": "成果"}]}]})
        self.task = self.begin("first")

    def run_script(self, script, *args, code=0):
        environment = os.environ.copy()
        environment.pop("SKILLFUSE_OUTPUT_ROOT", None)
        result = subprocess.run([sys.executable, str(SCRIPTS / script), "--output-root", str(self.root),
                                 *map(str, args)], cwd=self.project, env=environment,
                                capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1, result.stdout)
        return json.loads(result.stdout)

    def cli(self, *args):
        result = self.run_script("steward.py", *args)
        # 破坏前的每份真实台账均做双重校验。
        for path in self.root.rglob("产出台账.json"):
            data = read(path)
            self.assertEqual(ledger.validate_version_ledger(data), [])
            try:
                import jsonschema
            except ImportError:
                continue
            jsonschema.validate(data, read(SCRIPTS.parent / "references" / "产出台账.schema.json"))
        return result

    def begin(self, slug):
        return Path(self.cli("task-begin", "--name", slug, "--slug", slug,
                             "--flow", self.flow)["课题目录"])

    def alloc(self, *args):
        return Path(self.cli("alloc", "--node", "a", "--skill", "demo",
                             "--skill-version", "1.2.0", *args)["目录"])

    def finish(self, directory, metrics=None, text="结果", steps=1, fail=False, extra=None):
        (directory / "报告" / "结果.md").write_text(text, encoding="utf-8")
        (directory / "执行记录" / "trace.jsonl").write_text(
            ''.join(json.dumps({"status": "fail" if fail and i == 0 else "ok"}) + '\n'
                    for i in range(steps)), encoding="utf-8")
        if extra:
            (directory / "数据" / extra).write_text("数据", encoding="utf-8")
        self.cli("commit", "--dir", directory, "--status", "成功", "--primary", "报告/结果.md",
                 "--metrics", json.dumps(metrics or {}))
        return directory

    def completed(self, **kwargs):
        return self.finish(self.alloc(), **kwargs)

    def verify(self, code=0, *args):
        return self.run_script("verify.py", *args, code=code)

    def assert_problem(self, text, code=1, level="error"):
        result = self.verify(code)
        self.assertTrue(any(text in p["说明"] and p["级别"] == level for p in result["问题"]), result)
        for problem in result["问题"]:
            self.assertEqual(set(problem), {"级别", "位置", "说明", "怎么修"})
        return result

    def mutate_ledger(self, directory, **fields):
        path = directory / "产出台账.json"
        write(path, {**read(path), **fields})

    def test_cross_agent_handoff_and_baseline_references(self):
        source = self.completed()
        self.cli("handoff", "--node", "a")
        definition = read(self.flow)
        definition["流程"] = "另一智能体"
        write(self.flow, definition)
        target = Path(self.cli("task-begin", "--name", "second", "--slug", "second",
                               "--flow", self.flow, "--inherit", "first/交接#1")["课题目录"])
        directory = self.alloc("--baseline", "first/a@v1")
        self.finish(directory)
        self.assertEqual(self.verify()["问题"], [])
        self.assertTrue(self.diff(1, 1, "--from-task", "first")["基线关系"]["to版以from版为基线"])
        for reference in ("missing/交接#1", "first/交接#99", "missing/a@v1", "first/a@v99"):
            self.mutate_ledger(directory, 输入=[{"引用": reference, "角色": "参考"}])
            self.assert_problem(reference)
        self.assertIn("first/交接#1", (target / "课题说明.md").read_text(encoding="utf-8"))

    def test_clean(self):
        self.completed()
        self.assertEqual(self.verify()["汇总"], {"课题": 1, "版本": 1, "error": 0, "warning": 0})
        self.assertEqual(self.verify(0, "--task", self.task.name)["问题"], [])

    def test_artifact_tampering(self):
        directory = self.completed()
        (directory / "报告" / "结果.md").write_text("篡改产物", encoding="utf-8")
        result = self.assert_problem("sha256")
        self.assertTrue(any("字节数" in p["说明"] for p in result["问题"]))

    def test_unregistered_file(self):
        directory = self.completed()
        (directory / "多余.txt").write_text("多余", encoding="utf-8")
        self.assert_problem("未登记")

    def test_missing_middle_version(self):
        self.completed()
        middle = self.completed()
        self.completed()
        shutil.rmtree(middle)
        self.assert_problem("版本号不连续")
        self.assert_problem("引用的版本不存在")

    def test_bad_event_line(self):
        self.completed()
        with (self.task / "流转记录.jsonl").open("a", encoding="utf-8") as target:
            target.write('{bad\n')
        self.assert_problem("坏行")

    def test_event_sequence_and_duplicate_number(self):
        self.completed()
        self.cli("handoff", "--node", "a")
        path = self.task / "流转记录.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines()
        with path.open("a", encoding="utf-8") as target:
            target.write(lines[-1] + '\n')
        self.assert_problem("序号不连续")
        self.assert_problem("编号重复")

    def test_issue_close_reuses_number(self):
        path = self.task / "流转记录.jsonl"
        records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        for action in ("新增", "关闭"):
            records.append({"序号": len(records) + 1, "时间": datetime.now(timezone.utc).isoformat(),
                            "会话": "test", "类型": "未解决项", "编号": 1, "动作": action})
        path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding="utf-8")
        self.assertEqual(self.verify()["问题"], [])

    def test_handoff_tampering(self):
        self.completed()
        self.cli("handoff", "--node", "a")
        self.assertEqual(self.verify()["问题"], [])
        copy = next((self.task / "交接与交付").glob("*/交付物/*/*"))
        copy.write_text("篡改", encoding="utf-8")
        self.assert_problem("交接副本 sha256")

    def test_directory_name_mismatch(self):
        directory = self.completed()
        self.mutate_ledger(directory, 中文目录名="错误/路径")
        self.assert_problem("中文目录名")

    def test_nested_tampering(self):
        parent = self.alloc()
        nested = Path(self.cli("alloc", "--node", "取数", "--parent", parent)["目录"])
        self.finish(nested)
        self.finish(parent)
        self.assertEqual(self.verify()["问题"], [])
        (nested / "报告" / "结果.md").write_text("篡改", encoding="utf-8")
        result = self.assert_problem("sha256")
        self.assertTrue(any("内部调用" in p["位置"] for p in result["问题"]))

    def test_nested_unregistered_and_invalid_ledger(self):
        parent = self.alloc()
        nested = Path(self.cli("alloc", "--node", "取数", "--parent", parent)["目录"])
        self.finish(nested)
        self.finish(parent)
        (nested / "数据" / "多余.txt").write_text("多余", encoding="utf-8")
        self.mutate_ledger(nested, 执行状态="不存在")
        self.assert_problem("执行状态")
        self.assert_problem("未登记")

    def test_broken_flow_does_not_stop_other_tasks(self):
        self.completed()
        other = self.begin("second")
        directory = self.completed()
        (self.task / "流程定义.json").write_text("{broken", encoding="utf-8")
        (directory / "报告" / "结果.md").write_text("篡改", encoding="utf-8")
        result = self.assert_problem("流程定义无效")
        self.assertEqual(result["汇总"]["课题"], 2)
        self.assertEqual(result["汇总"]["版本"], 2)
        self.assertTrue(any(other.name in p["位置"] and "sha256" in p["说明"] for p in result["问题"]))

    def test_invalid_frozen_flow(self):
        self.completed()
        path = self.task / "流程定义.json"
        original = read(path)
        for replacement in ({"schema_version": "1.0"}, {"顺序": ["不存在"]}, {"节点": []}):
            with self.subTest(replacement=replacement):
                write(path, {**original, **replacement})
                self.assert_problem("流程定义无效")
        for dependencies in (["a"], None):
            with self.subTest(dependencies=dependencies):
                invalid = json.loads(json.dumps(original))
                invalid["节点"]["a"]["依赖"] = dependencies
                write(path, invalid)
                self.assert_problem("流程定义无效")

    def test_cross_task_input_reference(self):
        source = self.completed()
        self.begin("second")
        directory = self.completed()
        self.mutate_ledger(directory, 输入=[{"引用": "first/a@v1", "角色": "参考"}])
        self.assertEqual(self.verify()["问题"], [])
        shutil.rmtree(source)
        self.assert_problem("first/a@v1")

    def test_old_in_progress_warning(self):
        directory = self.alloc()
        self.mutate_ledger(directory, 创建时间=(datetime.now(timezone.utc) - timedelta(hours=25)).isoformat())
        self.assert_problem("超过 24 小时", code=0, level="warning")

    def test_missing_metadata_and_ledger(self):
        directory = self.completed()
        (self.task / "课题.json").unlink()
        (directory / "产出台账.json").unlink()
        result = self.verify(1)
        self.assertEqual(result["汇总"]["课题"], 1)
        for name in ("课题.json", "产出台账.json"):
            self.assertTrue(any(p["位置"].endswith(name) for p in result["问题"]))

    def test_missing_input_reference(self):
        directory = self.completed()
        self.mutate_ledger(directory, 输入=[{"引用": "a@v99", "角色": "参考"}])
        self.assert_problem("a@v99")

    def test_unknown_node_warning(self):
        directory = self.completed()
        unknown = directory.parent.parent / "未知节点"
        shutil.copytree(directory.parent, unknown)
        self.mutate_ledger(unknown / "第1版", 中文目录名=(unknown / "第1版").relative_to(self.root).as_posix())
        self.assert_problem("节点不在流程", code=0, level="warning")

    def test_removed_node_is_not_unknown(self):
        self.completed()
        write(self.flow, {"流程": "体检流程", "分组": []})
        self.cli("flow-update", "--flow", self.flow, "--reason", "移出")
        self.assertEqual(self.verify()["问题"], [])

    def diff(self, old=1, new=2, *args):
        return self.run_script("diff.py", "--node", "a", "--from", old, "--to", new, *args)

    def test_diff_same_task(self):
        self.completed(metrics={"score": 0.1, "gone": 2, "flag": True, "label": "旧"}, extra="旧.txt")
        self.completed(metrics={"score": 0.223456789, "new": 3, "flag": False, "label": "新"},
                       text="新结果", steps=2, fail=True, extra="新.txt")
        result = self.diff()
        self.assertTrue(result["基线关系"]["to版以from版为基线"])
        self.assertEqual(result["metrics"]["score"]["差值"], 0.123457)
        self.assertEqual(result["metrics"]["gone"]["变化"], "消失")
        self.assertEqual(result["metrics"]["new"]["变化"], "新增")
        self.assertEqual(result["metrics"]["score"]["变化"], "保留")
        self.assertIsNone(result["metrics"]["flag"]["差值"])
        self.assertIsNone(result["metrics"]["label"]["差值"])
        self.assertEqual(result["产物清单"]["新增文件"], ["数据/新.txt"])
        self.assertEqual(result["产物清单"]["删除文件"], ["数据/旧.txt"])
        self.assertEqual(result["产物清单"]["sha256变化的文件"], sorted(["报告/结果.md", "执行记录/trace.jsonl"]))
        for key in ("步骤数", "失败数"):
            self.assertEqual(result["执行记录"][key]["差值"], 1)
        for side in ("from", "to"):
            self.assertEqual(result[side]["skill版本"], "1.2.0")
            self.assertEqual(result[side]["执行状态"], "成功")
            self.assertIn("创建时间", result[side])
            self.assertIn("触发", result[side])
            self.assertIn("评审结论", result[side])
        self.assertIn("基线关系已确认", result["文本摘要"])

    def test_diff_nonbaseline(self):
        self.completed()
        self.completed()
        self.completed()
        result = self.diff(1, 3)
        self.assertFalse(result["基线关系"]["to版以from版为基线"])
        self.assertIn("可能不可靠", result["文本摘要"])
        self.assertEqual(result["产物清单"]["未变化的文件数"], 2)

    def test_diff_cross_task(self):
        self.completed(metrics={"source": 1})
        self.begin("second")
        directory = self.completed(metrics={"target": 2})
        for selector in ("first", self.task.name):
            result = self.diff(1, 1, "--from-task", selector, "--task", "second")
            self.assertEqual(result["metrics"]["source"]["变化"], "消失")
            self.assertFalse(result["基线关系"]["to版以from版为基线"])
            self.assertIn("跨课题", result["文本摘要"])
        self.mutate_ledger(directory, 基线={"引用": "first/a@v1", "策略": "上一版"})
        result = self.diff(1, 1, "--from-task", "first")
        self.assertTrue(result["基线关系"]["to版以from版为基线"])
        self.mutate_ledger(directory, 基线={"引用": "a@v1", "策略": "上一版"})
        self.assertFalse(self.diff(1, 1, "--from-task", "first")["基线关系"]["to版以from版为基线"])

    def test_diff_invalid_version(self):
        self.completed()
        result = self.run_script("diff.py", "--node", "a", "--from", 1, "--to", 99, code=1)
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
