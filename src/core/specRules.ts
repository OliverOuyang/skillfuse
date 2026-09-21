/**
 * 企业级 SKILL 规范规则注册表。
 *
 * 规则依据《标准企业级 SKILL 开发规范》整理，覆盖六个维度：
 *   structure    目录结构（SKILL.md / tests / references 等）
 *   frontmatter  frontmatter 字段（name / description / license / allowed-tools …）
 *   body         正文七段式（何时使用 / 工作流 / 失败回退 / 输出格式 / 示例 / 边界）
 *   io           输入输出规范（五要素②：JSON Schema / 字段定义）
 *   trace        trace 中间步骤 / 可观测性规范（skill.* spans、gen_ai.skill.* 属性）
 *   security     安全基线（AST 快速检查）
 *
 * 每条规则：check 返回 null 表示通过，返回字符串表示违规说明，
 * 返回对象可覆盖 severity（如按长度动态升级）。
 */

import type { IssueCategory, IssueSeverity, ParsedSkill, SkillPackage } from "./types";
import { FILE_SLUG_RE, ORG_PREFIX, SKILL_NAME_RE, suggestFileName } from "./naming";
import {
  CANONICAL_SPANS,
  TRACE_EXAMPLE_JSONL,
  TRACE_HELPER_PY,
  TRACE_SECTION_MD,
  TRACE_STEP_SCHEMA,
} from "./traceContract";

export interface RuleHit {
  message: string;
  severity?: IssueSeverity;
}

export interface SpecRule {
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  /** 规则短名，展示在报告里 */
  name: string;
  /** 违规时给出的可执行修复建议（展示在检查页的「怎么修」里） */
  fix: string;
  /** 可直接复制到 skill 包中的修复示例 */
  example?: { lang: string; code: string; filename?: string };
  /** 仅对部分 skill 生效的规则（如策略报告专项）；返回 false 时该规则不计入总数 */
  applies?(ctx: RuleContext): boolean;
  check(ctx: RuleContext): RuleHit | null;
}

export interface RuleContext {
  pkg: SkillPackage;
  parsed: ParsedSkill;
}

/* ---------- helpers ---------- */

const scripts = (ctx: RuleContext) => ctx.pkg.files.filter((f) => f.path.startsWith("scripts/"));

const bodyLineCount = (ctx: RuleContext) => {
  const m = ctx.pkg.skillMd.content.replace(/\r\n/g, "\n").match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  const body = m ? ctx.pkg.skillMd.content.slice(m[0].length) : ctx.pkg.skillMd.content;
  return body.split("\n").length;
};

/** 在解析出的章节中找匹配任一正则的章节 */
const findSection = (ctx: RuleContext, patterns: RegExp[]) =>
  ctx.parsed.sections.find((s) => patterns.some((re) => re.test(s.heading)));

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const KNOWN_TOP_LEVEL = new Set([
  "SKILL.md",
  "scripts",
  "references",
  "assets",
  "tests",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  ".gitignore",
  ".claude",
]);

/** 交付物是策略 / 分析报告的 skill——这类 skill 的检查重点不是格式，而是结论能不能被追溯。 */
export function isReportSkill(ctx: RuleContext): boolean {
  const desc = `${ctx.parsed.description} ${ctx.parsed.frontmatter.name ?? ""}`;
  const headings = ctx.parsed.sections.map((s) => s.heading).join(" ");
  return /报告|策略|分析|洞察|复盘|诊断|建议|report|analysis|insight|strategy|recommendation/i.test(
    `${desc} ${headings}`,
  );
}

/** 正文里是否出现某类语义（用于报告专项的「有没有写清楚」类检查）。 */
const bodyHas = (ctx: RuleContext, re: RegExp) => re.test(ctx.pkg.skillMd.content);

/** 文件名（不含目录）。 */
const baseName = (p: string) => p.split("/").pop() ?? p;

const JSON_SCHEMA_HINT = /"properties"\s*:|"type"\s*:\s*"object"|json schema/i;

const allCodeBlocks = (ctx: RuleContext) => ctx.parsed.sections.flatMap((section) => section.codeBlocks);

const parseTraceLines = (content: string) =>
  content
    .split(/\r?\n/)
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line.trim());
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        return typeof record.step === "string" && typeof record.status === "string" ? record : null;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== null);

