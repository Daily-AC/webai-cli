# Hunyuan 3D (3d.hunyuan.tencent.com) — protocol recon

Measured 2026-07-30 against the live site with an ordinary WeChat-login account
(`userType: external`, no paid plan). Everything below is pure HTTP: no browser,
no headless Chrome, no PoW. Implementation: `src/providers/hunyuan/`, CLI
`webai model3d hunyuan …`.

> **2026-08-04:** the site hosts a *second, separate* product — **3D Studio** at
> `/studio`, a different SPA on a different API prefix (`/api/game3d/…`). That
> is where auto-rigging and animation actually live, and both work on this same
> ordinary account. See "3D Studio" below. The "What is closed" section's verdict
> on rigging applies only to the legacy `/api/3d/` surface documented here.

## Transport

Same-origin JSON under `https://3d.hunyuan.tencent.com/api/3d/`. The web app's
axios instance is created with `baseURL: "/"`, `withCredentials: true` and two
fixed headers, `x-source: web` and `x-product: hunyuan3d`. One extra header,
`x_hunyuan_inner_user_id`, is copied from the `hy_user` cookie.

Credentials are ordinary cookies, no bearer token:

| cookie | host | role |
|---|---|---|
| `hunyuan_token` | `.tencent.com` | session (required) |
| `hunyuan_user` | `.tencent.com` | user id |
| `hunyuan_source` | `.tencent.com` | entry channel |
| `hy_user` | `3d.hunyuan.tencent.com` | inner user id, also sent as a header |

`webai auth import chrome hunyuan` imports them. Note the apex-domain filter:
`hostFilter` must be `tencent.com`, and the cookie jar then drops the
`cloud.`/`meeting.` siblings by URL matching.

Reading the Chrome cookie DB for this provider exposed a latent bug in the
importer: Tencent sets `expires_utc` values past year 2100, which as
microseconds-since-1601 exceed `Number.MAX_SAFE_INTEGER`, and `node:sqlite`
refuses to return those as numbers ("Value is too large to be represented as a
JavaScript number"), failing the whole import. Fixed by selecting
`CAST(expires_utc AS TEXT)`.

## Endpoints

```
GET  /api/3d/getuserinfo                     account identity
GET  /api/3d/config                          ~400 KB of presets, good-cases, prompt examples
GET  /api/3d/interaction/config              panorama/scene good-cases
POST /api/3d/creations/generations           submit a job   (SIGNED, see below)
POST /api/3d/creations/list                  poll / browse  {limit,offset,sceneTypeList,modelTypeList} or {creationsIdList}
GET  /api/3d/creations/detail?creationsId=   single job
POST /api/3d/creations/cancel                {creationsId}
POST /api/3d/creations/delete                {creationsIdList}
POST /api/3d/resource/genUploadInfo          {fileName} -> temporary COS credentials
POST /api/3d/resource/review                 prompt/image moderation
POST /api/3d/worldScene/review               scene-prompt moderation
```

Present in the bundle but **not deployed** (see "What is closed" below):
`creations/boneBindingFromMesh`, `creations/manualBoneBinding`,
`creations/manualBoneBindingFromMesh`, `creations/retopologize`.

## Request signature

`creations/generations` is the only signed call. The site's axios interceptor
takes the request's query params, adds `timestamp` (unix seconds) and `nonce` (16
random alphanumerics), sorts all entries by key, joins them `k=v&k=v`, and puts
`HMAC-SHA256` of that string in `sign` — all three go in the **query string**,
not the body.

The HMAC key is not a literal in the bundle. It is derived from a 16-byte array
by XOR-ing with a second array, rotating each byte left by a per-position
amount, permuting, and cutting at the first NUL byte. `src/providers/hunyuan/sign.js`
keeps the four constant arrays and reproduces the derivation, so a rotated
constant stays diffable against the source; the current result is the 10-char
key `Hf6d6KFB3D`.

There is no PoW, no device fingerprint, no `a_bogus`-style anti-abuse token.

## Generation payloads

One endpoint drives every pipeline; the `sceneType` + `modelType` pair selects it.

```json
{ "sceneType": "playGround3D-2.0", "modelType": "text2ModelV3.1",
  "count": 4, "prompt": "…", "title": "…", "enable_pbr": true }
```

Other fields seen across pipelines: `imageList[]`, `imageTagList`, `videoList[]`,
`style`, `negativePrompt`, `enableLowPoly`, `enableScaleStandardization`
(the site ties this to its "is T-pose" toggle), `faceCount`, `polygon_type`,
`modelUrl3D: {type,url}`, `mesh: {fbx,glb,image_url}`, `motionType`, `keep_uv`,
`templateId`, `mapId`, `lpmAssetId`, `geometryCreationsId`.

`count` is validated per pipeline and anything else is rejected with
`count param error`: **text-to-3D must send 4** (it returns a 4-candidate batch),
every other pipeline takes 1.

