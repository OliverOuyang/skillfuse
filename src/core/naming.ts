/**
 * Skill 与包内文件的命名规范单一事实来源。
 *
 * 集中定义正则与修复建议，避免规则检查、界面提示和后续导出各自接受不同命名。
 */

/**
 * 团队命名前缀。
 *
 * 注意：这是一个有意为之的例外。#9 曾明确「命名前缀是各团队自己的约定，不写死在规则里」，
 * 本版按 LoopX 团队要求把前缀硬编码进规则，以便检查页能直接给出可执行的重命名建议。
 * 因此前缀只在这里出现一次——要支持其他团队时，把它改成配置项即可，不必翻遍规则表。
 */
export const ORG_PREFIX = "loopx";

export const SKILL_NAME_RE = new RegExp(`^${ORG_PREFIX}-[a-z0-9]+-[a-z0-9]+(-[a-z0-9]+)?$`);

export const FILE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+$/;

export const SCRIPT_SLUG_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+$/;

export const isScriptPath = (path: string): boolean => path.startsWith("scripts/");

/** 给不可移植路径生成可执行的重命名建议；中文无法可靠音译时保留人工占位提示。 */
export function suggestFileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const fileName = parts.pop() || "file.md";
  const firstDir = parts[0]?.toLowerCase();
  if (firstDir === "docs") parts[0] = "references";
  if (firstDir === "src" || firstDir === "source") parts[0] = "scripts";
  const separator = isScriptPath([...parts, fileName].join("/")) ? "_" : "-";

  const dot = fileName.lastIndexOf(".");
  const rawStem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = (dot > 0 ? fileName.slice(dot + 1) : "md").toLowerCase().replace(/[^a-z0-9]/g, "") || "md";
  // 中文无法在不引入音译依赖的前提下稳定转写，明确提示使用者人工补全领域词。
  const stem = /[\u3400-\u9fff]/u.test(rawStem)
    ? `loopx${separator}<topic>`
    : rawStem
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, separator)
        .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "") || `loopx${separator}<topic>`;

  return [...parts, `${stem}.${extension}`].join("/");
}

/** 批量建议必须保持路径唯一，避免 agent 按报告重命名时覆盖先处理的文件。 */
export function suggestFileNames(paths: string[]): string[] {
  const used = new Set<string>();
  return paths.map((path) => {
    const suggested = suggestFileName(path);
    if (!used.has(suggested)) {
      used.add(suggested);
      return suggested;
    }

    const dot = suggested.lastIndexOf(".");
    const stem = dot > 0 ? suggested.slice(0, dot) : suggested;
    const extension = dot > 0 ? suggested.slice(dot) : "";
    const separator = isScriptPath(suggested) ? "_" : "-";
    let index = 2;
    let unique = `${stem}${separator}${index}${extension}`;
    while (used.has(unique)) unique = `${stem}${separator}${++index}${extension}`;
    used.add(unique);
    return unique;
  });
}
