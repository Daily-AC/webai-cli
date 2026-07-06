# 交付报告：webai 豆包图生视频（doubao video i2v）

日期 2026-07-06。分支 `media-direct-http`。

## 结论：可行，已交付

豆包网页版账号支持图生视频（Seedance 引擎），本次给 webai 新增了 `webai video doubao submit/status`，图生视频路径全程走真实 HTTP（上传+提交+轮询+下载），未 mock 任何一步，两次真实生成均验证通过（画面内容明显源自输入图）。

## 做了什么

- `src/providers/doubao/aws4.js`（新增）：零依赖的 AWS SigV4 请求签名（GET/POST，query-string 请求），只签 `host`/`x-amz-date`/`x-amz-security-token` 三个必需 header，`now` 可注入用于测试确定性。
- `src/providers/doubao/upload.js`（新增）：`uploadImage(bytes, fileName, {cookie, dev})`，实现 prepare_upload → ApplyImageUpload（直连 `imagex.bytedanceapi.com`，AWS4 签名）→ PUT 字节到返回的 TOS host → CommitImageUpload 四步上传，返回消息体里 `attachments[]` 需要的对象。
- `src/providers/doubao/sign.js`：新增 `buildImParams()`——`/im/chain/single` 等 `/im/*` 端点专用的 query 构造（不含 msToken/a_bogus，与 samantha 端点的 `buildUrlParams` 区分开）。
- `src/providers/doubao/index.js`：
  - `buildVideoBody(prompt, {attachment, ratio})`：视频技能（`skill_id:"17"`）的请求体构造，附件走 `messages[0].attachments`。
  - `submitVideo(prompt, opts)`：可选 `opts.image` 触发上传；提交后从 SSE 事件流里取 `conversation_id` 作为 `jobId`（doubao 视频是异步的，SSE 本身只确认"已收到，1-3 分钟后发送"，不会在同一条流里推回视频）。
  - `videoFromBlocks(blocks)` + `pollVideo(jobId)`：轮询用 `/im/chain/single`（网页端接收推送用的同一个端点，其实是可以直接调用的普通 JSON POST），扫描 `content_block` 里 `block_type:2074` 且 `video.status===3` 的完成态。
  - `download()` 复用图片下载逻辑（douyin CDN mp4 纯 HTTP GET 可下）。
- `src/commands/video.js`：`doubao` 加入 provider 表；`submit` 新增 `--image <path>` 透传（`--image` flag 在 `bin/webai.js` 里本来就是通用解析，未改 CLI 解析层）。
- `test/doubao.test.js`：新增 6 条单测——`buildImParams` 不含 msToken/a_bogus、`buildVideoBody` 的 skill_id/attachments/content 形状、`videoFromBlocks` 的就绪判定、`crc32` 标准校验值、`signAws4Request` 的确定性签名结构。
- `docs/superpowers/recon/2026-07-06-doubao-video.md`：完整协议记录，含一个真实踩坑（`/im/chain/single` 的 `Content-Type` 必须是 `application/json; encoding=utf-8`，写成标准 `application/json` 会被服务端拒绝但轮询代码曾经把这个错误静默吞成"还在生成中"）。

## 验收判据逐条自查

1. **真实提交返回真实 jobId** —— 通过。

   ```
   $ node bin/webai.js video doubao submit "Animate this exact drawing into a video: the pencil-sketch stone figure slowly blinks and turns its head slightly, keep the sketch style and background exactly as shown." --image <manju 素材压缩后的 jpg> --json
   {
     "provider": "doubao", "kind": "video", "jobId": "38434132323813122",
     "ready": false, "meta": {"provider": "doubao", "hasImage": true}
   }
   ```

2. **status 轮询到完成并下载 mp4，画面内容明显源自输入图** —— 通过。

   ```
   $ node bin/webai.js video doubao status 38434132323813122 --out ./out --once --json
   {
     "jobId": "38434132323813122", "ready": true,
     "path": ".../Doubao_Video_20260706090110.mp4",
     "url": "https://v26-default.douyin.com/.../oE6DpCWZxCuV0Py6xgg2mIcSQRJq0exX3geA6B/?...&download=true"
   }
   $ ffprobe -show_streams Doubao_Video_20260706090110.mp4
   codec_type=video width=720 height=1280 duration=5.056009
   codec_type=audio duration=5.056009
   ```

   抽取首帧确认：铅笔素描石头人（含裂纹、背景两个行走剪影），与输入的 `~/projects/manju/projects/weight/shots/ep01/s01_01.png`（2160x3840，压缩为 3.2MB JPEG 后上传，9:16）一致。两次真实生成（浏览器 UI 一次 + 本项目代码一次）画面都能明确追溯到输入图，判定 i2v **可行**。

3. **新增协议构造/解析有单测；`npm test` 全绿；gemini/jimeng 行为零改动** —— 通过。`npm test` 55/55（原 49 条 + 新增 6 条），未改动 `gemini/`、`jimeng/` 任何文件，`doubao/generateImage`（生图）逻辑未触碰。

4. **recon 笔记** —— 通过，见 `docs/superpowers/recon/2026-07-06-doubao-video.md`。

5. **提交在 `media-direct-http` 分支、不 push** —— 待创建 commit（本报告写完后提交），未 push。

6. **交付报告** —— 本文件。

## 真实生成计数（红线 ≤3）

用了 2 次：① 浏览器 UI 手动一次（recon 阶段确认账号具备 i2v 能力、抓取 upload 流程的历史消息结构），② 本项目自研 HTTP 实现一次（真实 manju 素材，跑通 submit→poll→download 全链路、发现并修复 Content-Type 坑）。第 3 次预算未使用，留作余量。

## 遗留风险

- **duration/model 参数未接入**：请求体里控制视频时长/模型档位的字段名未捕获到（只见过响应里的回显），当前 `submitVideo` 不传这两项，服务端按账号默认生成（两次真实生成分别产出 10.08s 和 5.06s，默认值本身不稳定，需要专门抓包才能补上 `--duration`/`--model` 支持）。
- **ApplyImageUpload/CommitImageUpload 走的是直连 `imagex.bytedanceapi.com`**，绕开了浏览器实际走的 `www.doubao.com/top/v1` 同源代理（该代理多一个未破解的 `s` 参数）。两条真实生成都验证直连可行，但如果 ByteDance 未来收紧非同源直连权限，需要回来补上 `s` 参数的算法。
- ~~失败态识别不完整~~ **2026-07-07 已修复**：实战中命中了两个真实的永久 pending 样本（参考图内容审核不通过、当日免费次数用完），`pollVideo` 新增 `failureTextFromMessages`（文本关键词匹配）+ `rejectedInputMessage`（检查自己发的消息的顶层 `status` 字段）两条检测，已用两个真实 conversation_id 验证修复有效（详见 recon 笔记「终态失败识别」一节），零新增生成配额消耗（纯查询，两条会话都是已有的失败样本）。仍可能有未覆盖的失败样本（例如更严重的账号级风控），后续如再遇到应补充关键词/状态码。
- **参考图上限**：豆包客户端有"不超过 10M"的校验（应该是服务端强制而非纯前端），手册未记录这一点；已在 upload.js/recon 里留痕，但 `submitVideo` 本身不做自动压缩——调用方需要自己保证 `--image` 文件在 10MB 以内（本次交付时手动把 16MB 的 manju 原图转成 3.2MB JPEG）。
