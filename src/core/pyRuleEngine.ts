/**
 * 规则判定引擎的 Python 源码片段——`rule_scorers.py` 与 `loopx_evaluator.py` 共用，
 * 保证两边对同一份 rule_checks 的判定完全一致。
 *
 * 片段假定调用方已 `import json` / `import re`，并定义了 `RULES`（rule_checks 的列表形态）。
 */
export const PY_RULE_ENGINE = `def _wlen(text: str) -> int:
    """加权长度：CJK 字符的信息密度约为拉丁字符的两倍。"""
    return sum(
        2 if ("一" <= c <= "鿿" or "㐀" <= c <= "䶿" or "\\u3000" <= c <= "〿" or "＀" <= c <= "￯") else 1
        for c in re.sub(r"\\s", "", text)
    )


def _check(rule, output: str) -> tuple[bool, str]:
    kind = rule["kind"]
    p = rule.get("params", {})
    text = output or ""

    if kind == "non_empty":
        ok = len(text.strip()) > 0
        return ok, "输出非空" if ok else "输出为空"
    if kind == "min_length":
        n = p.get("min", 100)
        ln = _wlen(text)
        ok = ln >= n
        return ok, f"长度 {ln} ≥ {n}" if ok else f"过短：{ln}（< {n}）"
    if kind == "max_length":
        n = p.get("max", 20000)
        ln = _wlen(text)
        ok = ln <= n
        return ok, f"长度 {ln} ≤ {n}" if ok else f"过长：{ln}（> {n}）"
    if kind == "valid_json":
        candidate = text.strip()
        m = re.search(r"\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`", candidate)
        if m:
            candidate = m.group(1).strip()
        try:
            json.loads(candidate)
            return True, "输出可解析为 JSON"
        except Exception as exc:
            return False, f"非法 JSON：{exc}"
    if kind == "has_heading":
        ok = re.search(r"^#{1,6}\\s+\\S", text, re.M) is not None
        return ok, "找到 Markdown 标题" if ok else "未找到 Markdown 标题"
    if kind == "has_table":
        ok = re.search(r"^\\s*\\|.+\\|\\s*$", text, re.M) is not None
        return ok, "找到 Markdown 表格" if ok else "未找到 Markdown 表格"
    if kind == "has_code_block":
        ok = "\`\`\`" in text
        return ok, "找到围栏代码块" if ok else "未找到围栏代码块"
    if kind == "no_emoji":
        m = re.search("[\\U0001F300-\\U0001FAFF\\u2600-\\u27BF\\uFE0F\\u200D]", text)
        return m is None, "未发现 emoji" if m is None else f"发现 emoji：{m.group(0)}"
    if kind == "contains_any":
        terms = p.get("terms", [])
        flags = p.get("flags", "")
        if "regex" in p:
            ok = re.search(p["regex"], text, re.U if "u" in flags else 0) is None
            return ok, "违禁模式未出现" if ok else f"发现违禁模式：{p['regex']}"
        hits = [t for t in terms if t.lower() in text.lower()]
        need = p.get("min_match", len(terms))
        ok = len(hits) >= need
        return ok, f"命中 {len(hits)}/{need}：{hits}"
    if kind == "contains_all":
        terms = p.get("terms", [])
        missing = [t for t in terms if t.lower() not in text.lower()]
        return not missing, "所有必备项均已包含" if not missing else f"缺少：{missing}"
    if kind == "not_contains":
        if "regex" in p:
            m = re.search(p["regex"], text, re.U if "u" in p.get("flags", "") else 0)
            return m is None, "违禁模式未出现" if m is None else f"发现违禁内容：{m.group(0)!r}"
        terms = p.get("terms", [])
        hits = [t for t in terms if t.lower() in text.lower()]
        return not hits, "未发现违禁词" if not hits else f"发现违禁词：{hits}"
    return True, f"未知规则类型 {kind!r}（已跳过）"`;
