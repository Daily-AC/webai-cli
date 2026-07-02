# webai-cli 媒体生成:直连 HTTP 重构 — 设计文档

日期:2026-07-02
分支:`media-direct-http`
范围:**地基 + Gemini(P0–P2)**。即梦、豆包各自后续单独 spec(见文末「Spec 拆分」)。

## 1. 背景与动机

现有 `src/sites/gemini-media.js` 走 opencli 驱动真实 Chrome UI(路线 A):每条命令打开标签、注入 fetch/XHR hook、操作 UI 提交、轮询。问题:

- **重**:依赖 opencli 常驻 + 一个已登录且专用的 Chrome 标签,单命令冷启动就要十几秒。
- **慢/不稳**:Gemini 视频异步轮询,成功率低、极慢;同一标签同时只能跑一个命令。
- **测试几乎为零**。

目标:改为**纯 Node HTTP 直连**,甩掉 opencli+Chrome;提高稳定性与速度;补齐测试;为 Claude Code workflow(如漫剧编排直接调 Gemini 出图/出视频)提供轻、可脚本化、确定性退出码的工具。

## 2. Recon 可行性结论(2026-07-02,三个 opus agent 查证)

**核心更正**:旧 recon 判定「Gemini 的 `!<blob>` 是反滥用 token、不可复用、必须驱动 UI」**不成立**。源码级证据(`HanaokaYuzu/Gemini-API` `client.py`)表明:

- 该 `!<blob>` 只是客户端 `secrets.token_urlsafe(2600)` 生成的随机串,**仅 deep research 才填**,普通生成(生图/生视频)不带它;服务端不做密码学校验。
- 之所以在 `/videos`、`/images` 抓包看到它,是 composer 专用路由的前端行为;底层 `StreamGenerate` 端点直接发 prompt 无需该 token。

| 链路 | 纯 Node HTTP 直连 | 鉴权 / 签名 | 参考实现 |
|---|---|---|---|
| Gemini 文生图 / Veo 文生视频 / 图生视频 / 图生图 | ✅ 全可行 | `__Secure-1PSID`+`__Secure-1PSIDTS` cookie;HTML 正则抓 `SNlM0e`(=`at`)、`bl`、push id;`1PSIDTS` 用 `RotateCookies` 端点自动刷新。**无反滥用 token**。 | HanaokaYuzu/Gemini-API (Python) |
| 即梦 生图 / 常规视频 | ✅ | 仅 `sessionid`;`Sign` 头 = `md5("9e2c\|"+uri.slice(-7)+"\|7\|"+ver+"\|"+devTime+"\|\|11ac")`;上传走 imagex/vod 标准 AWS4 | iptag/jimeng-api (TS) |
| 即梦 Seedance/veo3/sora2 视频 | ⚠️ 可行 | 额外 `a_bogus`/`msToken`;纯 JS 复刻(bdms SM3+RC4+自定义 base64),兜底 Node-VM 跑官方 `bdms-1.0.1.20.js` | deluxebear/jimeng-cli |
| 豆包 生图 | ✅ | `sessionid`;走对话 SSE `/samantha/chat/completion`;`a_bogus` 可直接伪造随机串 | 5201213/doubao-free-api |
| 豆包 生视频 | ❌ 不成熟 | 无独立端点,底层即 Seedance,生态脆弱、风控严 | — |

Gemini 侧唯一工程门槛:Node 需能仿 Chrome TLS/JA3 指纹的 HTTP 客户端(裸 undici 可能被指纹拦——**待 P0 spike 实测判定**);f.req 槽位随发版微调。

## 3. 落地路线选择

- **路线 1 自研统一直连适配器(选定)**:自己写干净的纯 Node 适配器,协议知识(端点、f.req 结构、签名算法、响应解析路径)从参考库借。运行时最轻(零浏览器、零多语言),契约统一→测试统一。
- 路线 2 整库移植:多套异构代码、维护割裂,弃。
- 路线 3 本地网关 daemon:引回重依赖+多语言运行时,违背"变轻",弃。

## 4. 架构

```
bin/webai.js
  └─ src/commands/{image,video}.js     瘦命令层:--provider/--out/--json + 确定性退出码
       └─ src/providers/<name>/        每家 provider 实现统一契约
       └─ src/auth/store.js            凭据仓库 + 各家刷新
       └─ src/http/client.js          HTTP 传输(指纹兜底)
```

现有 opencli 媒体路径(`src/sites/gemini-media.js`、`src/core/session.js` 里被媒体用到的部分)退役;chat 命令(ask/stream/history/detail)本轮**不动**,仍走 opencli。新代码与旧 chat 代码并存,互不耦合。

