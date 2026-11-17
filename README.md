# QQ 讲座自动报名助手

> 面向 Windows 的 QQ 群讲座报名自动化工具：监听群消息，识别腾讯文档表单，自动填写并提交，同时保留可观察、可回退的本地控制台。

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-browser%20automation-2EAD33?logo=playwright&logoColor=white)
![OneBot](https://img.shields.io/badge/OneBot-NapCat-4A90E2)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)

## 项目概览

讲座报名通常具有名额有限、发布时间不固定、重复填写成本高等特点。本项目把完整流程收敛为：

~~~mermaid
flowchart LR
    A[监听指定 QQ 群] --> B[筛选消息与腾讯文档链接]
    B --> C[打开表单]
    C --> D[匹配并填写字段]
    D --> E{预览模式?}
    E -- 是 --> F[保留页面/记录结果]
    E -- 否 --> G[提交并处理二次确认]
    G --> H[记录成功或失败状态]
~~~

工具不会绕过表单权限，也不会替代账号登录；它只在用户本机、基于已有登录态完成重复操作自动化。

## 核心能力

| 能力 | 说明 |
|---|---|
| 多群监听 | 通过 NapCat + OneBot 反向 WebSocket 监听一个或多个指定群 |
| 消息过滤 | 支持关键词过滤，并仅处理腾讯文档表单链接 |
| 自动填报 | 使用 Playwright 匹配姓名、学号、专业、年级等字段 |
| 提交确认 | 自动识别提交按钮、二次确认按钮与成功提示 |
| 重复策略 | 可选择跳过已提交表单，或允许再次填写 |
| 安全预览 | Dry-run 模式只填写不提交，便于首次验证 |
| 状态追踪 | 记录 processing、submitted、filled_dry_run、failed 等状态 |
| 本地控制台 | 展示 QQ 登录、监听状态、日志、处理记录和常用配置 |

## 设计亮点

- **串行任务队列**：群内短时间出现多个链接时依次处理，减少浏览器上下文与登录态冲突。
- **配置驱动字段匹配**：通过字段别名、可选项和按钮文案配置适配不同问卷。
- **失败可定位**：记录表单 URL、处理状态、耗时与错误原因，便于重试和排查。
- **登录态复用**：使用独立浏览器 profile 保存腾讯文档登录态，不在代码中写入账号密码。
- **隐私隔离**：配置、Cookie、Token、二维码、日志和处理记录均保留在本地并被 Git 忽略。

## 技术架构

~~~mermaid
flowchart TB
    QQ[QQ / NapCat] -->|OneBot WebSocket| Listener[消息监听与过滤]
    Listener --> Queue[串行任务队列]
    Queue --> Browser[Playwright 浏览器自动化]
    Browser --> Docs[腾讯文档表单]
    Listener --> State[本地状态记录]
    Browser --> State
    Dashboard[Express Web 控制台] <--> Listener
    Dashboard <--> State
~~~

主要技术：Node.js、Express、WebSocket、Playwright Core、NapCat、OneBot 11。

## 核心代码位置

~~~text
qq-lecture-auto-register/
├── app/                       # 自研应用：监听、队列、自动填报与控制台
│   ├── index.mjs
│   ├── config.example.json
│   └── ui/
├── scripts/                   # 登录、启动与停止辅助脚本
├── vendor/napcat/             # 隔离存放的 NapCat 第三方运行环境
├── docs/                      # 运行环境说明
├── start.bat                  # Windows 一键启动
├── stop.bat                   # Windows 一键停止
└── package.json               # 应用依赖与统一命令入口
~~~

自研应用与第三方运行环境分开存放：主要实现集中在 `app/`，`vendor/napcat/` 仅用于 QQ 登录和 OneBot 事件转发。

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 18+
- Edge 或 Chrome
- 可正常登录的 QQ 与腾讯文档账号

### 1. 安装依赖

~~~powershell
npm install
~~~

### 2. 创建本地配置

~~~powershell
Copy-Item app\config.example.json app\config.json
~~~

编辑 `app/config.json`，至少填写：

- groupIds：需要监听的 QQ 群
- student.name：姓名
- student.studentId：学号
- student.major / student.grade：可选字段
- submit：是否自动提交
- skipDuplicateForms：是否跳过已提交表单

### 3. 启动

在仓库根目录运行：

~~~powershell
.\start.bat
~~~

默认控制台地址：**http://127.0.0.1:39212**

首次使用建议先开启 Dry-run，确认字段匹配正确后再启用自动提交。

## 常用运行方式

~~~powershell
# 启动本地控制台
npm run app

# 仅启动监听
npm run listen

# 单独打开腾讯文档登录流程
npm run login:docs
~~~

停止所有相关进程可运行 `stop.bat`。更细的辅助入口位于 `scripts/`。

## 隐私与安全

以下内容不应提交到仓库：

- QQ / NapCat 登录配置
- 腾讯文档浏览器 profile 与 Cookie
- WebUI Token、二维码和账号信息
- config.json、state.json、日志与处理记录

当前 .gitignore 已覆盖这些运行时文件。config.example.json 仅使用虚构示例，复制后请在本机填写真实信息。

> 如果仓库曾提交过真实账号、学号、群号或 Token，仅删除当前文件并不能清除 Git 历史；需要另行评估历史清理与相关凭据轮换。

## 已知限制

- 当前主要面向 Windows 与腾讯文档表单。
- 腾讯文档页面结构变化可能导致选择器失效。
- 不同问卷字段命名差异较大，首次使用应通过 Dry-run 校验。
- 请遵守群管理要求、腾讯服务条款及所在学校的报名规则。

## 后续计划

- Electron 桌面封装，减少环境配置步骤
- 增加表单字段匹配测试与回归样例
- 支持更多表单平台和可视化规则编辑
- 增加失败任务重试与通知能力