const extractStepNames = (ctx: RuleContext): string[] => {
  const text = [ctx.pkg.skillMd.content, ...scripts(ctx).map((file) => file.content)].join("\n");
  const names = new Set<string>();
  for (const match of text.matchAll(/["']step["']\s*:\s*["']([^"']+)["']/g)) names.add(match[1]);
  for (const match of text.matchAll(/emit_step\s*\(\s*["']([^"']+)["']/g)) names.add(match[1]);
  return [...names];
};

/* ---------- rules ---------- */

export const SPEC_RULES: SpecRule[] = [
  /* ===== structure ===== */
  {
    id: "structure.name-dir-match",
    category: "structure",
    severity: "warning",
    name: "name 与目录名一致",
    fix:
      "把 frontmatter 的 name 改成与包根目录同名，或重命名目录：两者一致后工具链才能按 name 定位 skill 资源。",
    check(ctx) {
      const root = ctx.pkg.sourceName.replace(/\.(zip|md|markdown)$/i, "").split("/")[0];
      if (!root || root === "SKILL" || root.startsWith("粘贴的") || root.startsWith("内置示例")) return null;
      if (root !== ctx.parsed.name) {
        return { message: `frontmatter name「${ctx.parsed.name}」与包根目录名「${root}」不一致，规范要求两者相同。` };
      }
      return null;
    },
  },
  {
    id: "structure.body-too-long",
    category: "structure",
    severity: "warning",
    name: "正文行数 ≤ 500",
    fix:
      "把「参考资料 / 长示例 / 详细表格」搬到 references/ 下，正文只保留触发条件、工作流与输出格式，按需在正文里指向 references/xxx.md。",
    check(ctx) {
      const n = bodyLineCount(ctx);
      if (n > 500) {
        return { message: `SKILL.md 正文约 ${n} 行，超过 500 行。建议把详细内容拆到 references/ 按需加载。` };
      }
      return null;
    },
  },
  {
    id: "structure.unknown-top-level",
    category: "structure",
    severity: "info",
    name: "顶层文件/目录职责清晰",
    fix:
      "把这些文件归入 scripts/（可执行）、references/（按需加载的文档）、assets/（模板与静态资源）或 tests/（评测）；明确把 docs/ 改到 references/、src/ 改到 scripts/，顶层只保留规范定义的项。",
    check(ctx) {
      if (ctx.pkg.files.length <= 1) return null;
      const unknown = [
        ...new Set(
          ctx.pkg.files
            .map((f) => f.path.split("/")[0])
            .filter((seg) => !KNOWN_TOP_LEVEL.has(seg)),
        ),
      ];
      if (unknown.length > 0) {
        return { message: `顶层存在规范未定义的项：${unknown.join("、")}。规范目录结构为 SKILL.md / scripts/ / references/ / assets/ / tests/` };
      }
      return null;
    },
  },

  /* ===== naming ===== */
  {
    id: "naming.skill-org-prefix",
    category: "naming",
    severity: "warning",
    name: "skill 名以 loopx- 开头",
    fix: "把 frontmatter name 改为 loopx-<领域>-<动作>，例如 loopx-eval-runner。",
    check(ctx) {
      const name = str(ctx.parsed.frontmatter.name);
      if (name && !name.startsWith(`${ORG_PREFIX}-`)) {
        return { message: `frontmatter name「${name}」未以 loopx- 开头，建议改为 loopx-<领域>-<动作>。` };
      }
      return null;
    },
  },
  {
    id: "naming.skill-kebab-case",
    category: "naming",
    severity: "warning",
    name: "skill 名用 kebab-case",
    fix:
      "把 name 改成全小写、用连字符分词的短名，例如 production-data、weekly-report-writer；不要用下划线、驼峰、空格或中文。",
    check(ctx) {
      const name = ctx.parsed.name;
      if (!name) return null;
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return { message: `name「${name}」不符合 kebab-case（全小写 + 连字符）。` };
      }
      return null;
    },
  },
  {
    id: "naming.skill-name-shape",
    category: "naming",
    severity: "info",
    name: "skill 名是「领域-动作」短名",
    fix:
      "使用 loopx-<领域>-<动作>（最多四段），如 loopx-eval-runner、loopx-risk-report；避免 my、test、demo、helper、tool、util、skill 等无信息量词。",
    check(ctx) {
      const name = ctx.parsed.name;
      if (!name) return null;
      const words = name.split("-").filter(Boolean);
      // 泛化词表沿用上游 #9（含 temp/new/utils）；段数与长度由 SKILL_NAME_RE 更严格地兜住
      if (words.some((word) => /^(my|test|demo|temp|new|helper|tool|util|utils|skill)$/.test(word))) {
        return { message: `name「${name}」包含占位或泛化词（my/test/demo/helper/tool/util/skill），表达不了具体职责。` };
      }
      if (!SKILL_NAME_RE.test(name)) {
        return { message: `name「${name}」不符合 loopx-<领域>-<动作>：必须为三段、最多四段的小写字母数字短名。正例：loopx-eval-runner、loopx-risk-report。` };
      }
      return null;
    },
  },
  {
    id: "naming.dir-name-match",
    category: "naming",
    severity: "warning",
    name: "目录名与 name 一致",
    fix:
      "让 skill 目录名、SKILL.md frontmatter 的 name、以及你团队注册表里的登记名三处完全一致——跨 skill 引用与注册表查找都按这个名字走，不一致就会指错。",
    check(ctx) {
      const name = ctx.parsed.name;
      // 单文件 / 粘贴导入没有目录名可比；sourceName 带扩展名的同样不是目录
      const dir = ctx.pkg.sourceName;
      if (!name || ctx.pkg.files.length <= 1 || !dir || /\.(md|zip)$/i.test(dir)) return null;
      if (dir !== name) {
        return { message: `目录名「${dir}」与 frontmatter 的 name「${name}」不一致。` };
      }
      // 目录名同时要满足 LoopX 命名：注册表按这个名字查，命名不规范会让检索失准
      if (!SKILL_NAME_RE.test(dir)) {
        return { message: `目录名「${dir}」不符合 loopx-<领域>-<动作>（最多四段）。` };
      }
      return null;
    },
  },
  {
    id: "naming.file-portable",
    category: "naming",
    severity: "warning",
    name: "文件名可移植",
    fix:
      "普通文件名只用小写字母、数字和连字符并保留单个扩展名；脚本继续使用 snake_case。重命名后同步更新正文中的引用路径。",
    check(ctx) {
      if (ctx.pkg.files.length <= 1) return null;
      const canonical = new Set(["SKILL.md", "README.md", "LICENSE", "CHANGELOG.md", ".gitignore"]);
      const bad = ctx.pkg.files
        .map((f) => f.path)
        .filter((p) => {
          const name = baseName(p);
          if (canonical.has(name)) return false;
          if (p.startsWith("scripts/") && /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+$/.test(name)) return false;
          return !FILE_SLUG_RE.test(name);
        });
      if (bad.length > 0) {
        const suggestions = bad.slice(0, 5).map((path) => `${path} → ${suggestFileName(path)}`);
        return { message: `文件名不符合可移植规范：${suggestions.join("；")}${bad.length > 5 ? `；等 ${bad.length} 个` : ""}。` };
      }
      return null;
    },
  },
  {
    id: "naming.script-snake-case",
    category: "naming",
    severity: "info",
    name: "脚本名用 snake_case",
    fix: "scripts/ 下的可执行脚本统一用 snake_case（如 fetch_orders.py），与 Python / shell 生态惯例一致。",
    check(ctx) {
      const bad = scripts(ctx)
        .map((f) => baseName(f.path))
        .filter((n) => /\.(py|sh)$/.test(n) && !/^[a-z0-9]+(_[a-z0-9]+)*\.(py|sh)$/.test(n));
      if (bad.length > 0) return { message: `scripts/ 下这些脚本不是 snake_case：${bad.join("、")}。` };
      return null;
    },
  },
  {
    id: "naming.no-version-in-filename",
    category: "naming",
    severity: "info",
    name: "文件名不带版本 / 状态后缀",
    fix:
      "把 v2、final、new、copy、备份 这类后缀从文件名里去掉——版本交给 git 与 CHANGELOG.md，文件名只表达职责。",
    check(ctx) {
      if (ctx.pkg.files.length <= 1) return null;
      const bad = ctx.pkg.files
        .map((f) => baseName(f.path))
        .filter((n) => /([_\-.]|^)(v\d+(\.\d+)*|final|new|old|copy|bak|backup|测试|备份|最终|副本)([_\-.]|$)/i.test(n.replace(/\.[a-z0-9]+$/i, "")));
      if (bad.length > 0) return { message: `以下文件名带版本或状态后缀：${bad.slice(0, 5).join("、")}。` };
      return null;
    },
  },

  /* ===== 策略 / 分析报告类 skill 专项 ===== */
  {
    id: "report.conclusion-first",
    category: "report",
    severity: "warning",
    name: "结论先行",
    applies: isReportSkill,
    fix:
      "在输出格式章节里写死第一段是结论：先给判断与量级，再给论据。否则模型会先铺陈过程，读者要翻到最后才知道结论。",
    check(ctx) {
      if (bodyHas(ctx, /结论先行|先给结论|摘要|executive summary|tl;?dr|关键结论|核心结论/i)) return null;
      return { message: "没有要求「结论先行」。报告类 skill 应在输出格式里规定开头就是结论 / 摘要。" };
    },
  },
  {
    id: "report.evidence-required",
    category: "report",
    severity: "error",
    name: "结论必须带数据出处",
    applies: isReportSkill,
    fix:
      "写明每个结论要附数据来源（表名 / 查询 / 口径 / 时间范围），并规定「拿不到数据时写明缺口，不得估算」——这是报告类 skill 最容易出幻觉的地方。",
    check(ctx) {
      if (bodyHas(ctx, /数据来源|出处|口径|引用|依据|来源标注|source|provenance|不得编造|不要编造|禁止臆测|不得臆造/i)) return null;
      return { message: "没有要求结论标注数据来源或口径，模型可以自由编造数字而不被发现。" };
    },
  },
  {
    id: "report.time-window",
    category: "report",
    severity: "warning",
    name: "时间范围与口径写清楚",
    applies: isReportSkill,
    fix: "规定报告必须声明统计时间范围与指标口径（同比 / 环比 / 分区 / 去重规则），否则同一句结论换个时间窗就不成立。",
    check(ctx) {
      if (bodyHas(ctx, /时间范围|统计周期|时间窗|同比|环比|bizdate|分区|截止日期|date range/i)) return null;
      return { message: "没有要求声明统计时间范围 / 指标口径。" };
    },
  },
  {
    id: "report.actionable-recommendation",
    category: "report",
    severity: "warning",
    name: "给出可执行建议",
    applies: isReportSkill,
    fix:
      "在输出结构里加一节「建议 / 下一步」，并要求每条建议可执行（谁做、做什么、预期影响），避免「建议持续关注」这类空话。",
    check(ctx) {
      if (bodyHas(ctx, /建议|下一步|行动项|action item|recommendation|next step|落地动作/i)) return null;
      return { message: "输出结构里没有「建议 / 下一步」，报告只描述现象不给动作。" };
    },
  },
  {
    id: "report.uncertainty-disclosure",
    category: "report",
    severity: "info",
    name: "标注不确定性与局限",
    applies: isReportSkill,
    fix:
      "要求写明样本量不足、口径变更、数据延迟等局限，并在结论里区分「已验证」和「假设」——评审时这一条最能区分专业报告和话术。",
    check(ctx) {
      if (bodyHas(ctx, /局限|不确定|假设|置信|样本量|数据延迟|caveat|limitation|assumption/i)) return null;
      return { message: "没有要求标注不确定性 / 局限 / 假设。" };
    },
  },
  {
    id: "report.audience-declared",
    category: "report",
    severity: "info",
    name: "声明读者与决策场景",
    applies: isReportSkill,
    fix: "在「何时使用」里写清报告给谁看（业务负责人 / 一线运营 / 管理层）以及要支撑什么决策，篇幅与措辞才有判断依据。",
    check(ctx) {
      if (bodyHas(ctx, /读者|受众|面向|汇报对象|管理层|决策者|audience|stakeholder/i)) return null;
      return { message: "没有声明报告读者与决策场景。" };
    },
  },

  /* ===== frontmatter ===== */
  {
    id: "fm.name-required",
    category: "frontmatter",
    severity: "error",
    name: "name 必填",
    fix:
      "在 SKILL.md 顶部补上 frontmatter：--- 换行 name: your-skill-name 换行 ---；注意用小写连字符命名并确保 YAML 合法。",
    check(ctx) {
      if (!str(ctx.parsed.frontmatter.name)) {
        return { message: "frontmatter 缺少 name 字段（必填），或 YAML 解析失败。" };
      }
      return null;
    },
  },
  {
    id: "fm.name-format",
    category: "frontmatter",
    severity: "error",
    name: "name 长度与格式",
    fix:
      "把 name 压缩到 64 字符以内，使用 kebab-case（小写字母、数字与中间连字符），首尾不要带连字符。",
    check(ctx) {
      const name = str(ctx.parsed.frontmatter.name);
      if (!name) return null;
      if (name.length > 64) return { message: `name 为 ${name.length} 字符，超过 64 字符上限。` };
      if (/^-|-$/.test(name)) return { message: "name 不能以连字符开头或结尾。" };
      return null;
    },
  },
  {
    id: "fm.desc-required",
    category: "frontmatter",
    severity: "error",
    name: "description 必填",
    fix:
      "补上 description：一句祈使句写明「什么场景下用这个 skill」，并带上典型触发词——它决定了模型是否会在对的时候调用你。",
    check(ctx) {
      if (!str(ctx.parsed.frontmatter.description)) {
        return { message: "frontmatter 缺少 description 字段（必填）。description 承担全部触发责任，缺失会显著影响触发准确度。" };
      }
      return null;
    },
  },
  {
    id: "fm.desc-length",
    category: "frontmatter",
    severity: "warning",
    name: "description 长度",
    fix:
      "精简 description：保留触发场景与关键词，把背景说明、限制条件挪到正文的「何时使用 / 边界」段落。",
    check(ctx) {
      const desc = str(ctx.parsed.frontmatter.description);
      if (!desc) return null;
      if (desc.length > 1536) {
        return { message: `description 为 ${desc.length} 字符，超过 1536 字符上限，请精简。`, severity: "error" };
      }
      if (desc.length > 1024) {
        return { message: `description 为 ${desc.length} 字符，超过开放标准 1024 字符（Claude Code 扩展上限 1536），建议精简。` };
      }
      return null;
    },
  },
  {
    id: "fm.license-spdx",
    category: "frontmatter",
    severity: "warning",
    name: "license 使用 SPDX 标识",
    fix:
      "改用标准 SPDX 标识，例如 MIT、Apache-2.0、BSD-3-Clause；专有代码可写 LicenseRef-Internal。",
    check(ctx) {
      const license = str(ctx.parsed.frontmatter.license);
      if (!license) return null;
      if (!/^[A-Za-z0-9][A-Za-z0-9-.+]*$/.test(license)) {
        return { message: `license「${license}」不像有效的 SPDX 标识（如 MIT、Apache-2.0）。` };
      }
      return null;
    },
  },
  {
    id: "fm.compatibility-length",
    category: "frontmatter",
    severity: "warning",
    name: "compatibility ≤ 500 字符",
    fix:
      "compatibility 只写运行环境硬约束（版本、平台、依赖），详细说明搬到 references/ 或正文。",
    check(ctx) {
      const c = str(ctx.parsed.frontmatter.compatibility);
      if (c && c.length > 500) return { message: `compatibility 为 ${c.length} 字符，超过 500 字符上限。` };
      return null;
    },
  },
  {
    id: "fm.allowed-tools",
    category: "frontmatter",
    severity: "warning",
    name: "allowed-tools 工具白名单（企业内规必填）",
    fix:
      "在 frontmatter 增加 allowed-tools 列表，逐个列出本 skill 真正需要的工具（如 Read、Bash(python3:*)），遵循最小权限。",
    check(ctx) {
      const at = ctx.parsed.frontmatter["allowed-tools"];
      const missing = at === undefined || at === null || (Array.isArray(at) && at.length === 0) || at === "";
      if (missing) {
        return { message: "缺少 allowed-tools 工具白名单。企业内规要求显式声明本 Skill 可调用的工具，以收紧权限面（AST03 过度权限）。" };
      }
      return null;
    },
  },
  {
    id: "fm.metadata-version",
    category: "frontmatter",
    severity: "info",
    name: "metadata 含版本与责任人",
    fix:
      "在 metadata 下补 version（建议语义化版本）与 owner/负责人，方便灰度发布与问题追溯。",
    check(ctx) {
      const meta = ctx.parsed.frontmatter.metadata;
      if (!meta || typeof meta !== "object") return null;
      if (!("version" in (meta as Record<string, unknown>))) {
        return { message: "metadata 中建议包含 version 字段，用于发布与灰度追溯。" };
      }
      return null;
    },
  },

  /* ===== body（七段式） ===== */
  {
    id: "body.when-to-use",
    category: "body",
    severity: "warning",
    name: "「何时使用」段落",
    fix:
      "新增「## 何时使用」段落，用 3-5 条要点写清触发场景，与 description 里的触发词一一呼应。",
    check(ctx) {
      if (!findSection(ctx, [/何时使用/, /when to use/i, /适用范围/, /使用场景/])) {
        return { message: "缺少「何时使用」段落，无法与 description 形成「广告 → 正文」呼应。" };
      }
      return null;
    },
  },
  {
    id: "body.workflow",
    category: "body",
    severity: "warning",
    name: "「工作流」段落",
    fix:
      "新增「## 工作流」段落，用有序列表写出每一步的动作、输入与产出，步骤之间不要跳跃。",
    check(ctx) {
      if (!findSection(ctx, [/工作流/, /workflow/i, /步骤/, /steps/i])) {
        return { message: "缺少「工作流」段落。规范建议分步骤编号，每步标号。" };
      }
      return null;
    },
  },
  {
    id: "body.failure-fallback",
    category: "body",
    severity: "warning",
    name: "「失败回退」段落（安全关键）",
    fix:
      "新增「## 失败回退」段落：逐条写明「出现什么异常 → 停在哪个已知状态 → 如何提示用户」，避免模型在异常时自由发挥。",
    check(ctx) {
      if (!findSection(ctx, [/失败回退/, /fallback/i, /failure/i, /错误处理/, /异常/, /出错/])) {
        return { message: "缺少「失败回退」段落。这是五要素中最常被省略且安全关键的一项：异常时应停在「已知状态」而非未定义继续。" };
      }
      return null;
    },
  },
  {
    id: "body.examples",
    category: "body",
    severity: "info",
    name: "「示例」段落",
    fix:
      "新增「## 示例」段落，给 1-3 个真实调用：用户输入 + 期望输出片段，示例越具体触发越稳。",
    check(ctx) {
      if (!findSection(ctx, [/示例/, /example/i, /样例/])) {
        return { message: "缺少「示例」段落。规范建议提供 1-3 个典型调用示例。" };
      }
      return null;
    },
  },
  {
    id: "body.when-not-to-use",
    category: "body",
    severity: "warning",
    name: "「何时不用 / 边界」段落",
    fix:
      "新增「## 何时不用」段落，列出相邻但不该触发的场景（以及该改用哪个 skill），可显著降低误触发。",
    check(ctx) {
      if (!findSection(ctx, [/何时不用/, /when not/i, /边界/, /不适用/])) {
        return { message: "缺少「何时不用 / 边界」段落。写清何时不用可显著降低误触发。" };
      }
      return null;
    },
  },
  {
    id: "body.desc-imperative",
    category: "body",
    severity: "info",
    name: "description 用祈使句",
    fix:
      "把 description 改写成以场景开头的祈使句，例如「当用户需要把周报整理成结构化摘要时使用……」。",
    check(ctx) {
      const desc = str(ctx.parsed.frontmatter.description);
      if (/^(本技能|本 skill|this skill|这是一个)/i.test(desc)) {
        return { message: "description 以「本技能用于…」开头。规范建议用祈使句（如「当用户提到…时使用本技能」），聚焦用户意图。" };
      }
      return null;
    },
  },

  /* ===== io（输入输出规范，五要素②） ===== */
  {
    id: "io.input-spec",
    category: "io",
    severity: "warning",
    name: "输入定义",
    fix:
      "新增「## 输入与校验」段落，或给出输入 JSON Schema：逐字段写明名称、类型、是否必填与校验规则。",
    check(ctx) {
      const sec = findSection(ctx, [/输入/, /input/i]);
      const hasSchema = ctx.parsed.sections.some((s) =>
        s.codeBlocks.some((b) => JSON_SCHEMA_HINT.test(b.code)),
      );
      if (!sec && !hasSchema) {
        return { message: "未找到输入定义（「输入与校验」段落或输入 JSON Schema）。五要素要求输入输出显式定义。" };
      }
      return null;
    },
  },
  {
    id: "io.output-spec",
    category: "io",
    severity: "warning",
    name: "输出格式定义",
    fix:
      "在「## 输出格式」里给出字段级定义——要点列表、表格或 JSON Schema 任选其一，让输出可被机器校验。",
    check(ctx) {
      const sec = findSection(ctx, [/输出格式/, /输出/, /output/i]);
      if (!sec) {
        return { message: "缺少「输出格式」段落。规范要求显式声明输出结构。" };
      }
      if (sec.bullets.length === 0 && sec.codeBlocks.length === 0 && !/[:：|]/.test(sec.body)) {
        return { message: "「输出格式」段落较空，建议给出字段级定义（要点列表、表格或 JSON Schema）。" };
      }
      return null;
    },
  },
  {
    id: "io.script-io-schema",
    category: "io",
    severity: "info",
    name: "scripts/ 输入输出契约",
    fix:
      "在每个脚本头部用 docstring 或 argparse 写清入参与出参；建议输出 JSON，便于被上游 skill 消费。",
    check(ctx) {
      const sc = scripts(ctx);
      if (sc.length === 0) return null;
      const undocumented = sc.filter(
        (f) => !/输入|输出|input|output|argparse|参数|schema/i.test(f.content),
      );
      if (undocumented.length === sc.length) {
        return { message: `scripts/ 下 ${sc.length} 个脚本都未见输入输出说明。规范要求脚本 IO 有 JSON Schema 或等效契约定义。` };
      }
      return null;
    },
  },

  /* ===== trace（中间步骤 / 可观测性） ===== */
  {
    id: "trace.contract-file",
    category: "trace",
    severity: "warning",
    name: "trace 契约文件",
    fix: "新增 references/trace-schema.json，或在 SKILL.md 的 JSON Schema 代码块中同时定义 step 与 status 属性。",
    example: { lang: "json", code: TRACE_STEP_SCHEMA, filename: "references/trace-schema.json" },
    check(ctx) {
      const hasFile = ctx.pkg.files.some((file) => /(^|\/)references\/trace-schema\.json$/i.test(file.path));
      const hasInlineSchema = allCodeBlocks(ctx).some(
        (block) =>
          /^(json|jsonschema|schema)$/i.test(block.lang) &&
          /"properties"\s*:/.test(block.code) &&
          /"step"\s*:/.test(block.code) &&
          /"status"\s*:/.test(block.code),
      );
      return hasFile || hasInlineSchema
        ? null
        : { message: "未找到 references/trace-schema.json，也未在 SKILL.md 中找到同时定义 step 与 status 的 JSON Schema 代码块。" };
    },
  },
  {
    id: "trace.example-present",
    category: "trace",
    severity: "warning",
    name: "trace 示例轨迹",
    fix: "新增 references/trace-example.jsonl，至少记录 3 个含 step 与 status 的步骤，并覆盖 fail 或 skip 路径。",
    example: { lang: "json", code: TRACE_EXAMPLE_JSONL, filename: "references/trace-example.jsonl" },
    check(ctx) {
      const files = ctx.pkg.files.filter((file) => /(^|\/)references\/trace-example\.jsonl$/i.test(file.path));
      const blocks = allCodeBlocks(ctx).filter((block) => /^(jsonl|json)$/i.test(block.lang));
      const candidates = [...files.map((file) => file.content), ...blocks.map((block) => block.code)];
      if (candidates.length === 0) {
        return { message: "完全没有 trace 示例；需要提供 JSONL 文件或 SKILL.md 中的 jsonl/json 代码块。" };
      }
      const records = candidates.flatMap(parseTraceLines);
      if (records.length >= 3 && records.some((record) => record.status !== "ok")) return null;
      if (records.length >= 3) {
        return { message: "trace 示例里只有成功路径；至少补一条 status 为 fail 或 skip 的失败/回退记录。" };
      }
      return { message: `trace 示例不完整：只有 ${records.length} 行可解析且含 step、status，至少需要 3 行。` };
    },
  },
  {
    id: "trace.span-declared",
    category: "trace",
    severity: "info",
    name: "trace 中间步骤声明",
    fix:
      "在正文里声明埋点约定：skill.activate / skill.load / skill.run_script / tool.execute / guardrail.check / human.review，并注明 gen_ai.skill.* 属性。",
    example: { lang: "markdown", code: TRACE_SECTION_MD, filename: "SKILL.md" },
    check(ctx) {
      const allText = [ctx.pkg.skillMd.content, ...ctx.pkg.files.map((file) => file.content)].join("\n");
      const declared = CANONICAL_SPANS.filter((span) => allText.includes(span));
      const missing = CANONICAL_SPANS.filter((span) => !declared.includes(span));
      return declared.length >= 3
        ? null
        : { message: `只声明了 ${declared.length} 个标准 span，至少需要 3 个；缺失：${missing.join("、")}。` };
    },
  },
  {
    id: "trace.structured-steps",
    category: "trace",
    severity: "warning",
    name: "脚本输出结构化步骤",
    fix:
      "让脚本每完成一步就打印一行 JSON（含 step、status、耗时等字段），trace 回放与失败归因会容易得多。",
    example: { lang: "python", code: TRACE_HELPER_PY, filename: "scripts/trace_emit.py" },
    // 没有 scripts/ 的纯提示词 skill 无步骤可埋点，不参评（既不误报也不虚高得分）
    applies: (ctx) => scripts(ctx).length > 0,
    check(ctx) {
      const sc = scripts(ctx);
      const structured = sc.some(
        (file) =>
          /emit_step\s*\(/.test(file.content) ||
          /(?:json\.dumps|print\s*\(\s*json|console\.log\s*\(\s*JSON)[\s\S]{0,300}["']step["']/.test(file.content),
      );
      if (!structured) {
        return { message: "scripts/ 脚本未见结构化（JSON）步骤输出。建议每步输出带 step 字段的 JSON，便于 trace 回放与失败归因。" };
      }
      return null;
    },
  },
  {
    id: "trace.steps-consistent",
    category: "trace",
    severity: "info",
    name: "step 名与契约一致",
    fix: "把脚本与 SKILL.md 中的 step 名改为 trace 契约定义的标准 span。",
    check(ctx) {
      const names = extractStepNames(ctx);
      if (names.length === 0) return null;
      const unknown = names.filter((name) => !CANONICAL_SPANS.includes(name));
      return unknown.length > 0 ? { message: `发现契约外的 step 名：${unknown.join("、")}。` } : null;
    },
  },

  /* ===== security（AST 快速检查） ===== */
  {
    id: "sec.suspicious-instruction",
    category: "security",
    severity: "error",
    name: "可疑注入指令（AST01/AST04）",
    fix:
      "删除 frontmatter 中「忽略以上指令」这类语句。frontmatter 会被直接注入上下文，这类内容属于提示注入（AST01/AST04）。",
    check(ctx) {
      const haystacks: string[] = [];
      for (const [k, v] of Object.entries(ctx.parsed.frontmatter)) {
        if (typeof v === "string") haystacks.push(`${k}: ${v}`);
      }
      const re = /ignore (all |any |the )?previous instructions|disregard (all |any |the )?previous|忽略(了)?(以上|此前|之前|上述)(的)?(所有|任何)?(指令|指示)|无视(以上|此前|之前)(的)?(指令|指示)/i;
      const hit = haystacks.find((h) => re.test(h));
      if (hit) {
        return { message: `frontmatter 中发现可疑注入指令（${hit.slice(0, 60)}…），存在 AST01/AST04 风险。` };
      }
      return null;
    },
  },
  {
    id: "sec.external-url",
    category: "security",
    severity: "warning",
    name: "外部 URL 引用（AST04）",
    fix:
      "确认每个外部链接的来源可信；把需要长期引用的内容固化到 references/ 下，避免运行时抓取外部页面。",
    check(ctx) {
      const urls = ctx.pkg.skillMd.content.match(/https?:\/\/[^\s)"'）」]+/g) || [];
      const external = urls.filter((u) => !/^(https?:\/\/)(localhost|127\.)/.test(u));
      if (external.length > 0) {
        const sample = [...new Set(external.map((u) => u.replace(/\/$/, "")))].slice(0, 3).join("、");
        return { message: `正文引用 ${external.length} 处外部 URL（如 ${sample}）。运行时抓取外部内容属于 AST04/AST05 攻击面，请确认来源可信。` };
      }
      return null;
    },
  },
  {
    id: "sec.exec-without-allowlist",
    category: "security",
    severity: "warning",
    name: "执行命令需配工具白名单（AST03）",
    fix:
      "既然要执行命令，就在 frontmatter 用 allowed-tools 精确限定可执行范围（例如 Bash(python3 scripts/*.py)），而不是放开全部工具。",
    check(ctx) {
      const at = ctx.parsed.frontmatter["allowed-tools"];
      const hasAllowlist = at !== undefined && at !== null && at !== "" && (!Array.isArray(at) || at.length > 0);
      if (hasAllowlist) return null;
      if (/bash|shell|终端|执行命令|run (the )?script|command line/i.test(ctx.pkg.skillMd.content)) {
        return { message: "Skill 提到执行命令/脚本，但未配置 allowed-tools 白名单，存在过度权限风险（AST03）。" };
      }
      return null;
    },
  },
];
