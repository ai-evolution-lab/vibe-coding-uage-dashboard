# Vibe Coding Usage Dashboard

一个在本机运行的 AI 编程使用统计看板。

它会读取你电脑上的 Codex 和 Claude Code 本地记录，帮你看清楚：

- 今天、最近 7 天、最近 30 天用了多少 tokens
- 哪些项目最消耗 tokens
- 哪些模型用得最多
- 工具调用频率如何
- 单个会话的时间、模型、项目和用量明细
- 按 LiteLLM / models.dev 公开价格估算的费用（支持一键更新）
- 数据质量检查：去重、字段一致性、价格覆盖

项目地址：<https://github.com/ai-evolution-lab/vibe-coding-uage-dashboard.git>

## 隐私说明

这个工具只在本机运行。

- 不上传 `.codex` 或 `.claude` 数据
- 唯一的外部请求是下载公开价格表（LiteLLM、models.dev），只下载、不上传任何内容；可在“价格表”里关闭每天自动更新，离线时使用内置快照
- 不内置你的聊天记录
- 自动识别目录时只使用本地 `localhost` 只读服务
- 导出的 CSV / JSON 文件只保存在你的电脑上

费用、TPM、RPM 都是本地估算值，不是官方账单。

## 支持的数据来源

### Codex

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl.zst`（Codex 压缩的旧会话，在本地解压）

### Claude Code

- `~/.claude/projects/**/*.jsonl`（含 `subagents/` 子代理记录）

## 快速启动

### Mac

双击：

```bash
open.command
```

### Windows

双击：

```bat
open.bat
```

### 命令行启动

```bash
npm install
npm run start:local
```

`npm run start:local` 会同时启动前端页面和本地只读识别服务，推荐日常使用。

如果只想启动前端开发服务器：

```bash
npm run dev
```

这种方式不带自动识别服务，需要手动选择目录。

## 从 GitHub 安装

```bash
git clone https://github.com/ai-evolution-lab/vibe-coding-uage-dashboard.git
cd vibe-coding-uage-dashboard
npm install
npm run start:local
```

## 怎么使用

1. 启动项目。打开页面后会自动读取最新数据（先显示上次缓存，再在后台刷新）。
2. 在页面左上角切换 `Codex` 或 `Claude Code`；右上角“设置”里可以选默认进入哪个、默认时间范围，以及是否自动读取。
3. 需要立即重新读取时点“刷新数据”。
4. 不是用启动脚本打开时，在“设置”里授权目录或选择文件夹。
5. 用时间、模型、项目筛选数据。
6. 页面分四个标签：
   - 概览：总量、费用、四段 tokens 构成、每日活跃热力图、趋势和排行
   - 会话：会话明细、搜索、导出 CSV / JSON
   - 价格表：一键更新价格、查看每个模型匹配到的价格、手动覆盖
   - 数据质量：去重情况、字段校验、未匹配价格的模型

## 时间筛选

看板默认显示“近 7 天”的数据，可以在右上角“设置”里改成今天 / 近 30 天 / 全部。

时间筛选按本地日志里的请求时间统计 tokens；费用仍是估算值，不代表官方账单。

你也可以切换到：

- 今天
- 近 7 天
- 近 30 天
- 全部
- 自定义日期范围

自定义日期可以只填开始日期、只填结束日期，也可以填完整起止日期。

## 搜索

普通搜索会匹配：

- 会话标题
- 摘要
- 项目路径
- 模型
- 工具名
- 会话 ID

也支持带字段的搜索：

```text
title:重构
project:/Users/lizhiwei/MyDigtalLife/Code
model:gpt
tool:shell
id:abc123
```

## 常用功能

- 总 tokens，拆成 输入（未缓存）/ 缓存读取 / 缓存写入 / 输出 四段
- 会话数、轮次数、工具调用次数、活跃天数
- 模型消耗排行
- 项目目录排行
- 工具调用排行
- 小时分布
- 会话规模分布
- 单会话详情抽屉
- CSV / JSON 导出
- 自动更新的价格表和费用估算
- 数据质量面板

## 费用估算

价格来自两个公开数据源，单位是美元 / 百万 tokens：

- 主：[LiteLLM model_prices_and_context_window.json](https://github.com/BerriAI/litellm)（ccusage、tokscale 等工具也用它）
- 补充：[models.dev](https://models.dev)

新模型发布后不用手动配置价格：

- 打开页面时，如果价格超过 24 小时没更新，会自动在后台拉取最新价格
- 也可以在“价格表”标签点“一键更新价格”
- 离线时使用项目内置的快照 `src/data/pricing-snapshot.json`，维护者可用 `npm run update:pricing` 刷新快照
- 手动覆盖的价格单独保存，更新时不会被替换

计价规则：

- 输入、缓存读取、缓存写入、输出四段分别按各自单价计算
- Claude 的 1 小时缓存写入按单独价格计算（缺失时按 5 分钟价的 1.6 倍）
- 单次请求上下文超过模型的分档阈值（如 GPT 系列 272k）时，整次请求按高档价计算
- 模型名会去掉日期后缀、provider 前缀和 `[1m]` 之类的标记后再匹配；仍未匹配的模型显示在“数据质量”里，不计入费用

注意：费用是按公开价格推算的参考值，不代表真实账单。订阅制（Claude Max、ChatGPT Plus 等）用户实际不按这个价格付费。

## 计量规则与对账

不同工具统计出来的 tokens 经常对不上，常见原因是重复计数和口径不同。本项目的规则与 [ccusage](https://github.com/ryoppippi/ccusage) 一致：

- Claude Code：同一条回复在日志里会写多行，按 `message.id + requestId` 去重；子代理文件里重复的记录也只算一次
- Codex：只统计 `token_count` 事件；累计值没变化的重复事件跳过；子代理和 fork 会话开头继承的父线程历史不计入
- Codex 的 `input_tokens` 已包含缓存，`output_tokens` 已包含推理，这里拆开后才分段计价，避免重复相加

和其他工具对比时：

1. 先看“数据质量”里的去重数量。不去重时总量会明显偏大，本机实测 Claude Code 偏大约 2.2 倍
2. 再看总量是否包含缓存读取。编程场景下缓存读取通常占输入的 80%–95%，算不算进去会让总数差好几倍
3. 最后按四段拆分逐项对比，可以用 `npx ccusage daily --json` 交叉验证

## 开发命令

```bash
npm install
npm run dev
npm run start:local
npm run lint
npm run build
npm run update:pricing   # 刷新内置价格快照
```

## 目录结构

```text
vibe-coding-usage-dashboard/
├─ open.command
├─ open.bat
├─ scripts/
│  ├─ launch.mjs
│  └─ update-pricing-snapshot.mjs
├─ src/
│  ├─ components/
│  ├─ data/pricing-snapshot.json
│  ├─ lib/
│  ├─ App.tsx
│  ├─ main.tsx
│  ├─ index.css
│  └─ types.ts
├─ public/
├─ package.json
├─ README.md
└─ LICENSE
```

## License

MIT
