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

四步引导：**导入 Skill → 检查 Skill → 生成评测包 → 试运行**。

> 要在界面里真正调用模型，请用 `npm run dev`（或 `npm run preview`）在本机打开——
> 模型请求需要本机代理转发，纯静态托管的页面只能看界面、跑不了模型。

界面要点：

- **检查页**：规范得分环形图 + 六个维度分类卡片，每条问题都带「怎么修」的可执行建议，支持按严重级 / 分类 / 关键词筛选，并可一键导出 Markdown 检查报告。
- **检查页**：规范得分环形图 + 分类卡片（含**命名规范**与**报告类专项**）；每条问题都带「怎么修」。
- **生成页**：规则评分器可直接在界面上开关、调权重、改参数与关键词；接入模型后可以让它**通盘优化**当前评分器与数据集——不是简单追加，而是保留 / 修改 / 删除 / 新增，改完给出一份「改了什么、为什么」的清单。判分始终由本地确定性引擎执行。
- **试运行页**：接入模型后可以**直接让它按 skill 跑一条需求**，拿到输出后自动做规则评分 + LLM 评审（一个按钮走完三步）；也可以粘贴现成输出边打字边出分。输出区支持**代码 / 预览**切换，「生成结构骨架」按**当前这套规则**（含模型优化出来的定制规则）生成；报告可导出为 Markdown，含需求、规则明细、怎么改、评审四维度与被评输出。
- 深色模式、移动端步骤条、操作结果轻提示（Toast）。

### 命令行 CLI

```bash
npx tsx cli/skillfuse.ts ./SKILL.md --out ./out
# 也支持目录或 zip：
npx tsx cli/skillfuse.ts ./skills/customer-support
# --strict：存在 error 级规范问题时以非 0 退出，可直接接进 CI
```

CLI 与 Web 共用同一套引擎，除评测包外还会输出 `spec_report.md`（规范检查报告）。

### 以 Kimi for Coding 为例

先在终端自检一次，确认密钥与端点没问题：

```bash
SKILLFUSE_API_KEY=sk-... npm run check:model -- \
  --base https://api.kimi.com/coding/v1 --model kimi-for-coding
```

自检会逐项报告：端点可达性 → 鉴权与模型列表 → 对话请求 → 浏览器能否直连（CORS）→ JSON 跟随能力，
任何一项失败都给出具体的下一步（密钥问题 / 路径问题 / 被网络代理拦截 / 需要开本地代理，各有不同的处理办法）。

自检通过后：

1. `npm run dev` 打开 http://localhost:3000
2. 右上角模型状态 → 选「Kimi for Coding」（Base URL 自动填 `https://api.kimi.com/coding/v1`）
3. 填入 API key，模型名填 `kimi-for-coding`
4. 打开「本地代理转发」（该端点不给浏览器放行跨域），点「测试连接」应返回延迟与模型回声
5. 之后即可在生成页补充数据集条目、在试运行页跑 LLM 评审

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

**规则即数据**：`rule_checks.json` 同时被浏览器内运行器（试运行页即时执行）和
生成的 `rule_scorers.py` 以相同逻辑解释——你在网页里看到的分数，就是 Langfuse 会算出的分数。
两侧的加权长度实现已做过一致性校验（同一份输出、同一个分数）。

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
| `spec_report.md` | 规范检查报告（仅 CLI 输出） |

## 可选：接入你自己的模型

点右上角的模型状态按钮打开「模型接入」：

- **服务商预设**：OpenAI、DeepSeek、Kimi for Coding、Moonshot / Kimi、通义千问（DashScope）、智谱 GLM、硅基流动、OpenRouter、本地 Ollama / vLLM，以及任意自定义 OpenAI 兼容端点——选中即自动填好 Base URL 与常用模型名。
- **本地代理转发**：厂商端点基本都不给浏览器放行跨域（CORS），直连必然失败。打开这个开关后，请求由本机的 vite 开发服务器代发，密钥仍然只从你自己的机器发出、不经过第三方。仅 `npm run dev` / `npm run preview` 下可用；直连失败时界面会直接给出「开启本地代理并重试」。
- **测试连接**：发一条极小请求，同时验证 Base URL、密钥与模型名，返回延迟与模型回声。
- **从端点拉取模型列表**：支持 `/models` 的端点可直接点选，不支持的手填即可。
- **高级参数**：温度、最大输出 token、请求超时。

接入后可以：

- 通盘优化数据集（生成页）：改写只有触发词的模糊任务、删掉重复条目、补上缺失的边界与对抗场景
- 通盘优化评分器（生成页）：调权重、改关键词、删掉不适用的检查、补上这个 skill 专属的检查。
  模型只负责**设计**规则，判分仍由本地确定性引擎执行；规则类型被限制在引擎支持的集合内
  （关键词命中 / 违禁词 / 长度 / 结构），参数按类型白名单清洗，非法规则直接丢弃，
  模型没提到的旧规则一律保留，不会被悄悄删掉
- 直接用你的模型按 skill 跑一条需求，再对结果跑规则评分与 LLM 评审（试运行页）

请求失败时会按 鉴权 / 端点不存在 / 限流 / 超时 / 跨域 分类给出具体的下一步建议。
密钥只保存在你浏览器的 localStorage 中，不会发送到任何其他地方。

## 隐私

全部处理在本地完成（浏览器或 CLI）。只有当你显式配置了自己的模型端点时才会发出网络请求。

## 技术栈

React 19 + TypeScript + Vite + Tailwind CSS · js-yaml · JSZip · tsx（CLI）

## License

MIT
