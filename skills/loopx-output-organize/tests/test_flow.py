"""流程定义契约测试。"""
import copy
import json
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "scripts"))
from flow import (FlowError, find_template, implicit_flow, is_cross_stage,
                  load_flow_source, normalize_flow, resolve_verdict,
                  update_flow, with_node)


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.raw = load_flow_source(find_template("B卡策略迭代"))

    def minimal(self):
        with (BASE / "tests/fixtures/最小流程.json").open("r", encoding="utf-8") as stream:
            return json.load(stream)

    def assert_invalid(self, raw, expected):
        with self.assertRaises(FlowError) as caught:
            normalize_flow(raw)
        self.assertTrue(any(expected in item for item in caught.exception.problems),
                        caught.exception.problems)

    def test_bcard_template(self):
        flow = normalize_flow(self.raw)
        with (BASE / "tests/fixtures/B卡策略迭代.json").open("r", encoding="utf-8") as stream:
            self.assertEqual(flow, json.load(stream))
        self.assertEqual(len(flow["顺序"]), 33)
        self.assertEqual(flow["交接点"], {"复盘结论": "1.5", "主B卡": "2.9",
                                         "策略分": "3.6", "最终交付": "4.报告整合"})
        self.assertEqual(flow["节点"]["2.9"], {
            "id": "2.9", "名称": "验收与交接", "执行方": "人工", "阶段": "2",
            "目录": ["2_主B卡开发", "2.9_验收与交接"],
            "依赖": ["2.报告整合", "验收目标"], "门禁": True,
            "结论": {"通过，进入策略分建模": "通过", "需整改后复验": "整改后复验",
                   "证据不足，补齐后判断": "补证后再判"},
            "门禁结论": ["通过", "带问题通过", "整改后复验", "补证后再判"],
            "可打回至": ["2.1", "2.2"],
            "可补证至": ["2.3", "2.4", "2.5", "2.6", "2.7", "2.8"],
            "可跳过": False, "可外部交付": False, "基线": "上一版", "循环": None,
            "交接": "主B卡", "不达标处理": None, "跨阶段打回": "需人工确认",
            "待核对": False,
        })
        self.assertEqual(flow["节点"]["2.3"]["目录"],
                         ["2_主B卡开发", "2.3-2.8_新旧模型验收评估", "2.3_整体性能"])
        self.assertEqual(flow["节点"]["2.3"]["阶段"], "2")
        self.assertEqual(flow["节点"]["4.2"]["不达标处理"], "带问题通过")
        self.assertEqual(flow["节点"]["3.4"]["基线"], "固定首版")
        self.assertIsNone(flow["节点"]["3.5"]["不达标处理"])

    def test_minimal_fixture(self):
        flow = normalize_flow(self.minimal())
        self.assertEqual(len(flow["顺序"]), 6)
        self.assertEqual(flow["交接点"], {"甲": "1.3"})
        self.assertEqual(flow["节点"]["2.2"]["循环"]["最大轮次"], 3)
        self.assertTrue(flow["节点"]["2.3"]["可跳过"])

    def test_invalid_ids_and_duplicates(self):
        raw = self.minimal()
        raw["分组"][0]["节点"][0]["id"] = "bad/id"
        self.assert_invalid(raw, "无效")
        raw = self.minimal()
        raw["分组"][0]["节点"][0]["id"] = "2"
        self.assert_invalid(raw, "重复")

    def test_invalid_executor(self):
        raw = self.minimal()
        raw["分组"][0]["节点"][0]["执行方"] = "机器人"
        self.assert_invalid(raw, "执行方")

    def test_invalid_dependency(self):
        raw = self.minimal()
        raw["分组"][1]["节点"][0]["依赖"] = ["交接:乙", "missing"]
        with self.assertRaises(FlowError) as caught:
            normalize_flow(raw)
        self.assertEqual(sum("依赖不存在" in p for p in caught.exception.problems), 2)

    def test_invalid_targets(self):
        for field in ("可打回至", "可补证至"):
            with self.subTest(field=field):
                raw = self.minimal()
                raw["分组"][0]["节点"][2][field] = ["missing"]
                self.assert_invalid(raw, field)
        raw = self.minimal()
        raw["分组"][1]["节点"][1]["循环"]["与"] = "missing"
        self.assert_invalid(raw, "循环.与")

    def test_duplicate_handoff(self):
        raw = self.minimal()
        raw["分组"][1]["节点"][1]["交接"] = "甲"
        self.assert_invalid(raw, "交接名重复")

    def test_invalid_verdict_mapping(self):
        raw = self.minimal()
        raw["分组"][0]["节点"][2]["结论"] = {"同意": "不通过"}
        self.assert_invalid(raw, "结论值")

    def test_invalid_baseline(self):
        raw = self.minimal()
        raw["分组"][1]["节点"][0]["基线"] = "最新"
        self.assert_invalid(raw, "基线")

    def test_dependency_cycle(self):
        raw = self.minimal()
        raw["分组"][0]["节点"][0]["依赖"] = ["2.3"]
        self.assert_invalid(raw, "成环")

    def test_config_gate(self):
        raw = self.minimal()
        raw["分组"][0]["节点"][0]["门禁"] = True
        self.assert_invalid(raw, "配置节点")

    def test_with_node_does_not_mutate(self):
        original = implicit_flow()
        before = copy.deepcopy(original)
        result = with_node(original, "口径与标签", "配置")
        self.assertEqual(original, before)
        self.assertEqual(result["顺序"], ["口径与标签"])
        self.assertEqual(result["节点"]["口径与标签"]["目录"], ["口径与标签"])

    def test_update_flow(self):
        old_raw = self.minimal()
        old = normalize_flow(old_raw)
        before = copy.deepcopy(old)
        newer = copy.deepcopy(old_raw)
        newer["分组"][0]["名称"] = "改名的分组"
        newer["分组"][0]["节点"][1]["名称"] = "新执行名"
        newer["分组"][1]["节点"].pop()
        newer["分组"][1]["节点"].append({"id": "2.4", "执行方": "skill"})
        result, summary = update_flow(old, newer)
        self.assertEqual(summary, {"新增": ["2.4"], "移出": ["2.3"],
                                   "改名": [{"id": "1.2", "旧名": "执行", "新名": "新执行名"}]})
        self.assertEqual(result["节点"]["1.2"]["目录"], old["节点"]["1.2"]["目录"])
        self.assertIn("2.3", result["节点"])
        self.assertEqual(result["已移出"], ["2.3"])
        self.assertEqual(old, before)

    def test_verdict_and_stage(self):
        flow = normalize_flow(self.raw)
        self.assertEqual(resolve_verdict(flow, "2.9", "通过，进入策略分建模"), "通过")
        self.assertEqual(resolve_verdict(flow, "2.9", "带问题通过"), "带问题通过")
        with self.assertRaises(FlowError):
            resolve_verdict(flow, "2.9", "未知")
        self.assertTrue(is_cross_stage(flow, "1.5", "2.9"))
        self.assertFalse(is_cross_stage(flow, "2.2", "2.9"))

    def test_find_template(self):
        path = find_template("B卡策略迭代")
        self.assertEqual(path.name, "B卡策略迭代.yaml")
        self.assertTrue(path.is_file())
        with self.assertRaises(FileNotFoundError):
            find_template("不存在")


if __name__ == "__main__":
    unittest.main()
