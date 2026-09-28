"""命令入口的临时项目 subprocess 回归测试。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import ledger
import layout
import state


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        (self.project / ".git").mkdir()
        self.root = self.project / "产出"
        self.raw = {"流程": "测试流程", "分组": [
            {"id": "一", "节点": [
                {"id": "a", "执行方": "人工", "可跳过": True},
                {"id": "b", "执行方": "人工", "依赖": ["a"]},
                {"id": "g", "执行方": "人工", "门禁": True, "交接": "阶段交接",
                 "结论": {"验收合格": "通过"}, "可打回至": ["a", "x"], "可补证至": ["b"]}]},
            {"id": "二", "节点": [
                {"id": "x", "执行方": "人工", "基线": "固定首版", "可外部交付": True},
                {"id": "y", "执行方": "人工", "基线": "无", "依赖": ["交接:阶段交接"]},
                {"id": "c", "执行方": "人工", "循环": {"与": "d", "最大轮次": 1}},
                {"id": "d", "执行方": "人工"}]}]}
        self.source = self.project / "flow.json"
        self.save_flow()

    def save_flow(self):
        self.source.write_text(json.dumps(self.raw, ensure_ascii=False), encoding="utf-8")

    def cli(self, *args, code=0, injection=None):
        environment = os.environ.copy()
        environment.pop("SKILLFUSE_OUTPUT_ROOT", None)
        if injection:
            command = [sys.executable, "-c", injection, *map(str, args)]
        else:
            command = [sys.executable, str(SCRIPTS / "steward.py"), *map(str, args)]
        result = subprocess.run(command, cwd=self.project, env=environment,
                                capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1, result.stdout)
        data = json.loads(result.stdout)
        if code:
            self.assertEqual(set(data), {"error"})
        elif args[0] != "flow-check":
            for task in self.root.glob("*/*/课题.json"):
                self.assertTrue((task.parent / "总览.md").exists())
                self.assert_indexes(task.parent)
            self.assertTrue((self.root / "总索引.md").exists())
        return data

    def assert_indexes(self, task):
        current = state.load_task_state(task)
        for node in current.flow["节点"]:
            directory = layout.node_dir(task, current.flow, node)
            selected = current.current(node)
            name = None
            if selected == "跳过":
                name = "已跳过"
            elif isinstance(selected, int):
                name = f"当前采用_第{selected}版"
                if current.validity(node, selected) == "过期":
                    name += "_已过期"
            elif current.ledgers.get(node):
                name = "当前采用_无"
            if name and current.pending_triggers(node):
                name += "_待重做"
            actual = sorted(p.name for p in directory.glob("*.md")
                            if p.name.startswith(("当前采用_", "已跳过")))
            self.assertEqual(actual, [name + ".md"] if name else [], str(directory))

    def tearDown(self):
        for path in self.root.rglob("产出台账.json"):
            data = read(path)
            self.assertEqual(ledger.validate_version_ledger(data), [], str(path))
            try:
                import jsonschema
            except ImportError:
                continue
            schema = read(SCRIPTS.parent / "references" / "产出台账.schema.json")
            jsonschema.validate(data, schema)

    def begin(self, *args):
        result = self.cli("task-begin", "--name", "测试", "--flow", self.source, *args)
        self.task = Path(result["课题目录"])
        return result

    def alloc(self, node="a", *args, **kwargs):
        return self.cli("alloc", "--node", node, *args, **kwargs)

    def finish(self, allocation, *args, code=0):
        directory = Path(allocation["目录"])
        (directory / "报告" / "结果.md").write_text("结果", encoding="utf-8")
        (directory / "执行记录" / "trace.jsonl").write_text('{"status":"ok"}\n', encoding="utf-8")
        return self.cli("commit", "--dir", directory, "--status", "成功", "--primary", "报告/结果.md", *args, code=code)

    def test_node_history_and_adoption_reason(self):
        self.begin()
        self.finish(self.alloc())
        self.finish(self.alloc())
        detail = self.cli("status", "--node", "a")["节点"]
        self.assertEqual(set(detail), {"a"})
        self.assertIsNone(detail["a"]["采用原因"])
        self.cli("adopt", "--node", "a", "--version", 1, "--reason", "首版更好")
        detail = self.cli("status", "--node", "a")["节点"]["a"]
        self.assertEqual(detail["当前采用"], 1)
        self.assertEqual(detail["采用原因"], "首版更好")
        self.assertEqual([item["有效性"] for item in detail["版本历史"]], ["当前采用", "已替代"])
        self.assertEqual([item["触发"] for item in detail["版本历史"]], ["首次", "重跑"])
        self.assertEqual(set(detail["版本历史"][0]), {"版本", "执行状态", "有效性", "触发", "评审结论", "创建时间"})
        self.cli("status", "--node", "不存在", code=1)

    def test_rework_source_and_requirement(self):
        self.begin()
        self.assertIsNone(self.alloc()["重做要求"])
        for verdict, kind in (("整改后复验", "打回"), ("补证后再判", "补证")):
            gate = self.alloc("g")
            self.finish(gate, "--verdict", verdict, "--to", "a", "--reason", "补充区域要求", "--confirm", "批准")
            allocation = self.alloc()
            self.assertEqual(allocation["重做要求"], {"类型": kind, "编号": 1, "来源": gate["引用"], "原因": "补充区域要求"})
            self.assertIn({"引用": gate["引用"], "角色": "参考"}, allocation["输入"])
            self.assertIn({"引用": gate["引用"], "角色": "参考"}, read(Path(allocation["目录"]) / "产出台账.json")["输入"])
            self.finish(allocation)

    def test_round_records_required_and_optional(self):
        self.raw["分组"][1]["节点"][2]["循环"]["每轮必记"] = ["本轮调整", "复评结果"]
        self.save_flow()
        self.begin()
        allocation = self.alloc("c")
        path = Path(allocation["目录"]) / "产出台账.json"
        original = read(path)
        events = (self.task / "流转记录.jsonl").read_text(encoding="utf-8")
        for args in ((), ("--round", "{}"), ("--round", '[]'),
                     ("--round", '{"本轮调整":"调整"}'),
                     ("--round", '{"本轮调整":"调整","复评结果":""}')):
            self.finish(allocation, *args, code=1)
            self.assertEqual(read(path), original)
            self.assertEqual((self.task / "流转记录.jsonl").read_text(encoding="utf-8"), events)
        record = {"本轮调整": "调整", "复评结果": "通过"}
        self.finish(allocation, "--round", json.dumps(record))
        self.assertEqual(read(path)["轮次记录"], record)
        ordinary = self.alloc()
        self.finish(ordinary, "--round", json.dumps(record))
        self.assertEqual(read(Path(ordinary["目录"]) / "产出台账.json")["轮次记录"], record)
        failed = self.alloc("c", "--override", "保留失败现场")
        self.cli("commit", "--dir", failed["目录"], "--status", "失败")

    def test_final_handoff_issue_dispositions(self):
        self.begin()
        self.finish(self.alloc())
        self.finish(self.alloc("b"))
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "带问题通过", "--issue", '{"描述":"问题一"}', "--issue", '{"描述":"问题二"}')
        error = self.cli("handoff", "--node", "g", code=1)["error"]
        self.assertIn("问题一", error)
        self.assertIn("问题二", error)
        self.cli("issue-close", "--id", 1, "--resolution", "接受", "--reason", "业务接受")
        self.assertIn("问题二", self.cli("handoff", "--node", "g", code=1)["error"])
        self.cli("issue-close", "--id", 2, "--resolution", "后续处理", "--reason", "下一轮处理")
        self.assertEqual(self.cli("handoff", "--node", "g")["未解决项"], [])
        text = (self.task / "未解决项.md").read_text(encoding="utf-8")
        self.assertIn("接受：业务接受", text)
        self.assertIn("后续处理：下一轮处理", text)

    def test_cross_agent_baseline_and_inheritance(self):
        self.begin("--slug", "first")
        source = self.alloc()
        self.finish(source)
        self.raw["流程"] = "另一智能体"
        self.save_flow()
        self.begin("--slug", "second", "--inherit", "first/a@v1")
        self.assertIn("继承：first/a@v1", (self.task / "课题说明.md").read_text(encoding="utf-8"))
        allocation = self.alloc("a", "--baseline", "first/a@v1")
        self.assertEqual(allocation["基线目录"], source["目录"])
        self.assertEqual(allocation["env"]["SKILLFUSE_BASELINE_DIR"], source["目录"])
        self.assertEqual(read(Path(allocation["目录"]) / "产出台账.json")["基线"], {"引用": "first/a@v1", "策略": "上一版"})
        self.assertIn({"引用": "first/a@v1", "角色": "基线"}, allocation["输入"])
        self.finish(allocation)
        self.cli("adopt", "--task", "first", "--node", "a", "--version", 1, "--reason", "采用")
        self.assertEqual(self.cli("status")["节点"]["a"]["有效性"], "当前采用")
        for reference in ("missing/a@v1", "first/a@v99", "first/missing@v1", "first/交接#1"):
            self.alloc("a", "--baseline", reference, code=1)

    def test_begin_template_json_implicit_idempotent_slug(self):
        first = self.begin("--slug", "test", "--criteria", "一", "--criteria", "二")
        note = self.task / "课题说明.md"
        note.write_text("人工说明", encoding="utf-8")
        before = (self.task / "流转记录.jsonl").read_text(encoding="utf-8")
        self.assertEqual(self.begin()["课题目录"], first["课题目录"])
        self.assertEqual(note.read_text(encoding="utf-8"), "人工说明")
        self.assertEqual((self.task / "流转记录.jsonl").read_text(encoding="utf-8"), before)
        self.cli("task-begin", "--name", "非法", "--slug", "BAD", code=1)
        implicit = self.cli("task-begin", "--name", "独立", "--temp")
        self.assertIn("单独调用/【临时】独立", implicit["课题目录"])
        template = self.cli("task-begin", "--name", "卡", "--flow-template", "B卡策略迭代")
        self.assertIn("B卡策略迭代", template["课题目录"])
        self.cli("task-begin", code=2)

    def test_flow_check_and_task_selection(self):
        self.assertEqual(self.cli("flow-check", "--flow", self.source)["节点数"], 7)
        self.assertFalse(self.root.exists())
        first = self.begin("--slug", "first")
        self.cli("status", "--task", "first")
        self.cli("status", "--task", "【课题】测试")
        self.raw["流程"] = "另一智能体"
        self.save_flow()
        second = self.begin("--slug", "second")
        error = self.cli("status", "--task", "【课题】测试", code=1)["error"]
        self.assertIn(first["课题目录"], error)
        self.assertIn(second["课题目录"], error)
        self.raw["分组"][0]["节点"][0]["执行方"] = "错误"
        self.save_flow()
        self.cli("flow-check", "--flow", self.source, code=1)

    def test_dependencies_force_handoff_and_skip(self):
        self.begin()
        self.alloc("b", code=1)
        forced = self.alloc("b", "--force-deps", "先做")
        self.assertEqual(forced["输入"], [])
        self.assertIn("先做", (self.task / "流转记录.jsonl").read_text(encoding="utf-8"))
        a = self.alloc()
        self.finish(a)
        b = self.alloc("b")
        self.assertIn({"引用": "a@v1", "角色": "依赖"}, b["输入"])
        self.alloc("y", code=1)
        self.cli("handoff", "--node", "g", code=1)
        self.cli("handoff", "--node", "g", "--confirm", "人工交付")
        self.assertIn({"引用": "交接#1", "角色": "依赖"}, self.alloc("y")["输入"])
        self.cli("skip", "--node", "a", "--reason", "不需要")
        self.assertIn({"引用": "a@跳过", "角色": "依赖"}, self.alloc("b")["输入"])
        self.cli("skip", "--node", "b", "--reason", "不需要", code=1)
        self.cli("skip", "--node", "b", "--reason", "不需要", "--confirm", "批准")
        self.assertTrue((Path(b["目录"]).parent / "已跳过.md").exists())

    def test_baselines_previous_and_env(self):
        self.begin()
        a1 = self.alloc()
        self.finish(a1)
        a2 = self.alloc()
        self.cli("commit", "--dir", a2["目录"], "--status", "失败")
        a3 = self.alloc()
        self.assertEqual(a3["基线目录"], a1["目录"])
        self.assertEqual(a3["上一版目录"], a2["目录"])
        self.assertEqual(set(a3["env"]), {"SKILLFUSE_OUTPUT_DIR", "SKILLFUSE_BASELINE_DIR", "SKILLFUSE_PREVIOUS_DIR", "SKILLFUSE_OUTPUT_VERSION", "SKILLFUSE_NODE", "SKILLFUSE_TASK_DIR"})
        self.assertIsNone(self.alloc("a", "--baseline", "none")["基线目录"])
        self.assertEqual(self.alloc("a", "--baseline", "2")["基线目录"], a2["目录"])
        self.alloc("a", "--baseline", "99", code=1)
        x1 = self.alloc("x")
        self.finish(x1)
        self.finish(self.alloc("x"))
        self.assertEqual(self.alloc("x")["基线目录"], x1["目录"])
        self.alloc("y", "--force-deps", "测试")
        self.assertIsNone(self.alloc("y", "--force-deps", "测试")["基线目录"])

    def test_loop_external_and_implicit(self):
        self.begin()
        self.alloc("c")
        self.alloc("c", code=1)
        self.assertEqual(self.alloc("c", "--override", "增加一轮")["触发"]["类型"], "循环")
        self.alloc("d")
        self.alloc("d", code=1)
        self.alloc("a", "--external", "团队", code=1)
        external = self.alloc("a", "--external", "团队", "--override", "批准")
        self.assertEqual(read(Path(external["目录"]) / "产出台账.json")["外部团队"], "团队")
        self.alloc("x", "--external", "团队")
        self.cli("task-begin", "--name", "独立")
        implicit = self.alloc("worker", "--skill-cn", "取数", "--skill", "worker")
        self.assertEqual(implicit["节点"], "取数")
        self.assertEqual(self.alloc("worker", "--skill-cn", "取数")["版本"], 2)

    def test_nested_numbering_children_and_skill_meta(self):
        self.begin()
        source = self.project / "SKILL.md"
        source.write_text('---\nmetadata:\n  version: "1.2.0"\n---\n', encoding="utf-8")
        parent1, parent2 = self.alloc(), self.alloc()
        children = [self.alloc("fetch", "--skill-cn", "取数", "--parent", parent["目录"],
                               "--skill", "fetch", "--skill-file", source)
                    for parent in (parent1, parent1, parent2)]
        self.assertEqual([item["版本"] for item in children], [1, 2, 1])
        self.assertEqual(children[0]["引用"], "a@v1/取数@v1")
        data = read(Path(parent1["目录"]) / "产出台账.json")
        self.assertEqual(data["children"], [item["引用"] for item in children[:2]])
        child = read(Path(children[0]["目录"]) / "产出台账.json")
        self.assertEqual(child["skill"]["skill版本"], "1.2.0")
        self.assertEqual(child["skill"]["来源sha256"], ledger.sha256_file(source))
        override = self.alloc("fetch", "--parent", parent2["目录"], "--skill", "fetch",
                              "--skill-file", source, "--skill-version", "2.0.0")
        self.assertEqual(read(Path(override["目录"]) / "产出台账.json")["skill"]["skill版本"], "2.0.0")
        same_name = self.alloc("a", "--parent", parent1["目录"])
        self.finish(same_name)
        self.finish(children[0])
        self.assertIsNone(self.cli("status")["节点"]["a"]["当前采用"])

    def test_commit_gate_mapping_validation_and_trace_warning(self):
        self.begin()
        gate = self.alloc("g")
        self.finish(gate, code=1)
        result = self.finish(gate, "--verdict", "验收合格")
        self.assertEqual(result["评审结论"]["结论"], "通过")
        self.assertEqual(result["评审结论"]["原文"], "验收合格")
        self.assertIn("handoff --node g", result["下一步"])
        ordinary = self.alloc()
        self.finish(ordinary, "--verdict", "通过", code=1)
        path = Path(ordinary["目录"])
        before = (path / "产出台账.json").read_text(encoding="utf-8")
        log = (self.task / "流转记录.jsonl").read_text(encoding="utf-8")
        self.cli("commit", "--dir", path, "--status", "成功", code=1)
        self.assertEqual((path / "产出台账.json").read_text(encoding="utf-8"), before)
        self.assertEqual((self.task / "流转记录.jsonl").read_text(encoding="utf-8"), log)
        (path / "执行记录" / "trace.jsonl").write_text('{}\nbroken\n', encoding="utf-8")
        result = self.cli("commit", "--dir", path, "--status", "成功", "--primary", "报告/结果.md")
        self.assertIn("warning", result)
        self.assertEqual(set(read(path / "产出台账.json")["执行记录"]), {"路径", "步骤数", "失败数"})

    def test_rework_targets_confirm_and_pending(self):
        self.begin()
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "整改后复验", code=1)
        self.finish(gate, "--verdict", "整改后复验", "--to", "x", code=1)
        result = self.finish(gate, "--verdict", "整改后复验", "--to", "x", "--confirm", "跨阶段批准")
        self.assertEqual(result["下一步"], ["x"])
        self.assertEqual(self.alloc("x")["触发"], {"类型": "打回", "编号": 1})
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "整改后复验", "--to", "b", code=1)
        self.finish(gate, "--verdict", "整改后复验", "--to", "b", "--confirm", "新增目标")
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "补证后再判", code=1)
        self.finish(gate, "--verdict", "补证后再判", "--to", "a", code=1)
        self.finish(gate, "--verdict", "补证后再判", "--to", "a", "--confirm", "新增证据")
        self.assertEqual(self.alloc()["触发"], {"类型": "补证", "编号": 1})
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "补证后再判", "--to", "b")

    def test_issues_close_and_noncompliance_policy(self):
        self.raw["分组"][0]["节点"][2]["不达标处理"] = "带问题通过"
        self.save_flow()
        self.begin()
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "带问题通过", code=1)
        self.finish(gate, "--verdict", "带问题通过", "--issue", '{"描述":"待核实"}')
        self.assertEqual(len(self.cli("status")["未关闭未解决项"]), 1)
        self.cli("issue-close", "--id", 1, "--resolution", "接受", "--reason", "批准")
        self.cli("issue-close", "--id", 1, "--resolution", "已解决", "--reason", "重复", code=1)
        self.assertEqual(self.cli("status")["未关闭未解决项"], [])
        gate = self.alloc("g")
        self.finish(gate, "--verdict", "整改后复验", "--to", "a", code=1)
        self.finish(gate, "--verdict", "整改后复验", "--to", "a", "--confirm", "按整改处理")

    def test_adopt_update_status_and_indexes(self):
        self.begin()
        a1 = self.alloc()
        self.finish(a1)
        b = self.alloc("b")
        self.finish(b)
        a2 = self.alloc()
        self.finish(a2)
        self.assertTrue((Path(b["目录"]).parent / "当前采用_第1版_已过期.md").exists())
        self.cli("adopt", "--node", "a", "--version", 99, "--reason", "错误", code=1)
        self.cli("adopt", "--node", "a", "--version", 1, "--reason", "恢复")
        self.assertTrue((Path(b["目录"]).parent / "当前采用_第1版.md").exists())
        old = read(self.task / "流程定义.json")["节点"]["a"]["目录"]
        self.raw["分组"][0]["节点"][0]["名称"] = "改名"
        self.raw["分组"][0]["节点"].append({"id": "new", "执行方": "人工"})
        self.save_flow()
        summary = self.cli("flow-update", "--flow", self.source, "--reason", "更新")
        self.assertEqual(summary["新增"], ["new"])
        self.assertEqual(read(self.task / "流程定义.json")["节点"]["a"]["目录"], old)
        self.assertEqual(self.cli("status")["节点"]["a"]["当前采用"], 1)
        self.cli("skip", "--node", "new", "--reason", "不用", "--confirm", "批准")
        self.assertTrue((layout.node_dir(self.task, read(self.task / "流程定义.json"), "new") / "已跳过.md").exists())

    def injection(self, code):
        return f"import sys; sys.path.insert(0, {str(SCRIPTS)!r}); import steward; {code}; sys.exit(steward.main())"

    def test_rollback_alloc_commit_and_view_warning(self):
        self.begin()
        before = sorted(str(path) for path in self.root.rglob("*"))
        injection = self.injection("steward.ledger.write_ledger = lambda *a: (_ for _ in ()).throw(OSError('写入失败'))")
        self.cli("alloc", "--node", "a", code=1, injection=injection)
        self.assertEqual(sorted(str(path) for path in self.root.rglob("*")), before)
        a = self.alloc()
        path = Path(a["目录"]) / "产出台账.json"
        old = path.read_text(encoding="utf-8")
        log = (self.task / "流转记录.jsonl").read_text(encoding="utf-8")
        injection = self.injection("steward.events.append_event = lambda *a, **k: (_ for _ in ()).throw(OSError('事件失败'))")
        self.cli("commit", "--dir", a["目录"], "--status", "失败", code=1, injection=injection)
        self.assertEqual(path.read_text(encoding="utf-8"), old)
        self.assertEqual((self.task / "流转记录.jsonl").read_text(encoding="utf-8"), log)
        injection = self.injection("steward.views.write_views = lambda *a: (_ for _ in ()).throw(OSError('视图失败'))")
        result = self.cli("alloc", "--node", "a", injection=injection)
        self.assertIn("视图刷新失败", result["warning"][0])


if __name__ == "__main__":
    unittest.main()
