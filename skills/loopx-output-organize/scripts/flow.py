"""流程定义的加载、规范化与变更。"""

import copy
import json
import unicodedata
from pathlib import Path


EXECUTORS = ("skill", "代码", "人工", "配置", "智能体", "报告整合")
GENERIC_VERDICTS = ("通过", "带问题通过", "整改后复验", "补证后再判")
BASELINE_POLICIES = ("上一版", "固定首版", "无")
_INHERITED = ("基线", "门禁结论", "跨阶段打回", "不达标处理")


class FlowError(ValueError):
    problems: list[str]

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("；".join(problems))


def _sanitize_name(name: str) -> str:
    cleaned = "".join(char for char in name if char not in "/\\" and unicodedata.category(char) != "Cc").strip()
    if not cleaned or cleaned in (".", ".."):
        raise ValueError("目录名称清洗后不能为空或路径点段")
    return cleaned


def _valid_id(value: object) -> bool:
    return isinstance(value, str) and bool(value) and not any(
        char in "/@#:" or char.isspace() or unicodedata.category(char) == "Cc" for char in value
    )


def _directory(item: dict) -> str:
    name = item.get("名称")
    return _sanitize_name(f"{item['id']}_{name}" if name else item["id"])


def load_flow_source(path: Path) -> dict:
    if path.suffix.lower() == ".json":
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml
        except ImportError as error:
            raise RuntimeError("读取 YAML 需要 PyYAML；请改用 .json") from error
        with path.open("r", encoding="utf-8") as stream:
            return yaml.safe_load(stream)
    raise ValueError(f"不支持的流程文件格式：{path.suffix}")


def _merged_defaults(parent: dict, item: dict) -> dict:
    merged = dict(parent)
    defaults = item.get("默认") or {}
    if isinstance(defaults, dict):
        merged.update({key: value for key, value in defaults.items() if key in _INHERITED})
    return merged


def _normalize_node(item: dict, stage: str, directory: list[str], defaults: dict) -> dict:
    inherited = dict(defaults)
    inherited.update({key: item[key] for key in _INHERITED if key in item})
    loop = item.get("循环")
    if isinstance(loop, dict):
        loop = copy.deepcopy(loop)
        loop.setdefault("最大轮次", None)
    return {
        "id": item["id"], "名称": item.get("名称") or item["id"], "执行方": item.get("执行方"),
        "阶段": stage, "目录": directory + [_directory(item)],
        "依赖": copy.deepcopy(item.get("依赖") or []), "门禁": item.get("门禁", False),
        "结论": copy.deepcopy(item.get("结论") or {}),
        "门禁结论": copy.deepcopy(inherited.get("门禁结论", list(GENERIC_VERDICTS))),
        "可打回至": copy.deepcopy(item.get("可打回至") or []),
        "可补证至": copy.deepcopy(item.get("可补证至") or []),
        "可跳过": item.get("可跳过", False), "可外部交付": item.get("可外部交付", False),
        "基线": inherited.get("基线", "上一版"), "循环": loop,
        "交接": item.get("交接"), "不达标处理": inherited.get("不达标处理"),
        "跨阶段打回": inherited.get("跨阶段打回", "需人工确认"),
        "待核对": item.get("待核对", False),
    }


def _collect(groups: list, defaults: dict, result: dict, problems: list[str]) -> None:
    seen = set()

    def visit(item: object, stage: str, directory: list[str], inherited: dict) -> None:
        if not isinstance(item, dict):
            problems.append("分组或节点必须是对象")
            return
        identifier = item.get("id")
        if not _valid_id(identifier):
            problems.append(f"无效的节点或分组 id：{identifier!r}")
            return
        if identifier in seen:
            problems.append(f"节点与分组 id 重复：{identifier}")
            return
        seen.add(identifier)
        try:
            label = _directory(item)
        except ValueError as error:
            problems.append(f"{identifier}：{error}")
            return
        if "节点" in item:
            children = item["节点"]
            if not isinstance(children, list):
                problems.append(f"{identifier}：节点必须是列表")
                return
            child_defaults = _merged_defaults(inherited, item)
            for child in children:
                visit(child, stage or identifier, directory + [label], child_defaults)
            return
        node = _normalize_node(item, stage, directory, inherited)
        result["顺序"].append(identifier)
        result["节点"][identifier] = node
        handoff = node["交接"]
        if handoff is not None:
            if not isinstance(handoff, str) or not handoff:
                problems.append(f"{identifier}：交接名不能为空")
            elif handoff in result["交接点"]:
                problems.append(f"交接名重复：{handoff}")
            else:
                result["交接点"][handoff] = identifier

    for group in groups:
        if not isinstance(group, dict) or "节点" not in group:
            problems.append("顶层分组必须包含节点列表")
        else:
            visit(group, "", [], defaults)


def _check_cycle(flow: dict, problems: list[str]) -> None:
    nodes = flow["节点"]
    handoffs = flow["交接点"]
    state = {}

    def visit(identifier: str) -> None:
        if state.get(identifier) == 1:
            problems.append(f"依赖成环：{identifier}")
            return
        if state.get(identifier) == 2:
            return
        state[identifier] = 1
        for dep in nodes[identifier]["依赖"]:
            # 交接依赖指向产出交接物的节点，参与同一张依赖图的成环检查。
            target = handoffs.get(dep[3:]) if isinstance(dep, str) and dep.startswith("交接:") else dep
            if isinstance(target, str) and target in nodes:
                visit(target)
        state[identifier] = 2

    for identifier in nodes:
        visit(identifier)


