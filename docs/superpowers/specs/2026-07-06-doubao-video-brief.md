# 任务简报：webai 豆包图生视频（doubao video i2v）

> 委托：Fable 主会话 → codex。2026-07-06。产出验收人：Fable（独立验收，不采信"代码看起来对"）。

## 目标

给 `webai` 增加豆包视频生成，命令形态与现有 provider 对齐：

```bash
node bin/webai.js video doubao submit "<prompt>" --image <path> [--json]   # 图生视频（核心）
node bin/webai.js video doubao status <jobId> --out <path> [--json]        # 轮询+下载 mp4
```

核心诉求是**图生视频**（i2v）：上传一张参考图（9:16 竖屏 PNG），让豆包（Seedance 引擎）基于它生成视频。纯文生视频是顺带，不是重点。

## 已知事实（省你的探索时间，全部真实验证过）

- 仓库 `~/projects/webai-cli`，分支 `media-direct-http`，基线 commit `d761b05`（49/49 测试过）。**在此分支工作，不要碰 main。**
- 豆包**生图**已 e2e 可用：`src/providers/doubao/{sign,index}.js`。SSE `POST https://www.doubao.com/samantha/chat/completion?<query+a_bogus>`，生图用 bot_id `7338286299411103781`、content_type `2009`、skill_id `3`。**视频的 skill_id/content_type/bot_id 未知——这是 recon 对象之一。**
- **a_bogus 已纯 JS 移植完成**（`sign.js`：SM3+RC4+自定义 base64，salt "dhzx"），msToken 可随机伪造（172 字符）。device 参数（device_id/web_id/tea_uuid）不在 cookie，在 localStorage，已缓存进 creds（`webai auth import chrome doubao` + 首次 localStorage 读取）。
- 用户 Chrome Profile 1 已登录 doubao.com（sessionid 已导入 creds）。**豆包直连国内，不需要代理**；不要设 NODE_USE_ENV_PROXY（那是给 Google 的）。
- SSE 解析坑（生图已踩过）：媒体在 `event_type 2001` 且 `message.content_type===2074`，`message.content` 是 JSON 字符串，`creations[]` 里取媒体；status 2=ready。视频的事件结构可能不同，抓包确认。
- 参考图上传：豆包附件大概率走 imagex/vod AWS4 多步上传（类比即梦：get_upload_token → Apply → PUT bytes → Commit）。参考实现：GitHub `iptag/jimeng-api`（imagex 流程）、`5201213/doubao-free-api`（samantha 协议）。**上传流程是 recon 重点。**
- 下载：豆包图片 CDN（byteimg）纯 HTTP GET 可下；视频大概率 vod CDN mp4，先试纯 HTTP。
- 7 月 2 日跳过豆包视频的原因是 Seedance 风控担忧——**注意克制**：真实生成次数全程 ≤3 次；不要循环重试提交；请求头/参数尽量与真实浏览器抓包一致。

## Recon 方法（首选路径）

用 opencli 浏览器桥 + 用户已登录的 Chrome 抓真实流量（这是最快且最不容易被风控的路）：

```bash
opencli browser doubao-recon init https://www.doubao.com/chat/   # 新会话，别占用已有会话
opencli browser doubao-recon network --start                     # 具体子命令看 opencli browser network --help
# 然后用 opencli click/type/upload 在真实 UI 里：上传一张图 + 输入"把这张图做成视频" + 发送
# 等视频生成，收割完整请求序列：上传若干步 + 提交 + 轮询 + 视频 URL
```

注意：**先确认豆包网页版这个账号到底有没有图生视频能力**（有的账号/入口只有文生视频或没有视频）。如果 UI 里就做不了 i2v，立即停手，把证据（页面状态 dump、响应体）写进报告，不要硬做。

Chrome 必须保持开着；不要关用户已有标签页；截图/DOM dump 辅助判断页面状态（你读不了图，用 `opencli browser <s> state`/`eval` 拿文本化状态）。

## 完成判据（可枚举，逐条验收）

1. `node bin/webai.js video doubao submit "Animate this exact drawing into a video..." --image ~/projects/manju/projects/weight/shots/ep01/s01_01.png --json` 返回真实 jobId（真提交，非 mock）。
2. `status` 轮询到完成并下载 mp4：`ffprobe` 合法、时长 >0、**画面内容明显源自输入图**（铅笔素描石头人）。这条是灵魂——如果产出视频与输入图无关（豆包只把图当聊天附件参考），如实报告，判定 i2v 不可行。
3. 新增协议构造/解析有单测；`npm test` 全绿；gemini/jimeng 行为零改动。
4. recon 笔记写到 `docs/superpowers/recon/2026-07-06-doubao-video.md`（端点/参数/上传流程/事件结构/坑）。
5. 提交在 `media-direct-http` 分支，commit message 规范，**不要 push**。
6. 交付报告写到 `docs/superpowers/specs/2026-07-06-doubao-video-report.md`：做了什么、验证输出（真实命令+真实输出摘录）、遗留风险。

## 红线

- 真实视频生成 ≤3 次；上传/查询类请求不限。
- 不改 main 分支；不动 gemini/jimeng 代码路径（共享工具函数除外，改了必须跑全量测试）。
- 卡住 2 小时无进展就写中期报告停下来，别空转。
