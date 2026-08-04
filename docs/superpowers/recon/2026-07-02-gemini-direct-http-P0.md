# P0 验证 spike 实测结论 — Gemini 直连 HTTP(2026-07-02)

在本机(macOS,Chrome 149,Node v22.22)实测,**三大风险全部消除,直连方案成立**。

## 结论

| 风险 | 结论 | 证据 |
|---|---|---|
| Chrome cookie 能否自动导入 | ✅ 可行 | cookie 加密前缀 = `v10`(hex `763130`),**非 `v20` App-Bound**。Keychain `security find-generic-password -w -s "Chrome Safe Storage"` 取到 24 字节密钥;PBKDF2-HMAC-SHA1(pw,"saltysalt",1003,16)+ AES-128-CBC(IV=16×0x20)成功解出 `__Secure-1PSID`(153 字符 `g.a000_…`)、`__Secure-1PSIDTS`(77 字符 `sidts-…`)。Profile 1 三家(google/doubao/jimeng)登录齐全。 |
| 直连鉴权 + 端点 + 反滥用 token | ✅ 无需 token | GET `gemini.google.com/app` → 200,正则抓到 `SNlM0e`(42 字符)、`bl=boq_assistant-bard-web-server_20260630.21_p0`。POST `StreamGenerate`(body 仅 `f.req`+`at`,**不含任何 `!` token**)→ **200**,wrb.fr 格式,返回 `c_…/r_…` 并有模型回答。 |
| TLS/JA3 指纹拦截 | ✅ 不拦 | **裸 Node `fetch`(undici)** 直接 200,无需 curl-impersonate。传输后端定为内置 fetch。 |
| 生图链路端到端 | ✅ 成立(受额度限) | 生图 prompt 被正确路由到图像模型(3.5 Flash);本次未出图仅因账号**当日生图额度用尽**("Image Generation Limit Reached",field `11`;field `44=true`)。属账号配额,非协议问题 → CLI 映射为退出码 5。 |

## 已敲定的设计决策

- **传输后端**:Node 内置 `fetch`(undici),不引指纹依赖。
- **凭据主路**:`webai auth import chrome` 从 Profile 读 + Keychain 解 v10。ABE(`v20`)未来若出现,再退浏览器登录抓取兜底。
- **默认 profile**:`Profile 1`(三家登录齐)。命令支持 `--profile`。

## 关键实现锚点(供 P1)

- v10 解密:strip `v10` 前缀 → AES-128-CBC(key=PBKDF2,IV=16 空格)→ 去 PKCS7 pad。若明文非可打印,去掉前 32 字节 domain-hash(本机 google cookie 无需去,但代码保留兜底)。
- INIT:GET `https://gemini.google.com/app`,`SNlM0e`=`/"SNlM0e":"(.*?)"/`,`bl`=`/"cfb2h":"(.*?)"/`。
- 生成:POST `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=<bl>&_reqid=<n>&rt=c`,`Content-Type: application/x-www-form-urlencoded`,body `f.req=[null, JSON(inner)] & at=<SNlM0e>`。
- 最小 inner(文本可跑通):`[[prompt], null, ["","",""]]`。**生图/生视频的模型路由**(model header `x-goog-ext-…-jspb` 与 f.req 槽位)需按 `HanaokaYuzu/Gemini-API` 移植 —— P1 落实。
- 响应:wrb.fr chunked `)]}'\n\n<size>\n<json>…`,inner `[null,[c_,r_],…,[[rc_,[text],…]]]`;生图 URL、Veo 视频 URL 的候选路径按参考库(生图 `[12][7]`、视频 `[12][59]`、图生图 `[12][0]["8"][0]`)。

spike 脚本存于会话 scratchpad(`gemini-spike.mjs`/`decrypt-cookies.mjs`),仅用于验证,不入库。
