"""视图生成测试。"""

import copy
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "scripts"))

from events import append_event
from flow import normalize_flow
from layout import LEDGER_NAME, node_dir, version_dir_name
from ledger import finalize_version_ledger, new_version_ledger, write_ledger
from state import load_task_state
from views import render_issues, render_overview, write_root_index, write_views


class ViewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=BASE / "tests")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / ".git").mkdir()
        self.task = self.root / "智能体" / "【课题】测试"
        self.task.mkdir(parents=True)
        with (BASE / "tests/fixtures/最小流程.json").open("r", encoding="utf-8") as source:
            self.flow = normalize_flow(json.load(source))
        (self.task / "流程定义.json").write_text(json.dumps(self.flow, ensure_ascii=False), encoding="utf-8")
        self.meta = {"schema_version": "2.0", "课题ID": "test", "名称": "测试", "智能体": "智能体",
                     "临时": False, "创建时间": "2026-09-28T10:00:00+00:00", "继承": None,
                     "目标": "测试", "验收标准": []}
        (self.task / "课题.json").write_text(json.dumps(self.meta, ensure_ascii=False), encoding="utf-8")

    def event(self, type_, **fields):
        return append_event(self.task, type_, fields, session="test",
                            now=datetime.fromisoformat("2026-09-28T10:23:45.123456+08:00"))

    def version(self, node, *, status="成功", submit=True, inputs=(), skill=None, verdict=None):
        directory = node_dir(self.task, self.flow, node)
        number = len(list(directory.glob("第*版"))) + 1 if directory.exists() else 1
        target = directory / version_dir_name(number)
        target.mkdir(parents=True)
        ledger = new_version_ledger(引用=f"{node}@v{number}", 节点=node, 版本=number,
                                    课题="test", 中文目录名=str(target.relative_to(self.root)),
                                    执行方=self.flow["节点"][node]["执行方"],
                                    创建时间="2026-09-28T10:00:00+00:00", 会话="test",
                                    输入=[{"引用": ref, "角色": "依赖"} for ref in inputs], skill=skill)
        if status != "进行中":
            fields = {"执行状态": status, "完成时间": "2026-09-28T11:00:00+00:00"}
            if status in ("成功", "部分完成"):
                fields["artifacts"] = [{"相对路径": "报告/结果.md", "类型": "报告", "角色": "主交付物",
                                         "sha256": "a" * 64, "字节数": 1}]
                if ledger["执行方"] in ("skill", "代码", "智能体"):
                    fields["执行记录"] = {"路径": "执行记录/trace.jsonl", "步骤数": 1, "失败数": 0}
            if verdict:
                fields["评审结论"] = {"结论": verdict, "原文": None, "理由": "", "目标": []}
            ledger = finalize_version_ledger(ledger, **fields)
        write_ledger(target / LEDGER_NAME, ledger)
        if submit and status in ("成功", "部分完成"):
            self.event("提交", 节点=node, 版本=number, 执行状态=status, 评审结论=ledger["评审结论"])
        return number

    def state(self):
        return load_task_state(self.task)

    def test_version_line_and_index_history(self):
        self.version("1.1")
        self.version("1.1", status="失败")
        self.version("1.1")
        self.version("1.3", verdict="整改后复验")
        self.version("1.3", verdict="通过")
        current = self.state()
        overview = render_overview(current)
        self.assertLess(overview.index("## 按流程"), overview.index("## 版本线"))
        self.assertLess(overview.index("## 版本线"), overview.index("## 按分工"))
        self.assertIn("第1版 首次·已替代 → 第2版 首次·失败 → 第3版 首次·有效", overview)
        self.assertIn("第1版 首次·整改后复验·已替代 → 第2版 首次·通过·有效", overview)
        write_views(current)
        text = (node_dir(self.task, self.flow, "1.1") / "当前采用_第3版.md").read_text(encoding="utf-8")
        self.assertIn("## 版本历史", text)
        self.assertIn("| 版本 | 执行状态 | 有效性 | 触发 | 评审结论 | 创建时间 |", text)
        self.assertIn("| 第2版 | 失败 | 失败 | 首次 |", text)
        self.assertEqual(text.splitlines()[0], "# 1.1 配置")
        local_time = datetime.fromisoformat("2026-09-28T10:00:00+00:00").astimezone().strftime("%m-%d %H:%M")
        self.assertIn(f"| 第1版 | 成功 | 已替代 | 首次 | — | {local_time} |", text)
        self.assertIn(f"| 第3版 | 成功 | 有效 | 首次 | — | {local_time} |", text)
        self.assertNotIn("2026-09-28T10:00:00+00:00", text)
        self.assertNotIn("| 当前采用 |", text)
        # 缺省名称的节点标题不能留下空格或重复 ID。
        unnamed = copy.deepcopy(current)
        unnamed.flow["节点"]["1.1"].pop("名称", None)
        write_views(unnamed)
        text = (node_dir(self.task, self.flow, "1.1") / "当前采用_第3版.md").read_text(encoding="utf-8")
        self.assertEqual(text.splitlines()[0], "# 1.1")
        self.assertEqual(current.flow["节点"]["1.1"]["名称"], "配置")

    def test_index_six_names_and_safe_refresh(self):
        directory = node_dir(self.task, self.flow, "1.1")
        directory.mkdir(parents=True)
        self.assertIsNone(__import__("views")._index_name(self.state(), "1.1"))
        self.version("1.1", status="进行中")
        write_views(self.state())
        self.assertTrue((directory / "当前采用_无.md").exists())
        (directory / "当前采用_旧.md").write_text("旧", encoding="utf-8")
        (directory / "私人笔记.md").write_text("保留", encoding="utf-8")
        self.version("1.1")
        write_views(self.state())
        self.assertTrue((directory / "当前采用_第2版.md").exists())
        self.assertFalse((directory / "当前采用_旧.md").exists())
        self.assertTrue((directory / "私人笔记.md").exists())
        self.event("打回", 编号=1, 来源="1.3@v1", 目标=["1.1"], 原因="重做", 跨阶段=False, 人工确认=None)
        write_views(self.state())
        self.assertTrue((directory / "当前采用_第2版_待重做.md").exists())
        self.version("1.2", inputs=["1.1@v2"])
        self.version("1.1")
        dependent = node_dir(self.task, self.flow, "1.2")
        write_views(self.state())
        self.assertTrue((dependent / "当前采用_第1版_已过期.md").exists())
        self.event("补证", 编号=1, 来源="1.3@v1", 目标=["1.2"], 原因="补齐", 人工确认=None)
        write_views(self.state())
        self.assertTrue((dependent / "当前采用_第1版_已过期_待重做.md").exists())
        self.event("跳过", 节点="2.3", 原因="不需要", 人工确认=None)
        node = node_dir(self.task, self.flow, "2.3")
        node.mkdir(parents=True)
        write_views(self.state())
        self.assertTrue((node / "已跳过.md").exists())

    def test_overview_assignment_and_handoff_update(self):
        skill = {"名称": "sample", "中文名": "示例", "skill版本": "1.0", "来源sha256": "a" * 64}
        self.version("1.1")
        self.version("1.2", skill=skill)
        self.event("交接", 编号=1, 名称="甲", 节点="1.3", 清单={"1.1": "1.1@v1"},
                   未解决项=[], 人工确认=None)
        self.version("1.1")
        overview = render_overview(self.state())
        for section in ("## 按流程", "## 按分工", "## 交接", "## 待办"):
            self.assertIn(section, overview)
        self.assertIn("sample", overview)
        self.assertIn("1.2", overview)
        self.assertIn("交接#1 之后以下节点有更新：1.1", overview)

    def chain_flow(self):
        children = [{"id": f"2.{number}", "名称": f"分析{number}", "执行方": "skill",
                     "依赖": [f"2.{number - 1}"]} for number in range(3, 9)]
        self.flow = normalize_flow({
            "流程": "链式流程", "流程版本": "0.1.0", "分组": [
                {"id": "1", "名称": "准备", "节点": [
                    {"id": "1.1", "名称": "配置", "执行方": "配置"},
                    {"id": "1.3", "执行方": "人工", "交接": "甲", "可跳过": True},
                    {"id": "1.报告整合", "执行方": "报告整合"}]},
                {"id": "2", "名称": "主B卡开发", "节点": [
                    {"id": "2.1", "名称": "准备", "执行方": "智能体"},
                    {"id": "2.2", "名称": "主模型开发", "执行方": "代码"},
                    {"id": "分析", "名称": "合并项", "节点": children},
                    {"id": "2.报告整合", "执行方": "报告整合",
                     "依赖": [f"2.{number}" for number in range(3, 9)]},
                    {"id": "2.9", "名称": "验收与交接", "执行方": "人工",
                     "依赖": ["2.报告整合"]}]}]})
        (self.task / "流程定义.json").write_text(
            json.dumps(self.flow, ensure_ascii=False), encoding="utf-8")

    def test_readable_overview_format(self):
        self.chain_flow()
        self.version("2.2")
        for number, type_ in ((1, "打回"), (2, "打回"), (1, "补证")):
            self.event(type_, 编号=number, 来源="2.9@v1", 目标=["2.2"], 原因="重做",
                       人工确认=None, **({"跨阶段": False} if type_ == "打回" else {}))
        state = self.state()
        overview = render_overview(state)
        self.assertTrue(overview.startswith("# 总览 · 测试\n\n| 项目 | 内容 |\n"))
        self.assertNotIn("## 头部", overview)
        for row in ("课题 | 测试", "智能体 | 智能体", "流程版本 | 0.1.0",
                    f"待办数 | {len(state.todo())}", "未关闭未解决项数 | 0"):
            self.assertIn(f"| {row} |", overview)
        self.assertIn("### 2 主B卡开发\n", overview)
        self.assertIn("| 2.2 主模型开发 | 代码 | 第1版 | 有效 | 1 | 2/1 |", overview)
        self.assertIn("| 　　2.3 分析3 | skill | — |", overview)
        self.assertIn("| 1.报告整合 | 报告整合 | — |", overview)
        self.assertNotIn("1.报告整合 1.报告整合", overview)
        self.assertIn("| 打回/补证 |", overview)
        self.assertNotIn("打回次数", overview)
        assignments = overview.split("## 按分工", 1)[1].split("## 交接", 1)[0]
        for title in ("Skill 分析", "固定代码", "人工确认", "共用配置", "智能体", "报告整合"):
            self.assertIn(f"### {title}\n", assignments)

    def test_local_short_times(self):
        self.event("交接", 编号=1, 名称="甲", 节点="1.3", 清单={},
                   未解决项=[], 人工确认=None)
        state = self.state()
        timestamp = state.events[-1]["时间"]
        expected = datetime.fromisoformat(timestamp).astimezone().strftime("%m-%d %H:%M")
        overview = render_overview(state)
        self.assertIn(f"| 最后更新 | {expected} |", overview)
        self.assertIn(f"| 交接#1 | 甲 | 1.3 | {expected} |", overview)
        self.assertNotIn(timestamp, overview)
        write_root_index(self.root)
        index = (self.root / "总索引.md").read_text(encoding="utf-8")
        self.assertIn(f"| {expected} |", index)
        self.assertNotIn(timestamp, index)

    def test_chain_shows_only_deduplicated_source_in_all_views(self):
        self.chain_flow()
        self.version("2.2")
        for number in range(3, 9):
            self.version(f"2.{number}", inputs=[f"2.{number - 1}@v1"])
        self.version("2.报告整合", inputs=[f"2.{number}@v1" for number in range(3, 9)])
        self.version("2.9", inputs=["2.报告整合@v1"])
        self.version("2.2")
        state = self.state()
        before = copy.deepcopy((state.flow, state.meta, state.events, state.ledgers))
        overview = render_overview(state)
        reason = "上游 2.2 已更新（第1版 → 第2版）"
        flow_section = overview.split("## 按分工", 1)[0]
        todo = overview.split("## 待办", 1)[1]
        write_views(state)
        for node in [f"2.{number}" for number in range(3, 9)] + ["2.报告整合", "2.9"]:
            row = next(line for line in flow_section.splitlines()
                       if line.startswith(f"| {node} ") or line.startswith(f"| 　　{node} "))
            self.assertEqual(row.split(" | ")[-1], reason + " |")
            self.assertIn("| 第1版 | 过期 |", row)
            self.assertIn(f"| {node} | {reason} |", todo)
            content = (node_dir(self.task, self.flow, node) /
                       "当前采用_第1版_已过期.md").read_text(encoding="utf-8")
            self.assertIn(f"过期原因及待重做来源：{reason}\n", content)
            self.assertEqual(content.count(reason), 1)
        self.assertNotIn("已过期", todo)
        self.assertEqual(before, (state.flow, state.meta, state.events, state.ledgers))

    def test_handoff_and_skip_sources_preserve_pending_triggers(self):
        self.event("跳过", 节点="1.3", 原因="不需要", 人工确认=None)
        self.event("交接", 编号=1, 名称="甲", 节点="1.3", 清单={},
                   未解决项=[], 人工确认=None)
        self.version("2.1", inputs=["交接#1", "1.3@跳过"])
        self.version("2.2", inputs=["2.1@v1", "交接#1"])
        self.version("1.3")
        self.event("交接", 编号=2, 名称="甲", 节点="1.3", 清单={},
                   未解决项=[], 人工确认=None)
        self.event("补证", 编号=1, 来源="1.3@v1", 目标=["2.2"], 原因="补齐", 人工确认=None)
        overview = render_overview(self.state())
        reason = "交接#1 已被交接#2 取代；1.3 已不再跳过"
        self.assertIn(reason + "；待重做（补证#1） |", overview)
        self.assertIn(f"| 2.2 | {reason}；待重做：补证#1 未消费 |", overview)
        write_views(self.state())
        content = (node_dir(self.task, self.flow, "2.2") /
                   "当前采用_第1版_已过期_待重做.md").read_text(encoding="utf-8")
        self.assertIn(reason + "；待重做（补证#1）", content)
        self.assertEqual(content.count("交接#1 已被交接#2 取代"), 1)

    def test_issues_sort_and_root_index_bad_task(self):
        self.event("未解决项", 编号=1, 动作="新增", 来源="1.1@v1", 描述="已解决", 指标="", 标准="", 差值="")
        self.event("未解决项", 编号=2, 动作="新增", 来源="1.2@v1", 描述="未关闭", 指标="", 标准="", 差值="")
        self.event("未解决项", 编号=1, 动作="关闭", 处理="已解决", 原因="完成")
        issues = render_issues(self.state())
        self.assertLess(issues.index("未关闭 |"), issues.index("已解决 |"))
        bad = self.root / "智能体" / "【课题】损坏"
        bad.mkdir()
        (bad / "流程定义.json").write_text("{bad", encoding="utf-8")
        write_root_index(self.root)
        index = (self.root / "总索引.md").read_text(encoding="utf-8")
        self.assertIn("【课题】测试", index)
        self.assertIn("【课题】损坏", index)
        self.assertIn("读取失败", index)


if __name__ == "__main__":
    unittest.main()
