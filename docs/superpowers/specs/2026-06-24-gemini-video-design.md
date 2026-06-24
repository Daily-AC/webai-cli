# Gemini 视频生成逆向 + webai video 命令 — 设计

日期：2026-06-24
状态：已批准，进入实现（用户要求加速，跳过 spec 评审门）

## 目标

逆向 Gemini（gemini.google.com）的「图片 + prompt → 视频」(Veo) 能力，扩展现有
`webai-cli`，新增 `webai video gemini` 命令，并最终包一层 skill 供 Claude Code / Codex 调用。

## 关键事实 / 决策

- 账号已验证有 Veo 视频生成权限。
- 产物形式：**扩展 webai-cli**（复用 opencli 浏览器桥 + `src/core/session.js`）。
- 阻塞行为：**异步**。`submit` 立即返回 job id；`status` 单独轮询/取片。
- 输出：默认**下载 mp4 到本地**，`--json` 同时附带 Gemini 原始视频 URL。
- 路线：**A — 驱动真实 UI + 抓包**。token / 反爬交给站点 SDK，最稳，和现有代码同构。

## 三处必须实测确定的未知（Recon 先行）

1. 图片上传端点与协议（Google 通常是 `push.clients6.google.com/upload/...` 推送上传，返回 media/blob id）。
2. 触发 Veo 的请求：是否仍走 `StreamGenerate`，靠哪个 model / flag 参数；image 引用如何带入 `f.req`。
3. 异步出片机制：长连接流式 vs 返回 operation 后轮询；mp4 URL 在哪个响应里。

## 架构

```
bin/webai.js                  → 新增 `video` 命令组
src/commands/video.js         submit / status 两个子动作
src/sites/gemini-video.js     Veo 适配器：uploadImage / submitVideo / pollVideo / parseVideo
  复用 src/core/session.js     opencli 桥 + fetch/XHR hook + captureNext
```

## CLI 契约

- `webai video gemini submit --image <path> "<prompt>" [--model <veo-id>] [--json]`
  上传图 → 提交 → 立即返回 job id（形如 `<convId>:<respId>`）。`--json` 含请求元数据。
- `webai video gemini status <job-id> [--out <path>] [--json]`
  进同一 session 轮询；未完成报进度；完成下载 mp4 到 `--out`（默认当前目录），
  返回本地路径；`--json` 附 Gemini 原始视频 URL。

## 错误处理

无 Veo 权限 / 上传失败 / 生成被安全策略拒 / 轮询超时 —— 各自明确退出码与信息。

## 实现分期

1. **Recon**：opencli 跑一次真实生成，record-all hook dump 全部 fetch/XHR，确定 3 处未知，产出 endpoint 速查表。
2. 按 recon 写 `gemini-video.js`。
3. 接进 `video.js` + `bin/webai.js`。
4. 写 skill 包装 CLI。
