"""设计文档第五节 A–G 的真实 CLI 场景；契约优先于设计中的旧称谓。"""

from functools import wraps
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
EVALUATIONS = tuple(f"2.{n}" for n in range(3, 9))
ISSUE = {"描述": "区分度不足，后续处理", "指标": "0.35", "标准": "0.40", "差值": "-0.05"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def verified(method):
    @wraps(method)
    def run(self):
        try:
            return method(self)
        finally:
            self.verify()
    return run


class ScenarioTests(unittest.TestCase):
    def setUp(self):
        # 临时项目也限制在工作目录内；子进程不生成 scripts 下的字节码。
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name)
        (self.project / ".git").mkdir()
        self.root = self.project / "产出"
        self.env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", SKILLFUSE_SESSION="scenario")
        self.env.pop("SKILLFUSE_OUTPUT_ROOT", None)
        self.corrupted = None
        self.begin("2026Q3迭代", "q3-bcard")

    def command(self, script, *args, code=0, env=None):
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / script), *map(str, args)],
            cwd=self.project, env=self.env if env is None else env,
            capture_output=True, encoding="utf-8", timeout=60)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1, result.stdout)
        return json.loads(result.stdout)

    def cli(self, *args, **kwargs):
        return self.command("steward.py", *args, **kwargs)

    def begin(self, name, slug, *args):
        result = self.cli("task-begin", "--name", name, "--slug", slug,
                          "--flow-template", "B卡策略迭代", *args)
        self.task = Path(result["课题目录"])
        self.flow = read_json(self.task / "流程定义.json")
        self.done = {}
        self.handoffs = {}
        return result

    def verify(self):
        # finally 保证每个场景都实际体检。
        result = self.command("verify.py", code=1 if self.corrupted else 0)
        errors = [item for item in result["问题"] if item["级别"] == "error"]
        self.assertEqual(result["汇总"]["error"], len(errors))
        if self.corrupted:
            self.assertTrue(any(self.corrupted in json.dumps(item, ensure_ascii=False)
                                for item in errors), result)
        else:
            self.assertEqual(errors, [], result)

    def node_dir(self, node):
        return self.task.joinpath(*self.flow["节点"][node]["目录"])

    def ledger(self, allocation):
        return read_json(Path(allocation["目录"]) / "产出台账.json")

    def events(self, kind=None):
        events = [json.loads(line) for line in
                  (self.task / "流转记录.jsonl").read_text(encoding="utf-8").splitlines()]
        return [event for event in events if kind is None or event["类型"] == kind]

    def prepare(self, allocation, text="主交付物", trace=None):
        directory = Path(allocation["目录"])
        primary = "报告/确认记录.md" if self.ledger(allocation)["执行方"] == "人工" else "报告/结果.md"
        (directory / primary).write_text(text, encoding="utf-8")
        (directory / "执行记录" / "trace.jsonl").write_text(
            json.dumps(trace or {"status": "ok"}, ensure_ascii=False) + "\n", encoding="utf-8")
        return primary

    def finish(self, allocation, *args, text="主交付物", code=0, auto_verdict=True):
        primary = self.prepare(allocation, text)
        node = self.flow["节点"].get(allocation["节点"], {})
        verdict = ("--verdict", "通过") if auto_verdict and node.get("门禁") and "--verdict" not in args else ()
        required = (node.get("循环") or {}).get("每轮必记", [])
        round_args = ("--round", json.dumps({key: "本轮已记录" for key in required}, ensure_ascii=False)) if required and "--round" not in args else ()
        return self.cli("commit", "--dir", allocation["目录"], "--status", "成功",
                        "--primary", primary, *verdict, *round_args, *args, code=code)

    def run_node(self, node, *, alloc_args=(), commit_args=(), text="主交付物"):
        allocation = self.cli("alloc", "--node", node, *alloc_args)
        self.finish(allocation, *commit_args, text=text)
        self.done[node] = allocation
        return allocation

    def ready(self, node):
        """沿冻结流程递归完成真实前置节点和交接，不强行跳过依赖。"""
        for dependency in self.flow["节点"][node]["依赖"]:
            if dependency.startswith("交接:"):
                name = dependency[3:]
                if name not in self.handoffs:
                    gate = self.flow["交接点"][name]
                    self.ensure(gate)
                    self.handoffs[name] = self.cli("handoff", "--node", gate)
            else:
                self.ensure(dependency)

    def ensure(self, node):
        if node not in self.done:
            self.ready(node)
            self.run_node(node)
        return self.done[node]

    def status(self):
        return self.cli("status")

    def assert_validity(self, expected):
        status = self.status()
        for node, validity in expected.items():
            self.assertEqual(status["节点"][node]["有效性"], validity, node)
            if validity == "过期":
                self.assertIn(node, [item["节点"] for item in status["待办"]])
                self.assertTrue(list(self.node_dir(node).glob("当前采用_*_已过期*.md")))

    def reject(self, target="2.2", reason="模型需要整改"):
        self.ready("2.9")
        return self.run_node("2.9", commit_args=("--verdict", "需整改后复验", "--to", target, "--reason", reason))

    def manifest_path(self, number):
        paths = list((self.task / "交接与交付").glob(f"交接{number}_*/清单.json"))
        self.assertEqual(len(paths), 1)
        return paths[0]

    @verified
    def test_A1_sequential_dependencies(self):
        # A1：分配版本时，自动把依赖节点的当前采用写进这一版的「输入」。
        allocation = self.ensure("1.2")
        self.assertEqual(allocation["输入"], [{"引用": "1.1@v1", "角色": "依赖"}])
        for node, item in self.done.items():
            self.assertEqual(item["版本"], 1)
            self.assertEqual(item["触发"], {"类型": "首次", "编号": None})
            self.assertTrue((self.node_dir(node) / "当前采用_第1版.md").is_file())
            for name in ("报告", "数据", "执行记录", "日志"):
                self.assertTrue((Path(item["目录"]) / name).is_dir())
        self.assertTrue((self.root / "总索引.md").is_file())

    def concurrent_alloc(self, nodes):
        processes = []
        try:
            for index, node in enumerate(nodes):
                processes.append(subprocess.Popen(
                    [sys.executable, str(SCRIPTS / "steward.py"), "alloc", "--node", node],
                    cwd=self.project, env=dict(self.env, SKILLFUSE_SESSION=f"parallel-{index}"),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8"))
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=60)
                self.assertEqual(process.returncode, 0, stdout + stderr)
                results.append(json.loads(stdout))
            return results
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    @verified
    def test_A2_parallel_nodes(self):
        # A2：6 个子节点目录同时出现，版本各自计数；并行分配互不阻塞。
        for node in EVALUATIONS:
            self.ready(node)
        allocations = self.concurrent_alloc(EVALUATIONS)
        self.assertEqual(len({item["目录"] for item in allocations}), 6)
        for item in allocations:
            self.assertEqual(item["版本"], 1)
            self.finish(item)
        self.assertEqual(self.run_node("2.6")["版本"], 2)
        for node in set(EVALUATIONS) - {"2.6"}:
            self.assertFalse((self.node_dir(node) / "第2版").exists())

    @verified
    def test_A3_report_invalidation(self):
        # A3：输入列着 6 个子节点的版本；任何一个输入过期，整合版随之过期。
        report = self.ensure("2.报告整合")
        self.assertEqual(report["输入"], [{"引用": f"{node}@v1", "角色": "依赖"} for node in EVALUATIONS])
        self.run_node("2.6")
        self.assert_validity({"2.报告整合": "过期", "2.5": "当前采用"})

    @verified
    def test_A4_human_gate(self):
        # A4：主交付物是「报告/确认记录.md」，门禁节点必须填评审结论（执行方按契约为「人工」）。
        for node in ("1.1", "1.5", "2.9"):
            self.ready(node)
            allocation = self.cli("alloc", "--node", node)
            if self.flow["节点"][node]["门禁"]:
                self.assertIn("verdict", self.finish(allocation, code=1, auto_verdict=False)["error"])
                self.assertEqual(self.ledger(allocation)["执行状态"], "进行中")
            self.finish(allocation)
            self.done[node] = allocation
            data = self.ledger(allocation)
            self.assertEqual(data["执行方"], "人工")
            self.assertEqual([a["相对路径"] for a in data["artifacts"] if a["角色"] == "主交付物"], ["报告/确认记录.md"])
            self.assertEqual(list((Path(allocation["目录"]) / "数据").iterdir()), [])

    @verified
    def test_A5_stage_handoff(self):
        # A5：冻结本阶段所有节点的当前采用，写清单和校验值；有过期或未完成节点时拒绝交接。
        self.cli("handoff", "--node", "2.9", code=1)
        self.ensure("2.9")
        manifest = self.cli("handoff", "--node", "2.9")
        self.assertEqual(manifest["编号"], 2)
        path = self.manifest_path(2)
        self.assertEqual(read_json(path), manifest)
        expected = {node for node, data in self.flow["节点"].items() if data["阶段"] == "2"}
        self.assertEqual(set(manifest["版本"]), expected)
        for node, item in manifest["版本"].items():
            self.assertEqual(item["引用"], f"{node}@v1")
            content = (path.parent / item["主交付物"]).read_text(encoding="utf-8")
            self.assertEqual(hashlib.sha256(content.encode("utf-8")).hexdigest(), item["sha256"])
        self.run_node("2.2")
        self.assertIn("过期", self.cli("handoff", "--node", "2.9", code=1)["error"])
        self.assertEqual(read_json(path), manifest)

    @verified
    def test_B1_same_stage_reject(self):
        # B1：台账写「由打回#1触发」，基线自动设为第1版。
        review = self.reject()
        event = self.events("打回")[-1]
        self.assertEqual((event["来源"], event["目标"], event["原因"], event["跨阶段"]), (review["引用"], ["2.2"], "模型需要整改", False))
        self.assertTrue((self.node_dir("2.2") / "当前采用_第1版_待重做.md").exists())
        allocation = self.run_node("2.2")
        self.assertEqual(allocation["触发"], {"类型": "打回", "编号": 1})
        self.assertEqual(self.ledger(allocation)["基线"], {"引用": "2.2@v1", "策略": "上一版"})
        self.assertIn({"引用": "2.2@v1", "角色": "基线"}, allocation["输入"])
        self.assertFalse(list(self.node_dir("2.2").glob("*_待重做.md")))

    @verified
    def test_B2_chain_stale(self):
        # B2：所有吃过2.2第1版的节点连锁过期；不依赖它的不受影响。
        self.ensure("2.9")
        self.run_node("2.2")
        expected = {node: "过期" for node in (*EVALUATIONS, "2.报告整合", "2.9")}
        expected.update({node: "当前采用" for node in ("2.1", "1.2", "口径与标签")})
        self.assert_validity(expected)

    @verified
    def test_B3_earlier_reject(self):
        # B3：2.9可以打回到2.1；2.1出新版，2.2起全部过期。
        self.reject("2.1")
        allocation = self.run_node("2.1")
        self.assertEqual(allocation["触发"], {"类型": "打回", "编号": 1})
        self.assert_validity({node: "过期" for node in ("2.2", *EVALUATIONS, "2.报告整合", "2.9")})

    @verified
    def test_B4_cross_stage_reject(self):
        # B4：跨阶段打回要求人工确认；重新交接后下游过期（契约禁止非门禁4.2评审，使用4.1.2）。
        self.ensure("4.报告整合")
        non_gate = self.cli("alloc", "--node", "4.2")
        error = self.finish(non_gate, "--verdict", "整改后复验", "--to", "2.2",
                            "--confirm", "批准跨阶段打回", code=1)
        self.assertIn("非门禁", error["error"])
        self.finish(non_gate)
        allocation = self.cli("alloc", "--node", "4.1.2")
        args = ("--verdict", "整改后复验", "--to", "2.2", "--reason", "跨阶段修正")
        self.assertIn("confirm", self.finish(allocation, *args, code=1)["error"])
        self.finish(allocation, *args, "--confirm", "同意跨阶段影响")
        self.assertTrue(self.events("打回")[-1]["跨阶段"])
        self.assertEqual(self.events("打回")[-1]["人工确认"], "同意跨阶段影响")
        self.run_node("2.2")
        self.assert_validity({"3.1": "当前采用", "4.1.1": "当前采用"})
        for node in (*EVALUATIONS, "2.报告整合", "2.9"):
            self.run_node(node)
        self.cli("handoff", "--node", "2.9")
        self.assert_validity({"3.1": "过期", "3.6": "过期", "4.1.1": "过期", "4.报告整合": "过期"})

    @verified
    def test_B5_long_reject_history(self):
        # B5：总览能看到每版对应哪次打回。
        self.ensure("2.9")
        for number in range(1, 5):
            for node in (*EVALUATIONS, "2.报告整合"):
                if number > 1:
                    self.run_node(node)
            self.reject(reason=f"第{number}次整改")
            allocation = self.run_node("2.2")
            self.assertEqual(allocation["版本"], number + 1)
            self.assertEqual(self.ledger(allocation)["触发"], {"类型": "打回", "编号": number})
        overview = (self.task / "总览.md").read_text(encoding="utf-8")
        for number in range(1, 5):
            self.assertTrue(any(f"打回#{number}" in line and
                                (f"第{number + 1}版" in line or f"2.2@v{number + 1}" in line)
                                for line in overview.splitlines()), overview)

    @verified
    def test_C1_supplement_only(self):
        # C1：只有被点名的2.6出第4版，2.2不动，其余评估块保持有效。
        self.ensure("2.9")
        for _ in range(2):
            self.run_node("2.6")
        self.run_node("2.报告整合")
        model = (Path(self.done["2.2"]["目录"]) / "产出台账.json").read_text(encoding="utf-8")
        self.run_node("2.9", commit_args=("--verdict", "证据不足，补齐后判断", "--to", "2.6", "--reason", "补充SWAP证据"))
        allocation = self.run_node("2.6")
        self.assertEqual(allocation["版本"], 4)
        self.assertEqual(allocation["触发"], {"类型": "补证", "编号": 1})
        self.assertEqual(self.events("补证")[-1]["目标"], ["2.6"])
        self.assertEqual((Path(self.done["2.2"]["目录"]) / "产出台账.json").read_text(encoding="utf-8"), model)
        self.assert_validity({node: "当前采用" for node in ("2.2", "2.3", "2.4", "2.5", "2.7", "2.8")})

    @verified
    def test_C2_pass_with_issues(self):
        # C2：评审记「带问题通过」，指标、标准、差值写入未解决项，不触发返工版本。
        self.ready("4.1.2")
        allocation = self.cli("alloc", "--node", "4.1.2")
        self.finish(allocation, "--verdict", "带问题通过", code=1)
        before = set(self.task.rglob("产出台账.json"))
        self.finish(allocation, "--verdict", "带问题通过", "--issue", json.dumps(ISSUE, ensure_ascii=False))
        self.assertEqual(set(self.task.rglob("产出台账.json")), before)
        self.assertEqual(self.ledger(allocation)["未解决项"], [ISSUE])
        self.assertEqual(self.ledger(allocation)["评审结论"]["结论"], "带问题通过")
        text = (self.task / "未解决项.md").read_text(encoding="utf-8")
        for value in (allocation["引用"], *ISSUE.values()):
            self.assertIn(value, text)
        self.assertEqual(self.events("打回"), [])

    @verified
    def test_C3_issues_handoff(self):
        # C3：交接说明列出带过去的未解决项，最终交付说明接受或后续处理。
        self.ready("2.9")
        issues = [ISSUE, {**ISSUE, "描述": "等待后续复核"}, {**ISSUE, "描述": "等待修复"}]
        issue_args = tuple(value for item in issues for value in ("--issue", json.dumps(item, ensure_ascii=False)))
        self.run_node("2.9", commit_args=("--verdict", "带问题通过", *issue_args))
        handoff = self.cli("handoff", "--node", "2.9")
        self.handoffs["主B卡"] = handoff
        self.assertEqual(handoff["未解决项"], [1, 2, 3])
        self.ensure("4.报告整合")
        error = self.cli("handoff", "--node", "4.报告整合", code=1)["error"]
        for item in issues:
            self.assertIn(item["描述"], error)
        text = (self.manifest_path(handoff["编号"]).parent / "交接说明.md").read_text(encoding="utf-8")
        self.assertIn(ISSUE["描述"], text)
        self.assertEqual(len(self.status()["未关闭未解决项"]), 3)
        for number, resolution in ((1, "接受"), (2, "后续处理"), (3, "已解决")):
            self.cli("issue-close", "--id", number, "--resolution", resolution, "--reason", "逐项处置")
            self.assertEqual(self.events("未解决项")[-1]["处理"], resolution)
            if number < 3:
                self.cli("handoff", "--node", "4.报告整合", code=1)
        self.assertEqual(self.status()["未关闭未解决项"], [])
        final = self.cli("handoff", "--node", "4.报告整合")
        self.assertEqual(final["未解决项"], [])

    @verified
    def test_D1_paired_loop(self):
        # D1：3.4与3.5成对递增，每对一轮，不建「第N轮」目录。
        self.ready("3.4")
        for number in range(1, 4):
            model = self.run_node("3.4")
            review = self.run_node("3.5")
            self.assertEqual((model["版本"], review["版本"]), (number, number))
            self.assertIn({"引用": model["引用"], "角色": "依赖"}, review["输入"])
            self.assertEqual(model["触发"]["类型"], "首次" if number == 1 else "循环")
        self.assertFalse(any(re.fullmatch(r"第\s*\d+\s*轮", path.name) for path in self.task.rglob("*") if path.is_dir()))
        self.assertEqual(len([event for event in self.events("提交") if event["节点"] in ("3.4", "3.5")]), 6)

    @verified
    def test_D2_fixed_baseline(self):
        # D2：3.4后续版本基线固定首版，同时提供上一轮目录。
        first = self.ensure("3.4")
        second = self.run_node("3.4")
        third = self.run_node("3.4")
        self.assertIsNone(first["基线目录"])
        for allocation in (second, third):
            self.assertEqual(allocation["基线目录"], first["目录"])
            self.assertEqual(self.ledger(allocation)["基线"], {"引用": "3.4@v1", "策略": "固定首版"})
        self.assertEqual(third["上一版目录"], second["目录"])
        self.assertEqual(third["env"]["SKILLFUSE_BASELINE_DIR"], first["目录"])

    @verified
    def test_D3_best_not_latest(self):
        # D3：第5、6版显示已替代并保留。
        self.ready("3.4")
        allocations = [self.run_node("3.4") for _ in range(6)]
        self.cli("adopt", "--node", "3.4", "--version", "4", "--reason", "第4版最好可行")
        self.assertEqual(self.status()["节点"]["3.4"]["当前采用"], 4)
        self.assertTrue((self.node_dir("3.4") / "当前采用_第4版.md").exists())
        for item in allocations:
            self.assertTrue(Path(item["目录"]).is_dir())
        self.assertEqual(self.events("采用")[-1]["原因"], "第4版最好可行")
        self.assertEqual(len(list(self.node_dir("3.4").glob("第*版"))), 6)
        overview = (self.task / "总览.md").read_text(encoding="utf-8")
        for number in (5, 6):
            self.assertTrue(any("3.4" in line and f"第{number}版" in line
                                and "已替代" in line for line in overview.splitlines()), overview)

    @verified
    def test_D4_iteration_trace(self):
        # D4：每版台账记本轮调整、复评结果、接受或拒绝原因。
        self.ready("3.4")
        for number in range(1, 3):
            metrics = {"本轮调整": f"delta={number}", "复评结果": 0.4 + number / 10, "接受或拒绝原因": "性能改善，接受"}
            record = {key: str(metrics[key]) for key in self.flow["节点"]["3.5"]["循环"]["每轮必记"]}
            allocation = self.run_node("3.4", commit_args=(
                "--round", json.dumps(record, ensure_ascii=False),
                "--metrics", json.dumps(metrics, ensure_ascii=False)))
            self.assertEqual(self.ledger(allocation)["轮次记录"], record)
            self.assertEqual(self.ledger(allocation)["metrics"], metrics)
            self.assertEqual(self.ledger(allocation)["执行记录"]["步骤数"], 1)
            # 每轮必记定义在评估节点，伙伴节点不继承提交要求。
            review = self.cli("alloc", "--node", "3.5")
            primary = self.prepare(review)
            before = self.ledger(review)
            for supplied in ((), ("--round", "{}")):
                error = self.cli("commit", "--dir", review["目录"], "--status", "成功",
                                 "--primary", primary, "--verdict", "通过", *supplied, code=1)["error"]
                self.assertIn("轮次记录", error)
                self.assertEqual(self.ledger(review), before)
            self.finish(review, "--round", json.dumps(record, ensure_ascii=False),
                        "--reason", metrics["接受或拒绝原因"])
            self.assertEqual(self.ledger(review)["轮次记录"], record)
            self.assertEqual(self.ledger(review)["评审结论"]["理由"], metrics["接受或拒绝原因"])

    @verified
    def test_D5_loop_limit(self):
        # D5：到上限不再分配；人工确认后继续，并记录理由。
        self.ready("3.4")
        for _ in range(8):
            self.run_node("3.4")
            self.run_node("3.5")
        for node in ("3.4", "3.5"):
            self.assertIn("上限", self.cli("alloc", "--node", node, code=1)["error"])
            self.assertFalse((self.node_dir(node) / "第9版").exists())
        ninth = self.run_node("3.4", alloc_args=("--override", "批准额外验证一轮"))
        self.assertEqual(ninth["版本"], 9)
        self.assertEqual(self.events("分配")[-1]["人工确认"], "批准额外验证一轮")

    @verified
    def test_D6_human_requirements_input(self):
        # D6：增加要求打回4.1.1，新要求进入下一版输入。
        self.ready("4.1.2")
        review = self.run_node("4.1.2", commit_args=("--verdict", "还要增加要求", "--to", "4.1.1", "--reason", "增加区域上限", "--confirm", "批准方案调整"))
        allocation = self.run_node("4.1.1")
        self.assertEqual(allocation["触发"], {"类型": "打回", "编号": 1})
        self.assertEqual(self.ledger(review)["评审结论"]["原文"], "还要增加要求")
        self.assertEqual(self.events("打回")[-1]["原因"], "增加区域上限")
        # 使用契约已有的参考角色表达评审输入，不新增字段。
        self.assertIn({"引用": review["引用"], "角色": "参考"}, allocation["输入"])

    @verified
    def test_E1_adopt_old_version(self):
        # E1：回退只换指针不产生新版本，吃过第3版的下游全部过期。
        self.ensure("2.2")
        self.run_node("2.2")
        self.run_node("2.2")
        self.ensure("2.9")
        before = set(self.task.rglob("产出台账.json"))
        self.cli("adopt", "--node", "2.2", "--version", "2", "--reason", "第3版不行")
        self.assertEqual(set(self.task.rglob("产出台账.json")), before)
        self.assertEqual(self.status()["节点"]["2.2"]["当前采用"], 2)
        self.assertEqual(self.events("打回"), [])
        self.assert_validity({node: "过期" for node in (*EVALUATIONS, "2.报告整合", "2.9")})

    @verified
    def test_E2_candidates(self):
        # E2：候选择优后另一个显示已替代且保留。
        self.ensure("2.2")
        candidates = [self.run_node("2.2", commit_args=("--metrics", json.dumps({"候选": label})), text=label) for label in ("LR", "XGB")]
        self.cli("adopt", "--node", "2.2", "--version", "2", "--reason", "采用LR")
        self.assertEqual([self.ledger(item)["metrics"]["候选"] for item in candidates], ["LR", "XGB"])
        self.assertEqual(self.status()["节点"]["2.2"]["当前采用"], 2)
        self.assertTrue((self.node_dir("2.2") / "当前采用_第2版.md").exists())
        self.assertTrue(Path(candidates[1]["目录"]).exists())
        self.assertFalse((self.node_dir("2.2") / "当前采用_第3版.md").exists())
        overview = (self.task / "总览.md").read_text(encoding="utf-8")
        self.assertTrue(any("2.2" in line and "第3版" in line and "已替代" in line
                            for line in overview.splitlines()), overview)

    @verified
    def test_E3_skip(self):
        # E3：跳过说明与事件满足下游依赖；不可跳过节点要求人工确认。
        self.cli("skip", "--node", "1.3", "--reason", "本轮不做AB验收")
        self.assertEqual([path.name for path in self.node_dir("1.3").iterdir()], ["已跳过.md"])
        self.done["1.3"] = None
        report = self.ensure("1.报告整合")
        self.assertIn({"引用": "1.3@跳过", "角色": "依赖"}, report["输入"])
        self.cli("skip", "--node", "1.4", "--reason", "免诊断", code=1)
        self.cli("skip", "--node", "1.4", "--reason", "免诊断", "--confirm", "人工批准")
        self.assertEqual(self.events("跳过")[-1]["人工确认"], "人工批准")

    @verified
    def test_F1_sessions(self):
        # F1：跨对话沿用目录，每条流转记录带会话ID，不建对话目录。
        self.env["SKILLFUSE_SESSION"] = "conversation-one"
        first = self.ensure("1.1")
        self.env["SKILLFUSE_SESSION"] = "conversation-two"
        second = self.run_node("1.2")
        for allocation, session in ((first, "conversation-one"), (second, "conversation-two")):
            self.assertEqual(self.ledger(allocation)["会话"], session)
            events = [event for event in self.events() if event.get("节点") == allocation["节点"]]
            self.assertEqual({event["会话"] for event in events}, {session})
        self.assertEqual(Path(second["env"]["SKILLFUSE_TASK_DIR"]), self.task)
        self.assertFalse(any(path.name in ("conversation-one", "conversation-two") for path in self.task.rglob("*")))

    @verified
    def test_F2_inherit_and_diff(self):
        # F2：声明继承并跨课题对比。
        self.ensure("4.报告整合")
        handoff = self.cli("handoff", "--node", "4.报告整合")
        inherited = f"q3-bcard/交接#{handoff['编号']}"
        self.begin("2026Q4迭代", "q4-bcard", "--inherit", inherited)
        allocation = self.ensure("2.2")
        self.assertEqual(read_json(self.task / "课题.json")["继承"], inherited)
        self.assertEqual(self.events("开课题")[0]["继承"], inherited)
        diff = self.command("diff.py", "--task", "q4-bcard", "--from-task", "q3-bcard", "--node", "2.2", "--from", "1", "--to", "1")
        self.assertEqual(diff["基线关系"]["from版本ID"], "q3-bcard/2.2@v1")
        self.assertFalse(diff["基线关系"]["to版以from版为基线"])
        self.assertIn("可能不可靠", diff["文本摘要"])
        self.assertEqual(allocation["版本"], 1)
        self.assertIn(inherited, (self.task / "课题说明.md").read_text(encoding="utf-8"))

    @verified
    def test_F3_external_delivery(self):
        # F3：收到文件和核验报告，明确外部来源；按契约用外部团队字段及分配事件的外部接收触发。
        self.ready("2.2")
        allocation = self.cli("alloc", "--node", "2.2", "--external", "外部建模团队")
        (Path(allocation["目录"]) / "数据" / "收到的模型.txt").write_text("外部模型", encoding="utf-8")
        self.finish(allocation, text="已核验外部交付")
        data = self.ledger(allocation)
        self.assertEqual(data["外部团队"], "外部建模团队")
        self.assertEqual(data["执行方"], "代码")
        self.assertEqual(data["触发"], {"类型": "外部接收", "编号": None})
        self.assertEqual(self.events("分配")[-1]["触发"], data["触发"])
        self.assertIn("数据/收到的模型.txt", [item["相对路径"] for item in data["artifacts"]])

    @verified
    def test_F4_nested_calls(self):
        # F4：被调用方挂在父版本内部调用下，父台账记版本ID，编号只在父版本内计数。
        self.ready("1.2")
        parents = [self.cli("alloc", "--node", "1.2") for _ in range(2)]
        children = []
        for parent in (parents[0], parents[0], parents[1]):
            children.append(self.run_node("取数", alloc_args=("--parent", parent["目录"])))
        self.assertEqual([item["版本"] for item in children], [1, 2, 1])
        self.assertEqual(children[0]["引用"], "1.2@v1/取数@v1")
        self.assertEqual(Path(children[0]["目录"]), Path(parents[0]["目录"]) / "内部调用" / "取数" / "第1版")
        self.assertEqual(self.ledger(parents[0])["children"], [item["引用"] for item in children[:2]])
        for parent in parents:
            self.finish(parent)
        self.assertNotIn("取数", self.status()["节点"])

    @verified
    def test_G1_failed_version(self):
        # G1：失败版占号保留现场，下次分配新版本号。
        self.ready("2.2")
        failed = self.cli("alloc", "--node", "2.2")
        (Path(failed["目录"]) / "日志" / "失败.txt").write_text("训练中断", encoding="utf-8")
        self.cli("commit", "--dir", failed["目录"], "--status", "失败")
        self.assertEqual(self.ledger(failed)["执行状态"], "失败")
        self.assertTrue((self.node_dir("2.2") / "当前采用_无.md").exists())
        recovered = self.run_node("2.2")
        self.assertEqual(recovered["版本"], 2)
        self.assertIsNone(recovered["基线目录"])
        self.assertEqual((Path(failed["目录"]) / "日志" / "失败.txt").read_text(encoding="utf-8"), "训练中断")

    @verified
    def test_G2_concurrent_same_node(self):
        # G2：两个会话同时跑同一步，各拿不同且合法的版本号。
        self.ready("2.2")
        allocations = self.concurrent_alloc(("2.2", "2.2"))
        self.assertEqual({item["版本"] for item in allocations}, {1, 2})
        self.assertEqual(len({item["目录"] for item in allocations}), 2)
        for item in allocations:
            self.assertEqual(self.ledger(item)["引用"], f"2.2@v{item['版本']}")
            self.finish(item)
        events = self.events()
        self.assertEqual([event["序号"] for event in events], list(range(1, len(events) + 1)))
        sessions = {event["会话"] for event in self.events("分配") if event["节点"] == "2.2"}
        self.assertEqual(sessions, {"parallel-0", "parallel-1"})

    @verified
    def test_G3_tampered_artifact(self):
        # G3：体检比对校验值，指出手工改动的文件。
        allocation = self.ensure("1.2")
        path = Path(allocation["目录"]) / "报告" / "结果.md"
        self.assertEqual(path.read_text(encoding="utf-8"), "主交付物")
        path.write_text("人为修改交付物", encoding="utf-8")
        self.corrupted = "结果.md"
        result = self.command("verify.py", code=1)
        self.assertTrue(any("sha256" in item["说明"] and "结果.md" in item["位置"] for item in result["问题"]), result)

    def editable_flow(self):
        # 从冻结流程还原契约编写格式，以JSON提交变更，避免测试引入YAML依赖。
        fields = ("id", "名称", "执行方", "依赖", "门禁", "结论", "可打回至", "可补证至", "可跳过", "可外部交付", "基线", "循环", "交接", "不达标处理", "待核对")
        groups = {}
        for identifier in self.flow["顺序"]:
            node = self.flow["节点"][identifier]
            group = groups.setdefault(node["阶段"], {"id": node["阶段"], "节点": []})
            group["节点"].append({key: node[key] for key in fields if node.get(key) is not None})
        return {"流程": self.flow["流程"], "流程版本": self.flow["流程版本"], "分组": list(groups.values())}

    @verified
    def test_G4_flow_update(self):
        # G4：新增步骤建新目录，改名目录不改，变更记事件，总览显示新名。
        allocation = self.ensure("1.2")
        original = self.node_dir("1.2")
        raw = self.editable_flow()
        group = next(group for group in raw["分组"] if group["id"] == "1")
        next(node for node in group["节点"] if node["id"] == "1.2")["名称"] = "业务基线与画像复核"
        group["节点"].append({"id": "补充分析", "名称": "补充分析", "执行方": "skill", "依赖": ["1.2"]})
        source = self.project / "流程变更.json"
        source.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        change = self.cli("flow-update", "--flow", source, "--reason", "新增复核步骤")
        self.flow = read_json(self.task / "流程定义.json")
        self.assertEqual(change["新增"], ["补充分析"])
        self.assertEqual(change["改名"], [{"id": "1.2", "旧名": "业务基线与客群画像", "新名": "业务基线与画像复核"}])
        self.assertEqual(self.node_dir("1.2"), original)
        self.assertEqual(self.ledger(allocation)["引用"], "1.2@v1")
        new = self.run_node("补充分析")
        self.assertEqual(new["输入"], [{"引用": "1.2@v1", "角色": "依赖"}])
        self.assertEqual(self.events("流程变更")[-1]["摘要"], change)
        self.assertIn("业务基线与画像复核", (self.task / "总览.md").read_text(encoding="utf-8"))

    @verified
    def test_G5_shared_configuration(self):
        # G5：分箱配置出新版，所有用到它的步骤自动过期。
        self.ensure("2.9")
        allocation = self.run_node("评分方向与分箱")
        self.assertEqual(allocation["版本"], 2)
        self.assertEqual(Path(allocation["目录"]).relative_to(self.task).as_posix(), "0_共用配置/评分方向与分箱/第2版")
        self.assert_validity({"2.5": "过期", "2.6": "过期", "2.8": "过期", "2.报告整合": "过期", "2.9": "过期", "2.3": "当前采用", "2.4": "当前采用", "2.7": "当前采用"})

    @verified
    def test_G6_rebuild_views(self):
        # G6：状态可从目录和流转记录重建，总览随时重新生成。
        self.ensure("2.9")
        self.run_node("2.2")
        before = self.status()
        events = (self.task / "流转记录.jsonl").read_text(encoding="utf-8")
        paths = [self.root / ".当前状态.json", self.task / "总览.md", self.task / "未解决项.md", self.root / "总索引.md"]
        paths.extend(self.task.rglob("当前采用_*.md"))
        for path in paths:
            self.assertTrue(path.read_text(encoding="utf-8"))
            path.unlink()
        self.env["SKILLFUSE_SESSION"] = "resumed"
        after = self.cli("status", "--task", "q3-bcard")
        self.assertEqual(after, before)
        self.assertEqual((self.task / "流转记录.jsonl").read_text(encoding="utf-8"), events)
        self.assertIn("过期", (self.task / "总览.md").read_text(encoding="utf-8"))
        self.assertTrue((self.node_dir("2.9") / "当前采用_第1版_已过期.md").exists())
        self.assertTrue((self.root / "总索引.md").exists())


if __name__ == "__main__":
    unittest.main()
