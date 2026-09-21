/**
 * Python 契约引擎与导出的评测器一起运行，使用标准库完成格式、章节、表格和事实核验。
 * pending 事实只会跳过并留下明确说明，避免把未确认的业务数值误判为通过。
 */

export const PY_CONTRACT_ENGINE = `from html.parser import HTMLParser


class _TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0
        self.heading = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in ("script", "style"):
            self.hidden += 1
        if re.fullmatch(r"h[1-6]", tag):
            self.heading += 1
            self.parts.append("\\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1
        if re.fullmatch(r"h[1-6]", tag) and self.heading:
            self.heading -= 1
            self.parts.append("\\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


class _StructureParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.headings = []
        self.tables = []
        self._heading = None
        self._table = None
        self._row = None
        self._cell = None
        self._cell_tag = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if re.fullmatch(r"h[1-6]", tag):
            self._heading = []
        elif tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("th", "td") and self._row is not None:
            self._cell = []
            self._cell_tag = tag

    def handle_endtag(self, tag):
        tag = tag.lower()
        if re.fullmatch(r"h[1-6]", tag) and self._heading is not None:
            self.headings.append("".join(self._heading).strip())
            self._heading = None
        elif tag in ("th", "td") and self._cell is not None and self._row is not None:
            self._row.append((self._cell_tag, "".join(self._cell).strip()))
            self._cell = None
            self._cell_tag = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None

    def handle_data(self, data):
        if self._heading is not None:
            self._heading.append(data)
        if self._cell is not None:
            self._cell.append(data)


def _strip_html(text) -> str:
    parser = _TextParser()
    try:
        parser.feed(text or "")
        parser.close()
        return "".join(parser.parts)
    except Exception:
        return re.sub(r"<[^>]+>", " ", text or "")


def _detect_format(text) -> str:
    source = text or ""
    if re.search(r"<(html|body)\\b[^>]*>[\\s\\S]*?</\\1\\s*>", source, re.I):
        return "html"
    opened = {tag.lower() for tag in re.findall(r"<([a-z][a-z0-9]*)\\b[^>]*>", source, re.I)}
    closed = {tag.lower() for tag in re.findall(r"</([a-z][a-z0-9]*)\\s*>", source, re.I)}
    paired = opened & closed
    if len(paired) >= 2:
        return "html"
    candidate = source.strip()
    fenced = re.search(r"\`\`\`json\\s*([\\s\\S]*?)\`\`\`", candidate, re.I)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        json.loads(candidate)
        return "json"
    except Exception:
        pass
    if re.search(r"^#{1,6}\\s+\\S", source, re.M) or re.search(r"^\\s*\\|.+\\|\\s*$", source, re.M):
        return "markdown"
    return "text"


def _check_format(text, want):
    if want == "text":
        return "pass", "文本格式不作限制"
    actual = _detect_format(text)
    if want == "html":
        try:
            parser = HTMLParser()
            parser.feed(text or "")
            parser.close()
        except Exception as exc:
            return "fail", f"HTML 无法解析：{exc}"
        return ("pass", "检测到完整 HTML") if actual == "html" else ("fail", f"需要 HTML，实际检测为 {actual}")
    if want == "markdown":
        if actual == "html":
            return "fail", "需要 Markdown，但输出为 HTML"
        return ("pass", "检测到 Markdown") if actual == "markdown" else ("fail", f"需要 Markdown，实际检测为 {actual}")
    if want == "json":
        return ("pass", "检测到合法 JSON") if actual == "json" else ("fail", f"需要 JSON，实际检测为 {actual}")
    return "fail", f"不支持的契约格式：{want}"


def _check_sections(text, sections):
    if not sections:
        return "pass", "未要求章节"
    actual = _detect_format(text)
    headings = []
    if actual == "markdown":
        headings = [m.group(1).strip() for m in re.finditer(r"^#{1,6}\\s*(.+?)\\s*$", text or "", re.M)]
    elif actual == "html":
        parser = _StructureParser()
        parser.feed(text or "")
        headings = parser.headings
    missing = [section for section in sections if not any(str(section).lower() in heading.lower() for heading in headings)]
    if not missing:
        return "pass", f"章节标题齐全：{len(sections)}/{len(sections)}"
    plain = _strip_html(text)
    body_hits = [section for section in missing if str(section).lower() in plain.lower()]
    truly_missing = [section for section in missing if section not in body_hits]
    if truly_missing:
        return "fail", "缺少章节：" + "、".join(map(str, truly_missing))
    return "pass", "章节仅正文命中，未作为标题出现：" + "、".join(map(str, body_hits))


def _markdown_tables(text):
    lines = (text or "").splitlines()
    tables = []
    for index in range(len(lines) - 1):
        header = lines[index].strip()
        separator = lines[index + 1].strip()
        if header.startswith("|") and header.endswith("|") and re.match(r"^\\|?\\s*:?-{3,}", separator):
            tables.append([cell.strip() for cell in header.strip("|").split("|")])
    return tables


def _html_tables(text):
    parser = _StructureParser()
    try:
        parser.feed(text or "")
    except Exception:
        return []
    headers = []
    for table in parser.tables:
        ths = [value for row in table for tag, value in row if tag == "th"]
        if ths:
            headers.append(ths)
        elif table:
            headers.append([value for _, value in table[0]])
    return headers


def _check_tables(text, specs):
    if not specs:
        return "pass", "未要求表格"
    tables = _html_tables(text) if _detect_format(text) == "html" else _markdown_tables(text)
    if not tables:
        return "fail", "未找到表格"
    for spec in specs:
        required = spec.get("columns", []) if isinstance(spec, dict) else []
        if required and not any(all(any(str(column).lower() in cell.lower() for cell in table) for column in required) for table in tables):
            return "fail", "没有表格覆盖全部必备列：" + "、".join(map(str, required))
    return "pass", f"表格要求通过：{len(specs)} 项"


def _parse_number(value):
    if value is None:
        return None
    source = str(value).strip().translate(str.maketrans("０１２３４５６７８９．，％－＋", "0123456789.,%-+"))
    match = re.search(r"[-+]?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:%|万|亿|[kKmM])?", source)
    if not match:
        return None
    token = match.group(0).replace(",", "").replace(" ", "")
    multiplier = 1.0
    if token.endswith("%"):
        multiplier = 0.01
        token = token[:-1]
    elif token.endswith("万"):
        multiplier = 1e4
        token = token[:-1]
    elif token.endswith("亿"):
        multiplier = 1e8
        token = token[:-1]
    elif token[-1:].lower() == "k":
        multiplier = 1e3
        token = token[:-1]
    elif token[-1:].lower() == "m":
        multiplier = 1e6
        token = token[:-1]
    try:
        return float(token) * multiplier
    except ValueError:
        return None


def _check_facts(text, facts):
    results = []
    plain = _strip_html(text)
    number_re = r"[-+＋－]?[0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]+)?\\s*(?:[%％]|万|亿|[kKmM])?"
    for fact in facts or []:
        name = str(fact.get("name", ""))
        if fact.get("status") != "confirmed" or fact.get("value") is None:
            results.append({"name": f"事实:{name}", "status": "skip", "comment": "关键数据未核验（待业务补齐）"})
            continue
        positions = [match.start() for match in re.finditer(re.escape(name), plain, re.I)] if name else []
        if not positions:
            results.append({"name": f"事实:{name}", "status": "fail", "comment": "未提及该指标"})
            continue
        unit = str(fact.get("unit", ""))
        tokens = []
        for position in positions:
            line_start = plain.rfind("\\n", 0, position) + 1
            line_end = plain.find("\\n", position)
            if line_end < 0:
                line_end = len(plain)
            nearby = plain[line_start:max(line_end, position + len(name) + 60)]
            tokens.extend(re.findall(number_re, nearby))
        candidates = [
            _parse_number(token if re.search(r"[%％万亿kKmM]\\s*$", token) or not unit else token + unit)
            for token in tokens
        ]
        expected_source = str(fact.get("value"))
        if unit and not re.search(r"[%％万亿kKmM]\\s*$", expected_source):
            expected_source += unit
        expected = _parse_number(expected_source)
        tolerance = abs(float(fact.get("tolerance", 0) or 0))
        if expected is not None and any(candidate is not None and abs(candidate - expected) <= tolerance for candidate in candidates):
            results.append({"name": f"事实:{name}", "status": "pass", "comment": "指标值在容忍范围内"})
        else:
            results.append({"name": f"事实:{name}", "status": "fail", "comment": f"指标值不符，期望 {fact.get('value')}±{tolerance}"})
    return results


def _check_statements(text, statements):
    plain = _strip_html(text).lower()
    missing = [item for item in statements or [] if str(item).lower() not in plain]
    return ("pass", "必备表述齐全") if not missing else ("fail", "缺少表述：" + "、".join(map(str, missing)))


def _check_forbidden(text, terms):
    plain = _strip_html(text).lower()
    hits = [term for term in terms or [] if str(term).lower() in plain]
    return ("pass", "未发现禁止内容") if not hits else ("fail", "命中禁止词：" + "、".join(map(str, hits)))


def _check_external_scripts(text):
    pattern = r'''<(?:script\\b[^>]+src|link\\b[^>]+href|img\\b[^>]+src)\\s*=\\s*["']?(?:https?:)?//'''
    match = re.search(pattern, text or "", re.I)
    return ("pass", "未引用外部资源") if not match else ("fail", f"发现外部资源：{match.group(0)}")


def _run_contract(text, contract):
    if not isinstance(contract, dict) or not contract:
        return []
    results = []

    def add(name, result):
        status, comment = result
        results.append({"name": name, "status": status, "comment": comment})

    add("格式", _check_format(text, contract.get("format", "text")))
    add("章节", _check_sections(text, contract.get("required_sections", [])))
    add("表格", _check_tables(text, contract.get("required_tables", [])))
    add("必须包含", _check_statements(text, contract.get("must_include", [])))
    add("结论表述", _check_statements(text, contract.get("required_statements", [])))
    add("禁止内容", _check_forbidden(text, contract.get("must_not_include", [])))
    if contract.get("forbid_external_scripts"):
        add("外部资源", _check_external_scripts(text))
    results.extend(_check_facts(text, contract.get("facts", [])))
    return results`;