Response is `{creationsId}`. Poll `creations/list` with `{creationsIdList:[id]}`;
`status` walks `wait → processing → success|fail`, and each of the `result[]`
entries carries a `urlResult` of pre-signed COS URLs (valid ~1 year) —
`glb`/`obj`/`png` for meshes, `ply`/`image_url`/`video_url` for scenes and
panoramas, plus `intermediate_outputs.geometry` for geometry-only stages.

### Modes wired into the CLI

| mode | sceneType | modelType (default) |
|---|---|---|
| `text` | `playGround3D-2.0` | `text2ModelV3.1` |
| `image` | `playGround3D-2.0` | `image2ModelV3.1` / `multiView2ModelV3.1` |
| `lowpoly` | `lowPoly` | `text2ModelLowPolyV3.1` / `image2ModelLowPolyV3.1` |
| `sketch` | `sketchGenerate` | `modelSketchV3.1` |
| `texture` | `textureGenerate` | `textureV3.1` |
| `panorama` | `interaction` | `text2panorama-wf-v2.1` / `image2panorama-wf-v2.1` |
| `scene` | `interaction` | `text2scene-wf-v2.1` / `image2scene-wf-v2.1` |
| `reconstruct` | `interaction` | `sceneReconstruction-wf` |
| `animate` | `3dAnimation` | `actionDriven` |

`motionType` values for `animate`, recovered from the site's own animation
good-cases (each preview gif names its action): 9 Capoeira, 10 FallingBackDeath,
11 Jumping, 12 Kicking, **13 OneHandSwordCombo**, 15 TreadmillRunning,
16 TwistDance.

## Reference-image upload

`resource/genUploadInfo` returns `{bucketName, region, location,
encryptTmpSecretId, encryptTmpSecretKey, encryptToken, startTime, expiredTime}`
— despite the `encrypt*` names these are plain temporary COS credentials. The
file is then `PUT` to `https://<bucket>.cos.<region>.myqcloud.com/<location>`
with a COS v5 signature (`q-sign-algorithm=sha1`) plus
`x-cos-security-token`. `src/providers/hunyuan/cos.js` implements it directly;
no `cos-js-sdk` needed.

## What is closed on an ordinary account

Verified, not inferred — each of these was probed directly:

- **V3.5 pipelines**: `text2ModelV3.5` (and siblings) answer
  `{"error":"该功能暂未开放，敬请期待"}`. Highest usable version is V3.1. The CLI
  therefore defaults to V3.1 and only sends V3.5 when `--version 3.5` is explicit.
- **Pre-2.0 scene types**: `sceneType: playGround3D` with any modelType answers
  `配置获取失败:configInfo not found`. Use `playGround3D-2.0`.
- **The whole animation line — on this prefix only**: `sceneType: 3dAnimation` +
  `modelType: actionDriven` answers `configInfo not found`, even when handed one
  of the Mixamo-style pre-rigged template FBXs from the site's own
  `animation3dConfigV2.templates` with the byte-exact payload the animation page
  builds. And the three bone-binding routes plus `retopologize` all answer
  `404 page not found`, while same-prefix siblings (`creations/count`,
  `creations/resourceConvert`) answer 400 parameter errors — so the router
  prefix is live and those handlers are simply not deployed. Re-verified
  2026-08-04: unchanged. The frontend bundle still calls them, so they are dead
  code on the legacy surface.

  **This does not mean rigging is unavailable.** It moved: the shipping
  implementation is the 3D Studio pipeline on `/api/game3d/`, verified working
  end to end on this account (below). The 2026-07-30 conclusion "auto-rigging
  and motion driving are not reachable through this account" was wrong about the
  product, right about the endpoint.
- **Quota introspection**: `POST /api/3d/quotainfo` and `GET
  /api/3d/planCreditInfo` return HTTP 500 for every body shape tried (empty,
  per-sceneType, per-modelType, query-string variants). Generation itself works,
  so remaining free-quota simply cannot be read. `GET` on quotainfo is 405, so
  the route exists.

## Output weight

Text-to-3D V3.1 returns roughly **1.5 M triangles, single mesh, one material,
three 2–4K PNG maps, 84–91 MB per glb**. Anything web-facing needs decimation
first; `faceCount` at submit time and the (undeployed) `retopologize` endpoint
are the server-side levers, otherwise decimate locally.

## Verified end to end

- `webai auth import chrome hunyuan` → 10 cookies.
- `webai model3d hunyuan submit text "…" --pbr` → `creationsId`.
- `webai model3d hunyuan status <id> --all --out <dir>` → 4 candidates ×
  (glb + obj + png) downloaded.
- `webai model3d hunyuan list` → status/modelType/file-kind table.
- 17 unit tests in `test/hunyuan.test.js` (signature key derivation, canonical
  string, payload shapes per mode, response normalization, COS signature),
  258/258 for the whole suite.
