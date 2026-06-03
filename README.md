# Vibe Coding Usage Dashboard

一个在本机运行的 AI 编程使用统计看板。

它会读取你电脑上的 Codex 和 Claude Code 本地记录，帮你看清楚：

- 今天、最近 7 天、最近 30 天用了多少 tokens
- 哪些项目最消耗 tokens
- 哪些模型用得最多
- 工具调用频率如何
- 单个会话的时间、模型、项目和用量明细
- 按本地价格表估算的大致费用

项目地址：<https://github.com/ai-evolution-lab/vibe-coding-uage-dashboard.git>

## 隐私说明

这个工具只在本机运行。

- 不上传 `.codex` 或 `.claude` 数据
- 不调用外部 API
- 不内置你的聊天记录
- 自动识别目录时只使用本地 `localhost` 只读服务
- 导出的 CSV / JSON 文件只保存在你的电脑上

费用、TPM、RPM 都是本地估算值，不是官方账单。

## 支持的数据来源

### Codex

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`

### Claude Code

- `~/.claude/projects/**/*.jsonl`

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

1. 启动项目。
2. 在页面右上角选择 `Codex` 或 `Claude Code`。
3. 优先点击“自动识别”。
4. 如果自动识别不可用，再点击“手动选择目录”或“回退选文件夹”。
5. 用时间、模型、项目、归档状态和搜索框筛选数据。
6. 点击图表或会话列表查看更细的用量明细。
7. 需要留档时，导出 CSV 或 JSON。

## 时间筛选

看板默认显示“今天”的数据。

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

- 总 tokens、输入 tokens、输出 tokens、缓存输入 tokens
- 会话数、轮次数、工具调用次数、活跃天数
- 模型消耗排行
- 项目目录排行
- 工具调用排行
- 小时分布
- 会话规模分布
- 单会话详情抽屉
- CSV / JSON 导出
- 本地价格表和费用估算

## 费用估算

项目内置了一份常见 OpenAI 和 Anthropic 模型的默认价格表。

你可以在页面右侧修改价格规则，也可以一键恢复默认值。

注意：费用只是根据本地记录和价格表推算出来的参考值，不代表真实账单。

## 开发命令

```bash
npm install
npm run dev
npm run start:local
npm run lint
npm run build
```

## 目录结构

```text
vibe-coding-usage-dashboard/
├─ open.command
├─ open.bat
├─ scripts/
│  └─ launch.mjs
├─ src/
│  ├─ components/
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