### 4.1 HTTP 传输 `src/http/client.js`

- 统一封装请求(方法/头/query/body、超时、重试、状态码)。
- **指纹策略**:默认裸 Node(undici/`fetch`)。P0 spike 若发现 Gemini 被 TLS/JA3 指纹拦,则接入 Chrome 仿真客户端作为可插拔后端(候选:`cycletls` / curl-impersonate 绑定;选型在 P0 依据实测定)。传输后端对 provider 透明。
- 无第三方指纹依赖时也能对即梦/豆包工作(它们不吃 TLS 指纹,吃的是 body 签名)。

### 4.2 凭据仓库 `src/auth/store.js`

- 单一 JSON 缓存:`~/.config/webai-cli/creds.json`(权限 600),按 provider 存,作为运行期读取源。
- **凭据来源(按优先级,选定)**:
  1. **从 Chrome profile 自动读(主用)** — `webai auth import chrome [--profile Default]`。macOS 下 Chrome cookie 存于 `~/Library/Application Support/Google/Chrome/<Profile>/Cookies`(SQLite),值用 AES-GCM 加密、密钥在 Keychain(`security find-generic-password -s "Chrome Safe Storage"` → PBKDF2 派生)。读对应域(`.google.com`、`jimeng.jianying.com`、`.doubao.com`)的 cookie 直接灌进 creds.json。零粘贴、复用你已有登录态。参考现成实现思路 `chrome-cookies-secure`。
     - **风险(P0 必测)**:Chrome 新版(~v130+/2025)可能把 **App-Bound Encryption** 扩到 macOS,届时仅靠 Keychain 解不出 → 退回来源 2。运行时 Chrome 可开着(拷贝 Cookies 文件只读读取,避开 WAL 锁)。
  2. **浏览器登录抓取(兜底,始终可用)** — `webai auth login <provider>`:自动打开该 provider 登录 URL,你登录完后从浏览器会话抓 cookie 写入 creds.json。只在首次引入浏览器(opencli/playwright),之后不需要。
  3. **手动粘贴(逃生口)** — `webai auth set <provider> --cookie ...`,从 devtools 拷。
- **OAuth 不采用**:OAuth 只能拿到 Google/字节**官方付费 API** 的 token(Gemini API 需 key、Seedance 走火山 Ark),与本项目复用**网页登录态 cookie** 的路线不是一回事。仅当将来选择把某 provider 改走官方 API 时才引入,不在本 spec。
- **灌入后的刷新**:
  - Gemini:后台按需 `POST accounts.google.com/RotateCookies`(body `[000,"-0000000000000000000"]`)headless 刷新 `__Secure-1PSIDTS`(60s 防抖避 429);或在 Chrome 仍活跃时重新 `import chrome` 取最新值。每次操作前 GET `gemini.google.com/app` 抓最新 `SNlM0e`/`bl`。
  - 即梦/豆包:`sessionid` 相对长效,失效报明确错误并提示重新 `import`/`login`。

### 4.3 Provider 契约 `src/providers/<name>/index.js`

每家 provider 导出统一契约,命令层只依赖契约、不关心内部:

```
id
generateImage(prompt, opts) -> { images: [{url|localSuggestedName}], meta }        // 同步或内部轮询到完成
submitVideo(prompt, opts)   -> { jobId, meta }                                       // 异步:提交即返回
pollVideo(jobId)            -> { status: 'pending'|'ready'|'failed', video?, progress? }
download(remoteUrlOrRef, outPath) -> localPath                                        // 含 Gemini 206 轮询语义
opts: { image?(参考图路径), ratio?, model?, count?, duration? }
```

provider 内部纯函数子模块,**单独单测**:

- `sign.js`:Gemini 无签名;即梦 MD5 `Sign` + a_bogus(P3);AWS4(P3);豆包伪 a_bogus(P4)。
- `reqbuild.js`:Gemini f.req 69 槽构造(`at`=SNlM0e,不放 `!` token);即梦 draft_content(P3)。
- `parse.js`:Gemini wrb.fr chunked 解析 + 候选路径(生图 `[12][7]`、生视频 `[12][59]`、图生图 `[12][0]["8"][0]`);即梦 history item(P3)。

### 4.4 命令层 `src/commands/{image,video}.js`