def _validate(flow: dict, problems: list[str]) -> None:
    nodes = flow["节点"]
    handoffs = flow["交接点"]
    for identifier, node in nodes.items():
        if node["执行方"] not in EXECUTORS:
            problems.append(f"{identifier}：无效执行方 {node['执行方']!r}")
        for field in ("依赖", "可打回至", "可补证至"):
            if not isinstance(node[field], list):
                problems.append(f"{identifier}：{field}必须是列表")
                node[field] = []
        for dep in node["依赖"]:
            if not isinstance(dep, str) or (dep not in nodes and not (dep.startswith("交接:") and dep[3:] in handoffs)):
                problems.append(f"{identifier}：依赖不存在 {dep!r}")
        for field in ("可打回至", "可补证至"):
            for target in node[field]:
                if not isinstance(target, str) or target not in nodes:
                    problems.append(f"{identifier}：{field}目标不存在 {target!r}")
        loop = node["循环"]
        if loop is not None:
            if not isinstance(loop, dict) or not isinstance(loop.get("与"), str) or loop["与"] not in nodes:
                problems.append(f"{identifier}：循环.与目标不存在")
        if not isinstance(node["结论"], dict):
            problems.append(f"{identifier}：结论必须是映射")
        elif not isinstance(node["门禁结论"], list):
            problems.append(f"{identifier}：门禁结论必须是列表")
        else:
            for verdict in node["结论"].values():
                if verdict not in node["门禁结论"]:
                    problems.append(f"{identifier}：结论值不在门禁结论中 {verdict!r}")
        if node["基线"] not in BASELINE_POLICIES:
            problems.append(f"{identifier}：无效基线 {node['基线']!r}")
        if node["门禁"] is True and node["执行方"] == "配置":
            problems.append(f"{identifier}：配置节点不能设置门禁")
    _check_cycle(flow, problems)


def normalize_flow(raw: dict) -> dict:
    problems = []
    if not isinstance(raw, dict):
        raise FlowError(["流程定义必须是对象"])
    if not isinstance(raw.get("流程"), str) or not raw["流程"]:
        problems.append("流程必填")
    groups = raw.get("分组")
    if not isinstance(groups, list):
        problems.append("分组必填且必须是列表")
        groups = []
    result = {"schema_version": "2.0", "流程": raw.get("流程"),
              "流程版本": raw.get("流程版本"), "顺序": [], "交接点": {}, "已移出": [], "节点": {}}
    _collect(groups, _merged_defaults({}, raw), result, problems)
    _validate(result, problems)
    if problems:
        raise FlowError(problems)
    return result


def implicit_flow() -> dict:
    return {"schema_version": "2.0", "流程": "单独调用", "流程版本": None,
            "顺序": [], "交接点": {}, "已移出": [], "节点": {}}


def with_node(flow: dict, node_id: str, executor: str = "skill") -> dict:
    if not _valid_id(node_id):
        raise FlowError([f"无效的节点 id：{node_id!r}"])
    if executor not in EXECUTORS:
        raise FlowError([f"无效执行方：{executor!r}"])
    result = copy.deepcopy(flow)
    if node_id in result["节点"]:
        return result
    node = _normalize_node({"id": node_id, "执行方": executor}, "", [], {})
    result["节点"][node_id] = node
    result["顺序"].append(node_id)
    result["已移出"] = [item for item in result["已移出"] if item != node_id]
    return result


def update_flow(old: dict, raw_new: dict) -> tuple[dict, dict]:
    result = normalize_flow(raw_new)
    old_nodes = old["节点"]
    new_nodes = result["节点"]
    added = [identifier for identifier in result["顺序"] if identifier not in old_nodes]
    removed = [identifier for identifier in old["顺序"] if identifier not in new_nodes]
    renamed = []
    for identifier in result["顺序"]:
        if identifier in old_nodes:
            previous = old_nodes[identifier]
            current = new_nodes[identifier]
            # 目录一经写入流程定义就冻结，分组或节点改名都不迁移旧产出。
            current["目录"] = copy.deepcopy(previous["目录"])
            if previous["名称"] != current["名称"]:
                renamed.append({"id": identifier, "旧名": previous["名称"], "新名": current["名称"]})
    for identifier, node in old_nodes.items():
        if identifier not in new_nodes:
            new_nodes[identifier] = copy.deepcopy(node)
    result["已移出"] = list(dict.fromkeys(
        identifier for identifier in old.get("已移出", []) + removed if identifier not in result["顺序"]
    ))
    return result, {"新增": added, "移出": removed, "改名": renamed}


def find_template(name: str) -> Path:
    base = Path(__file__).resolve().parents[1] / "references" / "流程模板"
    for suffix in (".yaml", ".yml", ".json"):
        path = base / f"{name}{suffix}"
        if path.is_file():
            return path
    raise FileNotFoundError(f"流程模板不存在：{name}")


def resolve_verdict(flow: dict, node_id: str, text: str) -> str:
    node = flow["节点"][node_id]
    if text in node["结论"]:
        return node["结论"][text]
    if text in node["门禁结论"] and text in GENERIC_VERDICTS:
        return text
    raise FlowError([f"{node_id}：未知结论 {text!r}"])


def is_cross_stage(flow: dict, src: str, dst: str) -> bool:
    return flow["节点"][src]["阶段"] != flow["节点"][dst]["阶段"]
