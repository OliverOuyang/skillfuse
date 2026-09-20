/**
 * 从一组「路径 → 内容」构建 SkillPackage（Web 上传与 CLI 共用）。
 * 负责：清洗无关文件、排序、定位 SKILL.md。
 */

import type { SkillPackage } from "./types";

const MAX_FILES = 300;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB — 文本类资源足够，二进制资产不读入内存

const isJunk = (path: string) =>
  path.includes("__MACOSX") || path.endsWith(".DS_Store") || path.includes("/.git/");

/**
 * 目录上传与带包装目录的 zip 会让每个路径都多一层根目录（如 production-data/SKILL.md），
 * 这层是打包方式带来的，不属于 skill 自身的结构——剥掉它，否则结构类检查全部误判。
 */
function stripWrapperDir(paths: { path: string; content: string }[]): { path: string; content: string }[] {
  const root = paths[0]?.path.split("/")[0];
  if (!root || !paths.every((f) => f.path.startsWith(`${root}/`))) return paths;
  return paths.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
}

export function buildSkillPackage(
  inputs: { path: string; content: string }[],
  sourceName: string,
): SkillPackage {
  const kept = inputs.filter((f) => f.path.trim() && !isJunk(f.path));
  const files = stripWrapperDir(kept)
    .slice(0, MAX_FILES)
    .map((f) => ({
      path: f.path.replace(/^\.\//, ""),
      content: f.content,
      size: f.content.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) throw new Error("没有读取到任何文件。");

  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
  if (!skillMd) throw new Error("包里没有找到 SKILL.md。");

  return { files, skillMd, sourceName };
}

/** 大文件不读入内容（二进制资产等），仅保留路径占位。 */
export function isReadableSize(size: number): boolean {
  return size <= MAX_FILE_SIZE;
}
