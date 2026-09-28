"""派生状态契约测试。"""

import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "scripts"))

from events import append_event
from flow import normalize_flow
from layout import LEDGER_NAME, node_dir, version_dir_name
from ledger import (finalize_version_ledger, new_version_ledger,
                    validate_version_ledger, write_ledger)
from state import load_task_state

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    Draft202012Validator = None


class StateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / ".git").mkdir()
        self.task = self.root / "智能体" / "【课题】测试"
        self.task.mkdir(parents=True)
        with (BASE / "references/产出台账.schema.json").open("r", encoding="utf-8") as source:
            self.schema = json.load(source)
        self.make_flow()

    def make_flow(self, fixture="最小流程.json"):
        with (BASE / "tests/fixtures" / fixture).open("r", encoding="utf-8") as source:
            raw = json.load(source)
        self.flow = raw if "顺序" in raw else normalize_flow(raw)
        (self.task / "流程定义.json").write_text(json.dumps(self.flow, ensure_ascii=False), encoding="utf-8")
        self.meta = {"schema_version": "2.0", "课题ID": "test", "名称": "测试",
                     "智能体": "智能体", "临时": False, "创建时间": "2026-09-28T10:00:00+00:00",
                     "继承": None, "目标": "测试", "验收标准": []}
        (self.task / "课题.json").write_text(json.dumps(self.meta, ensure_ascii=False), encoding="utf-8")

    def event(self, type_, **fields):
        return append_event(self.task, type_, fields, session="test")

    def version(self, node, status="成功", inputs=(), trigger=None, submit=True):
        directory = node_dir(self.task, self.flow, node)
        number = len([item for item in directory.iterdir() if item.name.startswith("第")]) + 1 if directory.exists() else 1
        target = directory / version_dir_name(number)
        target.mkdir(parents=True)
        ledger = new_version_ledger(引用=f"{node}@v{number}", 节点=node, 版本=number,
                                    课题="test", 中文目录名=str(target.relative_to(self.root)),
                                    执行方=self.flow["节点"][node]["执行方"],
                                    创建时间="2026-09-28T10:00:00+00:00", 会话="test",
                                    输入=[{"引用": reference, "角色": "依赖"} for reference in inputs],
                                    触发=trigger or {"类型": "首次", "编号": None})
        if status != "进行中":
            fields = {"执行状态": status, "完成时间": "2026-09-28T11:00:00+00:00"}
            if status in ("成功", "部分完成"):
                fields["artifacts"] = [{"相对路径": "报告/结果.md", "类型": "报告",
                                         "角色": "主交付物", "sha256": "a" * 64, "字节数": 1}]
                if ledger["执行方"] in ("skill", "代码", "智能体"):
                    fields["执行记录"] = {"路径": "执行记录/trace.jsonl", "步骤数": 1, "失败数": 0}
            ledger = finalize_version_ledger(ledger, **fields)
        self.assertEqual(validate_version_ledger(ledger), [])
        if Draft202012Validator is not None:
            self.assertTrue(Draft202012Validator(self.schema, format_checker=FormatChecker()).is_valid(ledger))
        write_ledger(target / LEDGER_NAME, ledger)
        if submit and status != "进行中":
            self.event("提交", 节点=node, 版本=number, 执行状态=status, 评审结论=None)
        return number

    def state(self):
        return load_task_state(self.task)

    def test_a_submit_only_done_becomes_current(self):
        self.version("1.1")
        self.version("1.1", "失败")
        self.version("1.1", "进行中")
        state = self.state()
        self.assertEqual(state.current("1.1"), 1)
        self.assertEqual([state.validity("1.1", n) for n in (1, 2, 3)],
                         ["当前采用", "失败", "进行中"])
        self.assertEqual(state.rounds("1.1"), 3)

    def test_b_adopt_old_version_stales_new_dependents(self):
        self.version("1.1")
        self.version("1.1")
        self.version("1.2", inputs=["1.1@v2"])
        self.event("采用", 节点="1.1", 版本=1, 原因="回退")
        state = self.state()
        self.assertEqual(state.current("1.1"), 1)
        self.assertEqual(state.validity("1.1", 2), "已替代")
        self.assertEqual(state.validity("1.2", 1), "过期")
        self.assertIn("依赖 1.1 当前采用第1版，本版用的是第2版", state.stale_reasons("1.2", 1))

    def test_c_latest_success_wins_after_adopt(self):
        self.version("1.1")
        self.version("1.1")
        self.event("采用", 节点="1.1", 版本=1, 原因="回退")
        self.version("1.1", "部分完成")
        self.assertEqual(self.state().current("1.1"), 3)

    def test_d_skip_dependency_expires_after_submit(self):
        self.event("跳过", 节点="2.3", 原因="不需要", 人工确认=None)
        self.version("1.1", inputs=["2.3@跳过"])
        state = self.state()
        self.assertEqual(state.current("2.3"), "跳过")
        self.assertEqual(state.validity("1.1", 1), "当前采用")
        self.version("2.3")
        state = self.state()
        self.assertEqual(state.validity("1.1", 1), "过期")
        self.assertIn("2.3 不再是跳过状态", state.stale_reasons("1.1", 1))

    def test_e_transitive_staleness(self):
        self.version("1.1")
        self.version("1.2", inputs=["1.1@v1"])
        self.version("1.3", inputs=["1.2@v1"])
        self.version("1.1")
        state = self.state()
        self.assertEqual(state.validity("1.2", 1), "过期")
        self.assertEqual(state.validity("1.3", 1), "过期")
        self.assertIn("依赖 1.2@v1 已过期", state.stale_reasons("1.3", 1))

    def test_f_unrelated_branch_unchanged(self):
        self.version("1.1")
        self.version("1.2", inputs=["1.1@v1"])
        self.version("2.1")
        self.version("1.1")
        state = self.state()
        self.assertEqual(state.validity("1.2", 1), "过期")
        self.assertEqual(state.validity("2.1", 1), "当前采用")

    def test_g_handoff_superseded_only_by_same_name(self):
        self.event("交接", 编号=1, 名称="甲", 节点="1.3", 清单={}, 未解决项=[], 人工确认=None)
        self.version("2.1", inputs=["交接#1"])
        self.event("交接", 编号=2, 名称="乙", 节点="2.2", 清单={}, 未解决项=[], 人工确认=None)
        self.assertEqual(self.state().validity("2.1", 1), "当前采用")
        self.event("交接", 编号=3, 名称="甲", 节点="1.3", 清单={}, 未解决项=[], 人工确认=None)
        state = self.state()
        self.assertEqual(state.validity("2.1", 1), "过期")
        self.assertIn("交接#1 已被交接#3 取代", state.stale_reasons("2.1", 1))
        self.assertEqual(len(state.handoffs("甲")), 2)
        self.assertEqual(state.latest_handoff("甲")["编号"], 3)

    def test_h_pending_triggers_consume_only_done(self):
        trigger = self.event("打回", 编号=1, 来源="1.3@v1", 目标=["1.2"], 原因="重做",
                             跨阶段=False, 人工确认=None)
        self.assertEqual(self.state().pending_triggers("1.2"), [trigger])
        self.version("1.2", "失败", trigger={"类型": "打回", "编号": 1})
        self.assertEqual(self.state().pending_triggers("1.2"), [trigger])
        self.version("1.2", trigger={"类型": "打回", "编号": 1})
        self.assertEqual(self.state().pending_triggers("1.2"), [])
        evidence = self.event("补证", 编号=1, 来源="1.3@v1", 目标=["1.2"], 原因="补齐", 人工确认=None)
        self.assertEqual(self.state().pending_triggers("1.2"), [evidence])

    def test_i_open_issues(self):
        first = self.event("未解决项", 编号=1, 动作="新增", 来源="1.1@v1", 描述="问题一",
                           指标="", 标准="", 差值="")
        second = self.event("未解决项", 编号=2, 动作="新增", 来源="1.1@v1", 描述="问题二",
                            指标="", 标准="", 差值="")
        self.event("未解决项", 编号=1, 动作="关闭", 处理="已解决", 原因="完成")
        self.assertEqual(self.state().open_issues(), [second])
        self.assertNotEqual(first, second)

    def test_j_handoff_outdated(self):
        self.version("1.1")
        self.version("1.2")
        handoff = self.event("交接", 编号=1, 名称="甲", 节点="1.3",
                             清单={"1.1": "1.1@v1", "1.2": "1.2@v1"}, 未解决项=[], 人工确认=None)
        self.assertEqual(self.state().handoff_outdated(handoff), [])
        self.version("1.1")
        self.assertEqual(self.state().handoff_outdated(handoff), ["1.1"])

    def test_k_todo_reasons_and_order(self):
        self.version("1.1")
        self.version("1.1")
        self.version("1.2", inputs=["1.1@v2"])
        self.version("2.1", inputs=["1.1@v1"])
        self.event("打回", 编号=1, 来源="1.3@v1", 目标=["2.2"], 原因="重做",
                   跨阶段=False, 人工确认=None)
        todo = self.state().todo()
        self.assertEqual([item["节点"] for item in todo], ["1.3", "2.1", "2.2"])
        self.assertIn("依赖已就绪但未开始", todo[0]["原因"])
        self.assertIn("过期", todo[1]["原因"])
        self.assertIn("打回#1", todo[2]["原因"])

    def test_l_bcard_scale(self):
        self.make_flow("B卡策略迭代.json")
        previous = None
        for node in self.flow["顺序"]:
            for _ in range(5):
                self.version(node, inputs=[f"{previous}@v5"] if previous else [])
            previous = node
        started = time.perf_counter()
        state = self.state()
        results = [state.validity(node, version) for node in state.flow["顺序"] for version in range(1, 6)]
        self.assertLess(time.perf_counter() - started, 2)
        self.assertEqual(results.count("当前采用"), 33)

    def test_dependency_cycle_is_stale(self):
        self.version("1.1", inputs=["1.2@v1"])
        self.version("1.2", inputs=["1.1@v1"])
        state = self.state()
        self.assertEqual(state.validity("1.1", 1), "过期")
        self.assertEqual(state.validity("1.2", 1), "过期")
        self.assertIn("依赖链出现循环", " ".join(state.stale_reasons("1.1", 1)))

    def test_removed_node_and_nested_versions(self):
        self.version("1.1")
        parent = node_dir(self.task, self.flow, "1.1") / "第1版"
        nested = parent / "内部调用" / "取数" / "第1版"
        nested.mkdir(parents=True)
        (nested / LEDGER_NAME).write_text("{}", encoding="utf-8")
        self.flow["顺序"].remove("1.1")
        self.flow["已移出"].append("1.1")
        (self.task / "流程定义.json").write_text(json.dumps(self.flow, ensure_ascii=False), encoding="utf-8")
        state = self.state()
        self.assertEqual(list(state.ledgers["1.1"]), [1])
        self.assertEqual(state.validity("1.1", 1), "当前采用")


if __name__ == "__main__":
    unittest.main()
