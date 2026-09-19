import { load as loadYaml } from "js-yaml";
import type { ParsedSkill, SkillSection } from "./types";

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/** Parse a SKILL.md document into frontmatter + structured sections. */
export function parseSkill(markdown: string, sourceName = "SKILL.md"): ParsedSkill {
  const raw = markdown.replace(/\r\n/g, "\n");
  let frontmatter: Record<string, unknown> = {};
  let body = raw;

  const fm = raw.match(FRONTMATTER_RE);
  if (fm) {
    try {
      const parsed = loadYaml(fm[1]);
      if (parsed && typeof parsed === "object") {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      // tolerate broken yaml — fall back to empty frontmatter
    }
    body = raw.slice(fm[0].length);
  }

  const sections = splitSections(body);

  const name =
    str(frontmatter.name) ||
    sections.find((s) => s.level === 1)?.heading ||
    guessNameFromSource(sourceName);

  const description =
    str(frontmatter.description) ||
    firstParagraph(sections.find((s) => s.level === 1)?.body || body);

  return {
    name,
    description: description.trim(),
    frontmatter,
    sections,
    raw,
    wordCount: raw.split(/\s+/).filter(Boolean).length,
    sourceName,
  };
}

function splitSections(body: string): SkillSection[] {
  const lines = body.split("\n");
  const sections: SkillSection[] = [];
  let cur: SkillSection | null = null;
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];

  const flush = () => {
    if (cur) {
      cur.body = cur.body.trim();
      sections.push(cur);
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] || "";
        codeBuf = [];
      } else {
        inCode = false;
        if (cur) cur.codeBlocks.push({ lang: codeLang, code: codeBuf.join("\n") });
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (h) {
      flush();
      cur = {
        heading: h[2].replace(/[#*_`]/g, "").trim(),
        level: h[1].length,
        body: "",
        bullets: [],
        numbered: [],
        codeBlocks: [],
      };
      continue;
    }
    if (!cur) {
      // content before the first heading — keep it in a synthetic intro section
      if (line.trim()) {
        cur = { heading: "", level: 0, body: "", bullets: [], numbered: [], codeBlocks: [] };
      } else continue;
    }
    cur.body += line + "\n";
    const bullet = line.match(/^\s*[-*•]\s+(.+)/);
    if (bullet) cur.bullets.push(cleanMd(bullet[1]));
    const num = line.match(/^\s*\d+[.、)]\s*(.+)/);
    if (num) cur.numbered.push(cleanMd(num[1]));
  }
  flush();
  return sections;
}

function cleanMd(s: string): string {
  return s.replace(/[*_`]/g, "").trim();
}

function firstParagraph(text: string): string {
  const p = text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .find((t) => t && !t.startsWith("#") && !t.startsWith("-") && !t.startsWith("```"));
  return p ? cleanMd(p).slice(0, 400) : "";
}

function guessNameFromSource(sourceName: string): string {
  const base = sourceName.replace(/\.(md|markdown)$/i, "");
  return base === "SKILL" ? "unnamed-skill" : base;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
