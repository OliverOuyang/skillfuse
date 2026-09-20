/**
 * 极简 Markdown 预览——只覆盖 skill 交付物里真正会出现的语法：
 * 标题、围栏代码块、表格、有序/无序列表、引用、段落，以及行内 `code` 与 **加粗**。
 *
 * 渲染的是模型输出，属于不可信内容：全程用 React 元素构建，不走 innerHTML，
 * 所以不存在注入风险；不认识的语法按纯文本原样显示，而不是悄悄吞掉。
 */
import type { ReactNode } from "react";

export function MarkdownPreview({ source }: { source: string }) {
  return <div className="space-y-2.5 text-[12.5px] leading-relaxed">{renderBlocks(source)}</div>;
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // 跳过收尾围栏
      out.push(
        <pre
          key={key++}
          className="overflow-auto rounded-lg border bg-muted/50 p-3 font-code text-[11.5px] leading-relaxed scroll-slim"
        >
          {fence[1] && <span className="mb-1 block text-[10.5px] uppercase text-muted-foreground">{fence[1]}</span>}
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    // 表格：表头 + 分隔行 + 若干数据行
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        <div key={key++} className="overflow-auto rounded-lg border scroll-slim">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-muted/60">
              <tr>
                {head.map((h, n) => (
                  <th key={n} className="border-b px-2.5 py-1.5 text-left font-semibold">
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n} className="even:bg-muted/25">
                  {r.map((c, m) => (
                    <td key={m} className="border-b px-2.5 py-1.5 align-top">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const size = level <= 1 ? "text-[17px]" : level === 2 ? "text-[15px]" : "text-[13.5px]";
      out.push(
        <p key={key++} className={`${size} font-semibold leading-snug ${level <= 2 ? "mt-1 border-b pb-1" : ""}`}>
          {inline(heading[2])}
        </p>,
      );
      i++;
      continue;
    }

    // 列表（连续的 - / * / 1. 行）
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
      }
      const ListTag = ordered ? "ol" : "ul";
      out.push(
        <ListTag key={key++} className={`ml-5 space-y-1 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key++} className="border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {inline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // 段落（空行分隔）
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|\s*>|\s*\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }

  return out;
}

const splitRow = (line: string) =>
  line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** 行内语法：`code` 与 **bold**，其余原样输出。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-code text-[11.5px]">
          {m[1]}
        </code>,
      );
    } else {
      out.push(
        <strong key={key++} className="font-semibold">
          {m[2]}
        </strong>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
