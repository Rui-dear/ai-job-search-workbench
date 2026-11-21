# 求职工作台（指路侠 · 求职工具）

一个面向大学生 / 应届生的**求职管理工作台**：单文件前端 + 轻量 AI 后端。核心亮点是**真实大模型驱动的「简历 × 岗位 JD」匹配分析**（DeepSeek），本地优先、无需注册即可使用。

> 定位：可在线访问、具备真实 AI 功能的个人作品集 Demo，非长期运营的 SaaS 产品。

## 主要功能

- **首页看板**：投递漏斗、面试提醒、待办、最近机会
- **投递管理 / 面试管理**：看板 + 状态机 + 筛选
- **简历 & 岗位 JD**：JD 解读、简历自检（ATS 规则）、**简历 × JD 匹配（真实 AI）**
- **面试练习 / 公司避坑 / Offer 比较 / Offer 到手计算 / 岗位画像 / HR 话术拆解**等
- **演示数据**：一键填入演示简历与 JD，完整体验 AI 分析流程（明确标注「演示」，不伪装真实数据）

## AI 简历 × JD 匹配

输入简历 + 岗位 JD，输出：

- 岗位核心要求提取
- 简历与岗位要求**逐项匹配**（附简历原文证据）
- 能力差距（仅表示「简历未体现」，不判定「不具备」）
- 简历优化建议
- 针对岗位的面试问题

**AI 与规则兜底严格区分**：AI 可用时显示「✦ AI 分析」；AI 不可用（无 Key / 超时 / 返回格式错误）时自动降级为本地规则分析，并明确标注「⚙️ 规则兜底分析 · 非 AI」。

## 技术架构

```
浏览器（单文件 index.html + localStorage）
        │  POST /api/match  {resume, jd}
        ▼
Vercel Function（api/match.js · AI 网关）
        │  OpenAI 兼容接口
        ▼
DeepSeek（可通过环境变量替换为任意 OpenAI 兼容服务）
```

- **前端**：原生 HTML / CSS / JS 单文件，localStorage 本地存储，无框架、无数据库、无账号。
- **后端**：Vercel Function 薄网关，仅托管 API Key（存环境变量，永不进前端 / Git），带输入长度限制、超时、按 IP 限流。
- **模型**：DeepSeek（OpenAI 兼容）。

## 本地运行

```bash
# 1.（可选）复制环境变量模板并填入你的 API Key
cp .env.example .env

# 2. 启动本地服务（静态页面 + AI 网关）
npm run dev        # 或 node scripts/dev-server.cjs

# 3. 打开 http://localhost:3000
```

> 不填 Key 也能运行：AI 请求会返回 503，前端自动降级为本地规则分析。

## 部署到 Vercel

1. 将仓库推送到 GitHub。
2. 在 Vercel 导入该仓库（Framework Preset 选「Other」）。
3. 在项目 **Settings → Environment Variables** 配置：

   | 变量 | 值 |
   |---|---|
   | `LLM_API_KEY` | 你的 DeepSeek API Key |
   | `LLM_BASE_URL` | `https://api.deepseek.com` |
   | `LLM_MODEL` | `deepseek-chat` |

4. Deploy，即可获得 `https://<项目名>.vercel.app` 在线地址。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `LLM_API_KEY` | 是 | — | 模型服务 API Key（仅后端环境变量） |
| `LLM_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI 兼容 Base URL |
| `LLM_MODEL` | 否 | `deepseek-chat` | 模型名 |
| `LLM_TIMEOUT_MS` | 否 | `25000` | 模型调用超时（毫秒） |
| `RATE_LIMIT_WINDOW_MS` | 否 | `600000` | 限流窗口（毫秒） |
| `RATE_LIMIT_MAX` | 否 | `10` | 每窗口每 IP 最大请求数 |

## 隐私与安全

- API Key 只存于后端环境变量，**永不写入前端代码或 Git 仓库**（`.env` 已被 `.gitignore` 忽略）。
- 简历与 JD 会发送至模型服务商用于分析；页面已加隐私提示，请勿上传含身份证号、手机号等敏感信息的简历。
- 演示数据均为虚构内容并明确标注，不包含真实个人信息。

## 目录结构

```
index.html              # 前端单文件（含 CSS / JS）
api/match.js            # AI 网关（Vercel Function）
scripts/dev-server.cjs  # 本地开发服务器
scripts/test-*.cjs      # 测试
vercel.json             # Vercel 配置
.env.example            # 环境变量模板（无真实 Key）
```

## 测试

```bash
npm test              # 网关 + 前端 AI 接入测试
npm run test:gateway  # 仅网关
npm run test:frontend # 仅前端
```

## 截图

（部署后补充）
