# QQ Lecture Auto Register

基于 NapCat、OneBot 和腾讯文档表单自动化的 QQ 群讲座报名助手。

它可以监听指定 QQ 群消息，捕获腾讯文档问卷链接，自动填写姓名、学号、专业、年级等字段，并完成提交和二次确认。项目当前面向 Windows 环境。

## 功能

- 监听一个或多个 QQ 群。
- 自动识别腾讯文档表单链接。
- 自动填写姓名、学号。
- 可选填写或选择专业，例如 `MPacc`。
- 可选选择年级，例如匹配 `25`、`2025级`、`25级`。
- 支持重复表单策略。
- 本地 Web 控制台显示登录状态、监听状态、日志和处理记录。

## 本地运行

1. 安装 Node.js。
2. 在 `qqwithoutgui` 目录安装依赖：

```powershell
npm install
```

3. 复制配置模板：

```powershell
Copy-Item qqwithoutgui\lecture-auto-register\config.example.json qqwithoutgui\lecture-auto-register\config.json
```

4. 按需修改 `qqwithoutgui\lecture-auto-register\config.json`。
5. 启动：

```powershell
.\一键启动自动报名助手.bat
```

默认控制台地址：

```text
http://127.0.0.1:39212
```

## 配置说明

主要配置在：

```text
qqwithoutgui/lecture-auto-register/config.json
```

常用字段：

- `groupIds`：监听的 QQ 群号列表。
- `student.name`：姓名。
- `student.studentId`：学号。
- `student.major`：专业选择关键词。
- `student.grade`：年级选择关键词。
- `submit`：是否自动提交。
- `skipDuplicateForms`：是否跳过已提交过的重复表单。

## 隐私说明

仓库不会提交本机登录态、腾讯文档浏览器 profile、NapCat 账号配置、WebUI token、二维码、日志和处理记录。这些文件只应保存在本机。

## 后续打包方向

可以进一步使用 Electron 封装成桌面软件，让 Node 后端、NapCat 启动、QQ 登录、腾讯文档登录、监听状态和日志都收敛到一个窗口里。