- `webai image <provider> "<prompt>" [--image <path>] [--ratio 16:9] [--count N] [--out <path|dir>] [--json]`
- `webai video <provider> submit "<prompt>" [--image <path>] [--ratio] [--duration] [--json]` → 打印 jobId
- `webai video <provider> status <jobId> [--out <path>] [--once] [--json]`
- 退出码(供 CC workflow 判定):`0` 成功;`2` 凭据缺失/失效;`3`(仅 `--once`)仍在生成;`4` 内容被拒/风控;`5` 配额不足;`1` 其它错误。
- `--json` 输出结构化结果(URL、本地路径、jobId、model、耗时),供 skill/脚本消费。
- provider 名:`gemini`(本 spec);`jimeng`、`doubao`(后续 spec 接入,契约已预留)。

## 5. 测试策略(TDD)

- **纯函数单测**(核心,离线可跑):
  - Gemini `reqbuild`:给定 prompt/opts → f.req 字符串结构断言(槽位、`at` 位置、无 `!` token)。
  - Gemini `parse`:用 recon 抓到的真实 wrb.fr 响应 fixture → 断言提取出图/视频 URL、convId、206 语义。
  - 即梦 `sign` MD5(P3)、AWS4(P3)、豆包伪 a_bogus 格式(P4):对拍已知向量。
- **fixture 回放**:响应样本存 `test/fixtures/<provider>/`,解析器对其断言,发版漂移时改 fixture 即定位。
- **凭据/传输**:mock HTTP,断言 RotateCookies 防抖、SNlM0e 抓取、重试与退出码映射。
- **真机 smoke(gate)**:`WEBAI_LIVE=1` + 有效 creds 才跑,打一次真实生图/生视频最小链路;CI 默认跳过。
- 测试框架:Node 内置 `node:test` + `node:assert`(零依赖,契合"变轻")。

## 6. 分阶段实施(严格按用户优先级:Gemini 主,豆包/即梦次)

- **P0 地基 + 验证 spike**:`http/client`、`auth/store`、`node:test` 骨架;三件事实测消除风险 —— ① **Chrome cookie 自动导入**在本机是否可行(App-Bound Encryption 是否挡住,决定主用/兜底);② 拿到真实 cookie 后**跑通 Gemini 直连最小生图请求**(消除 token 假设);③ 是否被 **TLS/JA3 指纹**拦(据实测定传输后端选型)。
- **P1**:Gemini 文生图 + Veo 文生视频(submit/poll/download,含 206 轮询)。
- **P2**:Gemini 图生视频(`content-push.googleapis.com/upload` 纯 HTTP 传参考图)+ 图生图。
- **P3(后续 spec)**:即梦 生图 + 常规视频(MD5 Sign + AWS4 上传);Seedance 视频接 a_bogus 纯算,Node-VM 兜底。
- **P4(后续 spec)**:豆包 生图(对话 SSE + 伪 a_bogus)。

`gemini-media` skill 在 P1/P2 完成后更新为直连命令;豆包/即梦稳定后再各出 skill/合并入口。

## 7. 风险与缓解

- **Gemini TLS/JA3 指纹**:P0 spike 实测;若被拦,可插拔 Chrome 仿真后端。
- **1PSIDTS 轮换**:RotateCookies 自动刷新 + 60s 防抖 + 401 重试触发刷新。
- **f.req 槽位随发版漂移**:集中在 `reqbuild.js`,fixture 定位,跟版微调(非上浏览器)。
- **即梦 a_bogus 绑 bdms 版本**(P3):纯算失效时 Node-VM 跑官方脚本兜底。
- **cookie 掉线 / 风控**:明确退出码(2/4/5)与错误信息;不做规避,失败即如实报。
- **账号权限**:Gemini Veo 需订阅/权限;即梦每日 66 积分,生成前查/领。

## 8. Spec 拆分

- 本 spec:地基(http/auth/test 骨架)+ Gemini(P0–P2)。
- 即梦(P3)、豆包(P4)各自单独 spec + plan + 实现循环,复用本 spec 建立的传输/凭据/契约/测试骨架。

## 9. 决策(P0 实测后敲定,见 `recon/2026-07-02-gemini-direct-http-P0.md`)

- 凭据来源:**① 从 Chrome profile 自动读(主)→ ② 浏览器登录抓取(兜底)→ ③ 手动粘贴**。OAuth 不采用。**P0 已验证 Chrome 导入可行**(本机 v10 加密、非 App-Bound)。
- Gemini 传输后端:**Node 内置 `fetch`(undici)**,P0 实测未被 TLS/JA3 指纹拦,不引 curl-impersonate。
- 反滥用 token:**确认不需要**(P0 普通生成 200 通过)。
- 默认 profile:`Profile 1`(google/doubao/jimeng 登录齐全),命令支持 `--profile`。
