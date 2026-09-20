# SkillFuse

把一个 `SKILL.md` 变成 Langfuse 可用的评测包：**数据集（schema + 条目）**、**确定性规则评分器**、**LLM-as-judge 评审器**、**Langfuse 接入配置**。

本地运行，规则引擎为主（零依赖、开箱即用）；可选接入任意 OpenAI 兼容端点（包括你自己的模型）来增强数据集条目、运行 LLM 评审。

## 为什么

手写一个 skill 很容易，衡量它的表现很难。SkillFuse 从 skill 文件中自动提取结构信息（输出格式、输入类型、硬约束、质量标准、工作流、触发词、示例），生成一套可直接导入 Langfuse 的评测资产，让「这个 skill 到底好不好」变成可量化、可回归的事情。

## 快速开始

### Web 界面

```bash
npm install
npm run dev    # http://localhost:3000
```

四步引导：**导入 Skill → 检查解析 → 生成 → 测试**。

### 命令行 CLI

```bash
npx tsx cli/skillfuse.ts ./SKILL.md --out ./out
# 也支持目录或 zip：
npx tsx cli/skillfuse.ts ./skills/customer-support
```

### 接入 Langfuse

```bash
cd out
pip install langfuse openai python-dotenv
cp .env.example .env      # 填入 LANGFUSE_PUBLIC_KEY / SECRET_KEY
python langfuse_config.py # 一键创建数据集并上传条目
```

## 工作原理

```
SKILL.md ──► parseSkill    解析 frontmatter 与章节（js-yaml）
        ──► analyzeSkill   启发式提取：输出格式 / 输入类型 / 硬约束（必须·禁止）/
                            质量标准 / 工作流步骤 / 触发词 / 示例代码块
        ──► generate       组装评测包：
                            · 数据集条目 = 常规路径（触发词）+ 示例参考 + 约束对抗
                            · 规则检查   = 通用规则 + 格式规则 + 硬约束规则 + 必备章节
                            · 评审提示词 = 质量标准 + 硬约束 → 评分细则（rubric）
```

**规则即数据**：`rule_checks.json` 同时被浏览器内运行器（Test 页即时试运行）和
生成的 `rule_scorers.py` 以相同逻辑解释——你在网页里看到的分数，就是 Langfuse 会算出的分数。

长度类规则对中文做了加权（CJK 字符信息密度约为拉丁字符两倍），中英文 skill 都适用。

## 生成的产物

| 文件 | 作用 |
| --- | --- |
| `dataset_schema.json` | 兼容 Langfuse 的数据集定义（schema + 元数据） |
| `dataset_items.json` | 数据集条目：常规路径、示例参考、约束对抗三类 |
| `rule_scorers.py` | 零依赖确定性评分器，含加权总分 |
| `rule_checks.json` | 同一套规则的数据形态，驱动浏览器内试运行 |
| `llm_judge_prompt.md` | 从 skill 质量标准提取的评审 rubric |
| `llm_judge.py` | 评审评分器，支持任意 OpenAI 兼容端点 |
| `langfuse_config.py` | 一键建数据集 + 评测运行骨架 |
| `.env.example` | 环境变量模板 |

## 可选：接入你自己的模型

Web 界面右上角「模型设置」填入 `Base URL` + `API key` + 模型名（任意 OpenAI 兼容端点），即可：

- 让你的模型补充更多数据集条目（Generate 页）
- 在浏览器里直接运行 LLM 评审（Test 页）

密钥只保存在你浏览器的 localStorage 中，不会发送到任何其他地方。

## 隐私

全部处理在本地完成（浏览器或 CLI）。只有当你显式配置了自己的模型端点时才会发出网络请求。

## 技术栈

React 19 + TypeScript + Vite + Tailwind CSS · js-yaml · JSZip · tsx（CLI）

## License

MIT
