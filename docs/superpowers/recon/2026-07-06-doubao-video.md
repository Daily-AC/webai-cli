# Recon: 豆包（doubao.com）图生视频 (i2v)

日期 2026-07-06。方法：opencli 浏览器桥（真实 Chrome，已登录账号）+ 真实网络抓包 + 公开参考实现交叉验证。

## 结论：i2v 可行

该账号的豆包网页版「视频生成」技能（点击输入框旁的「视频生成」按钮）自带 `<input type=file accept=".jpg,.png,.jpeg,.webp">`，上传一张参考图后底部会出现缩略图附件，发送后引擎为 Seedance（默认 2.0 Mini），生成的视频画面内容明显源自输入图（同一石头人素描，含裂纹、背景剪影）。真实生成两次全部成功：
1. 浏览器 UI 驱动、200x200 缩略测试图 → 10.08s 视频，画面=输入图。
2. 本项目自研 HTTP 实现、真实 2160x3840 manju 素材（JPEG 压缩至 3.2MB）→ 5.06s 视频，画面=输入图。

## 端点与协议

### 1. 图片上传（imagex/TOS，4 步，与即梦同构）

| 步骤 | 方法/URL | 关键点 |
|---|---|---|
| 1. prepare_upload | `POST www.doubao.com/alice/resource/prepare_upload` | query 走 samantha 签名（`buildUrlParams`+`signSamanthaUrl`，需要 a_bogus）；body `{resource_type:2, scene_id:"5", tenant_id:"5"}`；返回 STS 临时凭证 `{service_id, upload_auth_token:{access_key,secret_key,session_token}}` |
| 2. ApplyImageUpload | `GET imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=<service_id>&NeedFallback=true&FileSize=<n>&FileExtension=.png` | AWS SigV4 签名（region `cn-north-1`, service `imagex`，用上一步的 STS 凭证）。返回 `Result.UploadAddress.{StoreInfos[0].{StoreUri,Auth,UploadID}, UploadHosts[0], SessionKey}` |
| 3. PUT 字节 | `POST https://<UploadHosts[0]>/upload/v1/<StoreUri>` | header `Authorization: <StoreInfos[0].Auth>`（原样透传，非我们自己签）,`Content-Type: application/octet-stream`, `Content-Crc32: <hex crc32(bytes)>`。返回 `{code:2000, message:"Success"}` |
| 4. CommitImageUpload | `POST imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=<service_id>` | AWS SigV4 签名，body `{SessionKey:<步骤2 SessionKey>}`。返回 `Result.PluginResult[0].{ImageUri,ImageWidth,ImageHeight,ImageMd5,ImageSize}` |

浏览器真实抓包里 ApplyImageUpload/CommitImageUpload 走的是 `www.doubao.com/top/v1?...&s=<随机串>` 同源代理（`s` 参数算法未知），但直接打 `imagex.bytedanceapi.com`（公开 ImageX OpenAPI，来自参考实现 `5201213/doubao-free-api/uploader.py`）同样有效且更稳定 —— 已验证。上传/查询类请求不计入生成次数红线，本环节调试了多轮。

参考实现来源：GitHub `5201213/doubao-free-api`（`uploader.py` 给出 AWS4Auth 签名细节和请求体形状；`im_api.py` 给出 `/im/chain/single` 的 uplink body 形状）。

### 2. 提交生成（复用现有 samantha SSE 基建）

`POST www.doubao.com/samantha/chat/completion?<query>&a_bogus=...`，与生图共用同一 `bot_id: 7338286299411103781`，仅 skill 不同：

- 生图：`skill_id:"3", skill_type:3`
- **视频：`skill_id:"17", skill_type:17`**（`ext.input_skill` 与 `skill` 字段都要改）
- 附件：`messages[0].attachments = [<步骤4 CommitImageUpload 拼出的 attachment 对象>]`（`{key,name,type:"image",file_review_state:3,file_parse_state:3,identifier,option:{width,height},md5,size}`，`key` = `CommitImageUpload` 返回的 `ImageUri`）
- `content_type` 沿用图片的 `2009`；`content` 为 `{text: prompt}` 的 JSON 字符串（可选 `ratio`，未验证 duration/model 的 content 字段名，见「已知限制」）
- 该 SSE 请求很快结束（返回"这就为您生成视频，请稍等，1-3 分钟后主动发送"），**不会在同一条流里推送最终视频** —— 与生图不同，视频是异步的。

### 3. 轮询（发现是关键坑）

