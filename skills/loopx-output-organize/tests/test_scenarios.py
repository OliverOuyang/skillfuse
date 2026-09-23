"""产出管家的独立临时项目端到端场景。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from ledger import validate_ledger  # noqa: E402


class StewardScenarios(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name) / "project"
        self.project.mkdir()
        (self.project / ".git").mkdir()
        self.output = self.project / "产出"

    def command(self, script, *arguments, succeeds=True):
        environment = os.environ.copy()
        environment.pop("SKILLFUSE_OUTPUT_ROOT", None)
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / script), "--output-root", str(self.output),
             *map(str, arguments)],
            cwd=self.project, env=environment, capture_output=True, text=True,
            check=False,
        )
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            self.fail(f"{self._testMethodName}: {script} {arguments} 未输出 JSON：{result.stdout!r}；{result.stderr!r}；{error}")
        if succeeds:
            self.assertEqual(result.returncode, 0,
                             f"{self._testMethodName}: {script} {arguments} 失败：{data}")
        else:
            self.assertNotEqual(result.returncode, 0,
                                f"{self._testMethodName}: {script} {arguments} 意外成功：{data}")
        return data

    def steward(self, *arguments, succeeds=True):
        return self.command("steward.py", *arguments, succeeds=succeeds)

    def begin(self, name, *, temp=False):
        arguments = ["task-begin", "--name", name, "--goal", "验证产出", "--criteria", "产出可追溯"]
        if temp:
            arguments.append("--temp")
        task = Path(self.steward(*arguments)["课题目录"])
        run = Path(self.steward("run-begin", "--task", name)["执行目录"])
        return task, run

    def version(self, skill, skill_cn, *, status="成功", baseline="latest", label=None, parent=None):
        arguments = ["alloc", "--skill", skill, "--skill-cn", skill_cn, "--baseline", baseline]
        if parent is not None:
            arguments += ["--parent", str(parent)]
        allocation = self.steward(*arguments)
        directory = Path(allocation["目录"])
        number = allocation["版本号"]
        label = label or f"第{number}版"
        (directory / "报告" / "结果.md").write_text(label, encoding="utf-8")
        (directory / "数据" / "结果.csv").write_text("version\n" + str(number) + "\n", encoding="utf-8")
        (directory / "执行记录" / "trace.jsonl").write_text(
            json.dumps({"ts": "2026-09-23T12:00:00+08:00", "step": "skill.run_script",
                        "status": "fail" if status == "失败" else "ok", "duration_ms": 1},
                       ensure_ascii=False) + "\n", encoding="utf-8")
        (directory / "日志" / "run.log").write_text(label, encoding="utf-8")
        arguments = ["commit", "--dir", directory, "--status", status]
        if status != "失败":
            arguments += ["--primary", "报告/结果.md"]
        self.steward(*arguments)
        return allocation

    def finish(self, run, *, status="成功"):
        (run / "最终交付" / "交付.md").write_text("最终交付\n", encoding="utf-8")
        return self.steward("run-finish", "--primary", "最终交付/交付.md",
                            "--summary", "场景完成", "--status", status)

    def audit(self, expected_ledgers):
        ledgers = sorted(self.output.rglob("产出台账.json"))
        self.assertEqual(len(ledgers), expected_ledgers,
                         f"{self._testMethodName}: 台账数量不符：{ledgers}")
        for path in ledgers:
            with self.subTest(ledger=path):
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(validate_ledger(data), [],
                                 f"{self._testMethodName}: 台账校验失败：{path}")
        result = self.command("verify.py")
        self.assertEqual(result["汇总"]["error"], 0,
                         f"{self._testMethodName}: verify.py 发现错误：{result['问题']}")

    def test_single_skill_once(self):
        # 场景1：单个 skill 的一次执行形成完整三层目录、四区和合规台账。
        task, run = self.begin("周度获客复盘")
        allocation = self.version("acquisition-analysis", "获客分析")
        directory = Path(allocation["目录"])
        result = self.finish(run)
        self.assertTrue((task / "课题说明.md").is_file(), "场景1：缺少课题说明")
        for name in ("本次说明.md", "我的需求", "最终交付", "执行记录", "各环节产出"):
            self.assertTrue((run / name).exists(), f"场景1：执行层缺少 {name}")
        self.assertEqual(directory, run / "各环节产出" / "获客分析" / "第1版",
                         "场景1：版本目录不在预期层级")
        for name in ("报告", "数据", "执行记录", "日志"):
            self.assertTrue((directory / name).is_dir(), f"场景1：版本缺少 {name} 区")
        self.assertEqual(result["steps"][0]["最终采用版本ID"], allocation["标准ID"],
                         "场景1：执行未采用唯一版本")
        self.audit(3)

    def test_repeated_tuning(self):
        # 场景2：同一 skill 三次调优逐版递增，旧版不覆盖且第2版引用第1版。
        task, run = self.begin("获客分析调优")
        versions = [self.version("acquisition-analysis", "获客分析", label=f"内容{i}")
                    for i in range(1, 4)]
        self.finish(run)
        self.assertEqual([item["版本号"] for item in versions], [1, 2, 3],
                         "场景2：版本号没有连续递增")
        for i, item in enumerate(versions, 1):
            directory = Path(item["目录"])
            self.assertEqual((directory / "报告" / "结果.md").read_text(encoding="utf-8"),
                             f"内容{i}", f"场景2：第{i}版被覆盖")
        self.assertEqual(versions[1]["基线目录"], versions[0]["目录"],
                         "场景2：第2版基线目录未指向第1版")
        second = json.loads((Path(versions[1]["目录"]) / "产出台账.json").read_text(encoding="utf-8"))
        self.assertIn({"类型": "产物", "引用": versions[0]["标准ID"], "角色": "基线"},
                      second["inputs"], "场景2：第2版台账未记录第1版基线")
        self.assertTrue((task / "版本对比" / "获客分析" / "第3版").is_file(),
                        "场景2：缺少第3版索引")
        self.audit(5)

    def test_multiple_skills(self):
        # 场景3：三个 skill 分别产出，收尾步骤记录每个 skill 最终采用的版本。
        _, run = self.begin("Q3风险复盘")
        data = self.version("fetch-data", "取数")
        reports = [self.version("risk-report", "风险报告") for _ in range(3)]
        chart = self.version("make-chart", "图表生成")
        result = self.finish(run)
        expected = {"fetch-data": data["标准ID"], "risk-report": reports[-1]["标准ID"],
                    "make-chart": chart["标准ID"]}
        actual = {step["skill名称"]: step["最终采用版本ID"] for step in result["steps"]}
        self.assertEqual(actual, expected, "场景3：steps 未记录三个 skill 的最终版本")
        for item in (data, *reports, chart):
            self.assertTrue(Path(item["目录"]).is_dir(),
                            f"场景3：缺少 skill 版本目录 {item['目录']}")
        run_ledger = json.loads((run / "产出台账.json").read_text(encoding="utf-8"))
        self.assertEqual(run_ledger["steps"], result["steps"],
                         "场景3：执行台账与收尾 steps 不一致")
        self.audit(7)

    def test_same_task_across_runs(self):
        # 场景4：同一课题跨两次执行后，第二次的版本号继续从第3版递增。
        task, first_run = self.begin("信贷模型调优")
        first = [self.version("model-evaluation", "模型评估") for _ in range(2)]
        self.finish(first_run)
        second_run = Path(self.steward("run-begin", "--task", "信贷模型调优")["执行目录"])
        third = self.version("model-evaluation", "模型评估")
        self.finish(second_run)
        self.assertNotEqual(first_run, second_run, "场景4：第二次执行覆盖第一次")
        self.assertTrue(first_run.name.startswith("第1次执行_"), "场景4：首次执行编号错误")
        self.assertTrue(second_run.name.startswith("第2次执行_"), "场景4：第二次执行编号错误")
        self.assertEqual([item["版本号"] for item in (*first, third)], [1, 2, 3],
                         "场景4：跨执行版本号未连续递增")
        self.assertEqual(Path(third["目录"]).parent, second_run / "各环节产出" / "模型评估",
                         "场景4：第3版未落在第二次执行")
        self.assertEqual(third["基线目录"], first[-1]["目录"],
                         "场景4：第3版未继承第一次执行的基线")
        self.assertTrue((task / "版本对比" / "模型评估" / "第3版").is_file(),
                        "场景4：跨执行索引缺少第3版")
        self.audit(6)

    def test_nested_skill_call(self):
        # 场景5：内部调用的子 skill 应归入父版本的内部调用目录，且父子台账各记各的产物。
        _, run = self.begin("风险报告嵌套取数")
        parent = self.version("risk-report", "风险报告")
        child = self.version("fetch-data", "取数", parent=parent["目录"])
        self.finish(run)
        self.audit(4)
        expected = Path(parent["目录"]) / "内部调用" / "取数" / "第1版"
        self.assertEqual(Path(child["目录"]), expected,
                         "场景5：alloc 没有将子 skill 放入父版本的内部调用目录")
        parent_ledger = json.loads((Path(parent["目录"]) / "产出台账.json").read_text(encoding="utf-8"))
        self.assertIn(child["标准ID"], parent_ledger["children"],
                      "场景5：父台账的 children 未记录子版本标准ID")
        nested = [item["相对路径"] for item in parent_ledger["artifacts"]
                  if item["相对路径"].startswith("内部调用/")]
        self.assertEqual(nested, [],
                         "场景5：父台账重复记账了子 skill 的产物，应由子台账负责")

    def test_failure_then_recovery(self):
        # 场景6：失败版保留现场并占号，收尾采用成功版而跳过最后的失败版。
        _, run = self.begin("失败恢复")
        first = self.version("risk-report", "风险报告", status="失败", label="首次失败现场")
        second = self.version("risk-report", "风险报告", status="成功", label="可采用版本")
        third = self.version("risk-report", "风险报告", status="失败", label="再次失败现场")
        result = self.finish(run)
        self.assertEqual([item["版本号"] for item in (first, second, third)], [1, 2, 3],
                         "场景6：失败版未占用版本号")
        for item, label in ((first, "首次失败现场"), (third, "再次失败现场")):
            directory = Path(item["目录"])
            self.assertEqual((directory / "报告" / "结果.md").read_text(encoding="utf-8"),
                             label, "场景6：失败现场未保留")
            ledger = json.loads((directory / "产出台账.json").read_text(encoding="utf-8"))
            self.assertEqual(ledger["状态"], "失败", "场景6：失败状态未记账")
        self.assertEqual(result["steps"][0]["最终采用版本ID"], second["标准ID"],
                         "场景6：收尾没有跳过失败版")
        self.audit(5)

    def test_temporary_task(self):
        # 场景7：临时课题使用【临时】前缀，仍有正式课题的完整结构。
        task, run = self.begin("随手跑", temp=True)
        allocation = self.version("quick-analysis", "快速分析")
        self.finish(run)
        self.assertEqual(task.name, "【临时】随手跑", "场景7：未创建临时课题目录")
        self.assertTrue((task / "课题说明.md").is_file(), "场景7：临时课题缺少说明")
        self.assertTrue((run / "本次说明.md").is_file(), "场景7：临时执行缺少说明")
        self.assertTrue((run / "我的需求").is_dir(), "场景7：临时执行缺少需求区")
        self.assertTrue((run / "最终交付").is_dir(), "场景7：临时执行缺少交付区")
        self.assertEqual(Path(allocation["目录"]).parent,
                         run / "各环节产出" / "快速分析", "场景7：临时版本结构错误")
        self.audit(3)

    def test_task_begin_is_idempotent(self):
        # 边界：同名课题重复 task-begin 不报错，也不覆盖已有课题说明。
        first = self.steward("task-begin", "--name", "幂等课题", "--goal", "初始目标")
        task = Path(first["课题目录"])
        explanation = task / "课题说明.md"
        explanation.write_text("用户补充的课题说明\n", encoding="utf-8")
        second = self.steward("task-begin", "--name", "幂等课题", "--goal", "不同目标")
        self.assertEqual(second["课题目录"], first["课题目录"],
                         "幂等边界：重复执行新建了课题")
        self.assertEqual(explanation.read_text(encoding="utf-8"), "用户补充的课题说明\n",
                         "幂等边界：已有课题说明被覆盖")
        self.audit(1)

    def test_output_root_must_stay_in_project(self):
        # 边界：显式产出根位于项目根外时，命令失败且不创建课题。
        outside = Path(self.temporary.name) / "outside"
        self.output = outside
        result = self.steward("task-begin", "--name", "越界课题", succeeds=False)
        self.assertIn("产出根必须位于项目根目录内", result.get("error", ""),
                      "越界边界：错误信息未指出项目根限制")
        self.assertFalse(outside.exists(), "越界边界：项目外被创建了产出目录")

    def test_latest_index_points_to_highest_version(self):
        # 边界：连续提交三版后，最新版索引应指向第3版的实际目录。
        task, run = self.begin("索引课题")
        versions = [self.version("index-analysis", "索引分析") for _ in range(3)]
        self.finish(run)
        indexes = task / "版本对比" / "索引分析"
        for number in (1, 2, 3):
            self.assertTrue((indexes / f"第{number}版").is_file(),
                            f"索引边界：缺少第{number}版索引")
        latest = json.loads((indexes / "最新版").read_text(encoding="utf-8"))
        self.assertEqual(latest["版本号"], 3, "索引边界：最新版未指向最大版本号")
        self.assertEqual((task / latest["相对路径"]).resolve(),
                         Path(versions[-1]["目录"]).resolve(),
                         "索引边界：最新版目标目录错误")
        self.audit(5)


if __name__ == "__main__":
    unittest.main()
