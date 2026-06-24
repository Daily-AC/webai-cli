# Gemini 视频/图片生成 — Recon 速查 (2026-06-24 实测)

站点 `gemini.google.com/app`，账号 brixtonqwyjjk@gmail.com（有 Veo 权限）。
全程 opencli 浏览器桥驱动真实 UI（路线 A）。

## 公共信息

- 聊天/生成主端点：`POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
- 响应是 wrb.fr chunked（现有 `src/sites/gemini.js` 的 `iterChunks` 已能解析）。
- 提交后返回 `conversationId = c_<hex>`、`responseId = r_<hex>`，页面 SPA 跳到 `/app/<conv-hex>`（不带 c_ 前缀）。
- 输入框：`.ql-editor[contenteditable="true"]`（Quill）。发送按钮：`button[aria-label="Send message"]`。
- **进入生成模式：直接导航专用路由**（比驱动 "+菜单" 稳得多——菜单项点击会触发重渲染，eval 跨越它会 "operation was aborted"）：
  - 视频：`https://gemini.google.com/videos`（composer placeholder "Describe your video"，有比例选择 "Landscape (16:9)"）
  - 图片：`https://gemini.google.com/images`（placeholder "Describe your image"）
  - 这两个是 gallery 式落地页，**结果不在该页内联渲染**；提交后会建会话并跳到 `/app/<convId>`，结果在会话页里。
  - 冷加载时 composer 可能要 >12s 才出现，readyCheck 等待要给足（实现里用 ~25s）。

## 1. 文本 → 视频 (Veo)

- 进 Create video 模式 → 填 prompt → 点 Send。
- f.req 结构：`f.req=[null,"[[\"<prompt>\",0,...,[null,...,[[null,null,null,1]]]],[\"en\"],[...],\"!<反滥用blob>\"]"]`
  - 视频模式由 `[0][9][6]=[[null,null,null,N]]` 槽位编码（N 与比例相关）；`!...` 是页面 SDK 生成的 token（不可复用 → 必须驱动 UI）。
- **异步**：StreamGenerate 立即返回（视频 pending，文本空）。页面跳 `/app/<conv>` 后反复打 batchexecute 轮询：
  - `kwDCne`（带视频任务 UUID）→ 任务状态
  - `aPya6c` → `[done?, progress, results[]]`
  - `qpEbW` → 配额
  - 完成后页面调 `hNvQHb`（会话内容，~90KB）拿到视频。
- 出片信号 / 取片（DOM，最稳）：导航 `/app/<conv>` 等 `<video src*="contribution.usercontent.google.com">` 出现 + `button[aria-label="Download video"]`。
  - mp4 真实 URL = `video.src` = `https://contribution.usercontent.google.com/download?c=<token>&filename=video.mp4&opi=...`（需 cookie，跨域，in-page fetch 被 CORS 挡）。
  - 下载：点 `button[aria-label="Download video"]` → 浏览器下载到 ~/Downloads，文件名按 prompt 首词命名（如 `A_red_paper_boat_floating_down.mp4`）。

## 2. 图片 → 视频

- 同视频模式。**先 stage 参考图**：
  - 参考图按钮 = 比例行里第一个无 aria-label 的 button（在 "Landscape" 按钮左侧）。
  - 点它会动态创建 `<input type=file>` 并 `.click()` 触发原生对话框。
  - **绕过原生对话框**：monkeypatch `HTMLInputElement.prototype.click`，对 file input 吞掉 click 并标记捕获该 input；然后在 node 里把图片读 base64 注入页面，用 `DataTransfer` 构造 `File` 赋给 `input.files` 并派发 `input`+`change` 事件。
  - 注意：opencli 自带 `upload` 命令在此版本(1.8.4)有 bug（`evaluateWithArgs` 注入 `markerAttr` 重复声明 SyntaxError），故走 DataTransfer 注入。
  - 点参考图按钮也必须用 **opencli CDP 原生 click**（可信手势），程序化 `el.click()` 不会让 Angular 创建/弹出 file input → 注入时 "no-file-input"。
  - 参考图按钮渲染比 composer 晚，tag 前要轮询等待它出现。
- **上传时机**：staging（设 File）时立即上传，不是 send 时。端点：
  - `POST https://push.clients6.google.com/upload/`（init，返回 upload_id）
  - `POST https://push.clients6.google.com/upload/?upload_id=<id>`（传字节）→ 响应体 = blob 引用 `/contrib_service/ttl_1d/<id>`
- **适配器必须等 `?upload_id=` 那个 POST 完成再点 Send**（否则图片没传完）。缩略图出现在 composer + Send 按钮变蓝 = 就绪。
- 其余（提交/轮询/取片）同文本→视频。

## 3. 图片生成 (/images)

- 导航 `/images` → 填 prompt → Send。
- **同步**：同一个 StreamGenerate 流式返回（约 10s），过程有 "Creating your image"，最终 candidate 文本含占位 `http://googleusercontent.com/image_generation_content/<n>`。
- /images 是 gallery 页，结果不内联；提交后跳 `/app/<convId>`，导航过去后 `<img>`（fresh load 时不一定是 blob、可能懒加载）+ `button[aria-label="Download full size image"]`。**就绪信号 = 下载按钮存在**（别强依赖 blob img）。
- 下载：点 `button[aria-label="Download full size image"]` → ~/Downloads，名为 `Gemini_Generated_Image_<id>.png`（实测 2816×1536 PNG）。

## 实现要点

- **下载 = opencli CDP 原生 click 下载按钮 + fs 快照法**：
  - 必须用 `opencli browser <ses> click`（CDP 原生点击=可信用户手势）；程序化 `el.click()` 会被 Chrome 当作非手势**拒绝下载**。
  - 下载前快照 ~/Downloads 文件集，点击后轮询"新增且非 .crdownload、大小稳定"的文件。**不要用 `opencli wait download <substr>`**——它的 recent 回退会匹配到上一次的旧下载。
  - macOS 无 `timeout` 命令，CLI 内部自己实现超时轮询。
- 复用 `src/core/session.js` 的 hook/`captureNext` 抓 StreamGenerate；提交后从 URL `/app/<hex>` 取 convId 作为 job id（比解析 f.req 稳）。
- 异步契约：`submit` 返回 jobId=`<convHex>`；`status <convHex>` 导航过去 → 轮询 ready → 下载。
- **同一物理 Chrome 标签同时只能一个命令驱动**；并发 eval/click 会 "Browser connection dropped" 或 "operation was aborted"。