真实视频不会通过打开的 SSE 流推回来，网页端是靠一个类似长连接/推送的 `/im/chain/single` 协议获知会话更新。但该端点本身就是一个可以自己直接调用的普通 JSON POST（不需要 a_bogus/msToken！），已验证可行：

```
POST www.doubao.com/im/chain/single?<samantha 基础 query，但不含 msToken/a_bogus，见 buildImParams>
Content-Type: application/json; encoding=utf-8   # 注意不是标准 "application/json"！
{
  "cmd": 3100,
  "uplink_body": {
    "pull_singe_chain_uplink_body": {
      "conversation_id": "<jobId，即视频生成回复所在会话>",
      "anchor_index": 9007199254740991,
      "conversation_type": 3,
      "direction": 1,
      "limit": 20,
      "ext": {},
      "filter": {"index_list": []}
    }
  },
  "sequence_id": "<uuid>",
  "channel": 2,
  "version": "1"
}
```

响应 `downlink_body.pull_singe_chain_downlink_body.messages[]`，其中已完成消息的 `content_block[]` 里有一项 `block_type:2074`，`content.creation_block.creations[].video` 带 `status`（3=就绪）、`download_url`（douyin CDN mp4，纯 HTTP GET 可下，不需要额外鉴权）、`duration`、`width`/`height`。

**踩坑记录（本次最费时的一步）**：如果 `Content-Type` 写成标准的 `application/json`（没有 `; encoding=utf-8`），服务端返回 `{status_code:712012002, status_desc:"不支持编码类型"}`，但 `downlink_body` 是空对象 `{}`——如果轮询代码只看 `messages` 数组是否为空而不检查 `status_code`，会把这个错误误判成"还在生成中"，导致轮询 10 分钟超时都拿不到结果（本次实际就是这样踩的坑：视频其实几分钟前就生成好了，轮询代码一直在用错误的 Content-Type 无声地失败）。**修复**：Content-Type 必须精确写 `application/json; encoding=utf-8`；轮询代码必须显式检查响应的 `status_code` 并在非 0 时抛错，不能把"解析不出消息"和"还在生成"混为一谈。

### opencli 工具本身的坑（与豆包协议无关，记录以防下次复现）

- `opencli browser <s> upload <ref> <file>` 在 v1.8.4 上稳定报 `SyntaxError: Identifier 'markerAttr' has already been declared`；升级到 v1.8.6 后变成 CDP 级 `{"code":-32000,"message":"Not allowed"}`（`DOM.setFileInputFiles` 在部分 Chrome/扩展调试会话下被拒绝，是已知的 CDP 限制，非豆包页面问题）。
- 绕过方法：`browser eval` 里用 `atob(base64) -> Uint8Array -> new File(...) -> DataTransfer -> input.files = dt.files -> dispatchEvent(new Event('change',{bubbles:true}))`，等价于用户手动选择文件，doubao 的 change 监听器会正常响应（包括其内建的"图片尺寸不能小于 40x40，大小不超过 10M"客户端校验）。跨域 `fetch(dataURI 或本地 http 服务器)` 会因代理/CSP 卡死 115s 超时，必须把图片直接以 base64 字面量嵌入 eval 脚本（走 argv，注意 macOS `ARG_MAX` ≈ 1MB，超大图要先降采样）。
- `opencli browser <s> network` 在某个由 `tab new` 切换出的 tab 上稳定返回空列表（即使该 tab 确实发出了请求）；换成 `browser open`（全新会话+全新 tab）后 `network` 恢复正常捕获。怀疑是 CDP Network domain 只在会话初始化时对"当时的" tab 生效，`tab new` 切换后未重新绑定。

## 已知限制 / 未验证项

- `duration`（10s/5s…）与 `model`（2.0 Mini 等）在请求体里具体走哪个字段未捕获到真实请求（只捕获到响应里 `ext.chat_ability` 回显的值）。当前实现不传这两个参数，服务端按账号默认档位生成（本次两次真实生成分别产出 10.08s 和 5.06s，说明默认值本身就不稳定/可能与图片尺寸或其它因素相关，需要后续专门抓包）。
- 上传态的失败/风控分支（`review_state`/`parse_state` 非常规值）未见过真实样本，`pollVideo` 目前只认 `ai_creation_res_code !== '0'` 为失败，可能不完整。
- `ApplyImageUpload`/`CommitImageUpload` 走 `www.doubao.com/top/v1` 同源代理时用到的 `s=<随机串>` 参数算法未破解；本实现绕开了它，直连 `imagex.bytedanceapi.com`，两条真实生成都验证通过，但如果 ByteDance 未来收紧直连 ImageX 的权限，需要回来补上这个 `s` 参数。
