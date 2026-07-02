# 内容 CDN 下载 403 — 深度排查结论(2026-07-02)

## 现象

生成链路(StreamGenerate 生图/Veo 视频、read_chat 轮询到就绪 URL)**纯 headless HTTP 全通**。唯一失败:**从 Google 内容 CDN 取文件字节**——
- 视频:`GET https://contribution.usercontent.google.com/download?c=<token>&filename=video.mp4&opi=<gaia>`
- 图片:`GET https://lh3.googleusercontent.com/...`

一律 **HTTP 403, `content-length: 0`, `content-type: text/html`**。响应头暴露下载服务是 Google **Scotty / GUploader**(`server: UploadServer`、`x-guploader-uploadid`、`vary: Origin`)。

## 已排除(实测,均 403)

| 维度 | 试了什么 | 结果 |
|---|---|---|
| TLS/JA3 指纹 | cycletls(Chrome JA3) | 403 |
| 完整指纹(JA3+HTTP2+header 序) | **curl-impersonate `curl_chrome146`(真 curl+BoringSSL+Chrome 补丁)** | 403 |
| **真实 Chrome 本尊** | Playwright `channel:'chrome'`(Chrome 149) 导航下载 | 403(`ERR_HTTP_RESPONSE_CODE_FAILURE`) |
| 出口 IP | 本机直连 / 远程代理(腾讯云) / **本地干净代理 7897** | 均 403 |
| cookie 新鲜度 | 每次测前重新 `auth import chrome` | 403 |
| header | 带/不带 Origin、Referer、Range、`X-Goog-AuthUser` 0-2、`authuser=` 0-2、SAPISIDHASH | 全 403 |
| cookie 集 | 全量 48 cookie / 仅 SID 族 | 403 |

代理插曲:`curl_cffi` 与 `curl-impersonate` **走那个远程代理**时报 `OPENSSL_internal: invalid library`(BoringSSL 被代理破坏),非构建问题;绕开代理直连则是干净的 403。Node 内置 `fetch` 默认不吃 `HTTP_PROXY`,所以生成链路一直是直连、正常。

## 根因(定位)

**Scotty 内容下载要的是"完整的真实浏览器登录会话",不是 API 级 cookie。** 决定性证据:把导入的 cookie 注入一个全新的真实 Chrome(`channel:chrome`)上下文后,`gemini.google.com/app` **并未登录**(composer 不可见)——同一套 cookie 用 undici 直打 StreamGenerate 却是 200。即:

- 我们导入的 cookie 足以做 **API 级鉴权**(StreamGenerate / read_chat 200);
- 但**撑不起完整网页登录态**(缺 `__Host-` 系的 GAPS/LSID 等完整登录 cookie,或需精确属性注入);
- 而 Scotty(`vary: Origin`)要求下载来自**已完整登录的浏览器会话**上下文。

所以连"真 Chrome + 注入 cookie"都 403;而**用户日常在用的真实 Chrome Profile(完整活跃会话)能正常下载**(旧 opencli 路线就是靠真实 Chrome 的 Download 按钮取字节)。指纹/IP/代理都不是因,**会话完整性**才是。

参考实现 `HanaokaYuzu/Gemini-API` 用 `curl_cffi impersonate=chrome + Origin/Referer + cookies` 能下,推测其账号/会话满足了我们这套导入 cookie 不满足的完整性条件(或不同账号/区域策略)。

## 结论 / 下一步选项

1. **真实登录 Chrome 会话下载(可靠)**:仅下载这一步驱动用户完整登录的 Chrome —— 重连 opencli 扩展点 Download 按钮(旧法,已验证可行),或 Playwright `launchPersistentContext` 指向真实 Profile(需该 profile 未被占用,或拷贝一份)。代价:下载环节重新引入浏览器。
2. **补全登录 cookie 使注入会话成为完整登录态**:研究把 `__Host-` 系登录 cookie 正确注入,让 headless/注入 Chrome 达到完整登录 → 或许 headless 下载可成。未验证,成本不明。
3. **只返回就绪 URL**:CLI 返回 URL,下载交给上层浏览器。CLI 最轻但把硬骨头推给下游。

生成链路本身已纯 headless 且好用,本 blocker 仅限"取文件字节"。

## 追加实测(2026-07-02 下午,用户配合真机抓包)

用户在真 Chrome 里成功下载视频并 Copy-as-cURL。对比 + 复刻测试结论:
- 真 Chrome 下载请求 = 同一个 `download?c=` URL + cookie + origin/referer + `x-client-data`/`x-browser-validation`/整套 sec-ch-ua + `sec-fetch-site: same-site`,**无 authorization、无 x-goog-authuser**。
- 我用 **curl-impersonate(真 Chrome BoringSSL,JA3+HTTP2 指纹)** + 全套 Chrome 头 + 新鲜 cookie + 7897 干净出口,复刻**同一 URL** → 403。
- **用户几分钟前刚在 Chrome 成功下载的全新 token**(非过期)+ 上述全套 → 仍 403。**过期假设排除。**
- 403↔302 对比确认:cookie 是被认成"已登录"的(403=已认证但禁止)。

**最终根因判定**:`x-browser-validation`(+`x-client-data`)是 **Chrome 二进制/设备绑定的完整性签名**,由签名过的真实 Chrome 生成,headless 客户端无法伪造;`contribution.usercontent.google.com`(Scotty)对其校验。因此**纯 HTTP 下载在本机/本账号不可行**,无论 TLS 指纹/cookie 新鲜度/header 如何。真 Chrome 能下是因为它带合法的 browser-validation。

**结论:采用"真实 Chrome 会话下载"作为下载后端**(生成链路保持纯 HTTP)。候选实现:重连 opencli 扩展点下载按钮,或 Playwright `launchPersistentContext` 指向 Profile 1 副本。图片链路(lh3)同理走浏览器,或后续再验 `=s0-d?alr=yes` 两跳 RPC 是否受同样加固(未测)。
