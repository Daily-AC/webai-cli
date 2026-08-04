# Hunyuan 3D Studio (`/studio`, `/api/game3d/*`) — protocol recon

Measured 2026-08-04 against the live site with the same ordinary WeChat-login
account used for the playground recon (`userType: external`, no paid plan, not
whitelisted for anything). Everything is pure HTTP over the existing Hunyuan
cookies. Implementation: `src/providers/hunyuan/studio.js`, CLI `webai studio …`.

**This is where rigging lives.** `3d.hunyuan.tencent.com` serves two unrelated
products from one origin:

| | playground (legacy) | 3D Studio |
|---|---|---|
| route | `/`, `/lowpoly`, `/sketchTo3D`, … | `/studio/creation/{role,props}/…` |
| SPA | webpack bundle on `cdn-3d-prod.hunyuan.tencent.com` | Vite bundle on `game-3d.qstatic.com/game3d/` |
| API | `/api/3d/*` | `/api/game3d/*` |
| auth | cookies + signed query on submit | cookies only |
| envelope | bare JSON, `code`/`message` on failure | `{errNo, errMsg, data}` |
| unit of work | `creationsId` | `worksId` |

Finding it took reading the second bundle: the playground bundle *does* contain
`creations/boneBindingFromMesh` / `manualBoneBinding` / `retopologize`, but
those are dead code — all four still answer `404 page not found`. The live
implementation is a different service under a different prefix.

## Transport

Plain axios, `baseURL: "/api"`, 600 s timeout, no interceptors beyond two: one
that renames `fbxUrl` → `glbUrl` when the value ends in `.glb`, and one that
stamps a `requestId` UUID onto every request body. No signature, no
`x-source`/`x-product` headers, no PoW. Credentials are the same
`hunyuan_token` cookie the playground uses, so `webai auth import chrome hunyuan`
covers both products.

Failures arrive as HTTP 400 with `{errNo, errMsg}`. Codes seen:

| errNo | meaning |
|---|---|
| 200001 / 200002 | `输入参数错误` — wrong field names, or an asset URL outside the studio's own bucket |
| 200004 | `仅支持人形标准化` — from `character_validations` |
| 200005 | `仅支持人形标准化` — from `bone_skinning` itself |
| 200010 | `审核失败，请重新输入` — moderation rejected the submitted asset URL |

The two humanoid checks are **not** the same gate: `character_validations` can
answer `{status: 0}` on a mesh that `bone_skinning` then rejects with 200005.
Measured on a chibi character (huge head, stub limbs, no neck, arms at ~40°):
validation passed, rigging refused. Treat validation as a cheap pre-filter, not
a guarantee — the rigger wants limb chains it can separate, so a true T-pose
with the arms horizontal and the legs apart matters more than the label.

## The pipeline

`worksPipeline` numbers the node that produced a work, and the UI is one page
per node under `/studio/creation/role/<path>`:

| # | node | path | endpoint |
|---|---|---|---|
| 1 | 概念设计 concept design | `concept` | `concept_design/text2image`, `concept_design/image2views` |
| 2 | 几何生成 geometry | `geo` | `geometry_generation/{text2geometry,image2geometry,image2geometry_singleimage,image2geometry_views,views2geometry,5views2geometry}` |
| 3 | 组件拆分 component split | `component` | `component_splitting/v2/{pre_segmentation,part_split,smooth_segmentation}`, `v1_5/part_split`, `part_merge`, `part_adjust`, `update_component_splitting` |
| 4 | 低模拓扑 retopology | `poly` | `low_poly_topology/low_poly_topology` |
| 5 | UV展开 UV unwrap | `uv` | `uv_unwrapping/uv_unwrapping` |
| 6 | 纹理绘制 texture paint | `texture` | `texture_painting/{text2texture,image2texture,views2texture,*_v31,views2texture_v35,texture_edit_local,texture_segmentation,update_texture_painting}` |
| **7** | **绑骨蒙皮 rigging & skinning** | `rs` | **`bone_skinning/bone_skinning`** |
| **8** | **动画生成 animation** | `ae` | **`motion_retarget/motion_retarget`, `motion_generation/text2motion`, `motion_generation/video2motion`** |

Shared endpoints:

```
POST /api/game3d/general_info/get_remaining_times   daily quota  -> {remainingTimes}
POST /api/game3d/general_info/get_works_list        poll/browse  {worksPipeline,worksIds,pipelineStatus,limit,offset}
POST /api/game3d/general_info/delete_works          {worksIds}
POST /api/game3d/general_info/get_motion_case       the built-in action library
POST /api/game3d/general_info/get_good_case         {node,tag} showcase entries
POST /api/game3d/resource/upload                    {fileName} -> temporary COS credentials
POST /api/game3d/resource/format_conversions        {glbUrl|fbxUrl, fmt} -> {rspUrl}
POST /api/game3d/resource/character_validations     {fbxUrl} -> {status}   0 = humanoid
POST /api/game3d/resource/download                  {fbxUrl, fmt} -> blob
POST /api/game3d/share/create                       {worksId, modelUrl}
POST /api/new-portal/whitelist/query                {business:"3dgame",scene:"all"}
```

`pipelineStatus`: 0 pending · 1 processing · 2 success · 3 failed · 4 cancel ·
5 deleted. Poll `get_works_list` with `{worksIds:[id]}`; the site polls every 3 s
while a job is near its `estimatedTimeCost` and every 10 s otherwise.

Quota is finally readable here — `get_remaining_times` returned `30` and
decremented by one per submitted job (the playground's `/api/3d/quotainfo` still
answers HTTP 500 for every body shape).

## Rigging

```
POST /api/game3d/bone_skinning/bone_skinning
{ "fbxUrl": "...", "isWithBone": false, "isKeepBone": false,
  "dependOnWorksId": "", "requestId": "<uuid>" }
-> { "worksId": "...", "requestId": "..." }        // bare, no {data} envelope
```

`isWithBone` declares that the input already carries a skeleton; `isKeepBone`
then chooses between preserving it and predicting a fresh one. The web UI only
asks the "keep or replace" question when it detected a skeleton in the loaded
model.

On success the work carries:

```json
"modelInfo": { "boneSkinningRsp": {
  "rigFbxUrl": "…fbx", "rigImageUrl": "…png",
  "isCharacter": true, "isKeepBone": false } }
```

`workFlow: hunyuan-3d-auto-rigging-gamestudio`, `estimatedTimeCost: 30`.

Constraints, both real:

- **Humanoid only.** `character_validations` runs the same check up front and
  answers `200004 仅支持人形标准化` for props and non-humanoid creatures. The UI
  copy says the same: 道具类等非人形角色模型，不支持绑骨蒙皮.
- **≤ 500 000 triangles.** The UI greys the button out above that
  (`error.modelFaceCountExceedBoneSkinning`). A playground text-to-3D mesh is
  ~1.5 M triangles, so it must be decimated (or run through the `poly` node)
  first. `studio.glbTriangleCount()` does the preflight locally by reading the
  glb JSON chunk, so an over-budget mesh never burns a credit.

**Input must live in the studio's own bucket.** Handing `format_conversions` or
`bone_skinning` a URL on Hunyuan's *playground* CDN — same company, same account,
publicly readable — is answered `200001 输入参数错误` / `200010 审核失败`.
`resource/upload` returns temporary COS credentials for `tts-1258344706` under
`/3DGameStudio/<userId>/`, and the same COS v5 signature the playground uses
(`src/providers/hunyuan/cos.js`) works unchanged. Note the response uses
`bucket`/`expireTime` where the playground uses `bucketName`/`expiredTime`.

### Verified output

`webai studio rig` on a decimated 150 k-triangle character (a playground
text-to-3D swordsman), inspected in Blender:

- 1 armature, **28 bones**, Mixamo naming and hierarchy:
  `root → Hips → Spine/Spine1/Spine2 → Neck → Head`, `LeftShoulder → LeftArm →
  LeftForeArm → LeftHand`, `LeftUpLeg → LeftLeg → LeftFoot → LeftToeBase`
  (mirrored on the right), each limb chain ending in a `_end` tip bone.
- Armature modifier bound, 22 vertex groups, and **152 469 / 152 469 vertices
  carry a non-zero skin weight** — the skinning is complete, not partial.
- `rigImageUrl` is a render of the skeleton overlaid on the model.

Because the naming is Mixamo-standard, the result retargets directly against
Mixamo/UE/Unity humanoid rigs without a bone map.

## Animation

Three ways in, all producing a `worksPipeline: 8` work:

```
POST /api/game3d/motion_retarget/motion_retarget
{ "motionType": "<m_uid>", "fbxUrl": "<rigged fbx>",
  "dependOnWorksId": "<rig worksId>", "imageUrl": "" }

POST /api/game3d/motion_generation/text2motion
{ "textPrompt": "...", "duration": <s>, "disableRewrite": false,
  "retargetFbx": "<rigged fbx>", "dependOnWorksId": "..." }

POST /api/game3d/motion_generation/video2motion
{ "videoUrl": "...", "retargetFbx": "<rigged fbx>", "dependOnWorksId": "..." }
```

`motionType` is the **`m_uid`** from `get_motion_case`, not `m_id`. That library
returned **47 actions** — combat (回旋踢, 左勾拳, 蓄力攻击, 二连击打, 刺拳, 侧踢,
受击/受击倒地, 落地), locomotion (走路 ×3, 慢跑 ×2, 奔跑, 冲刺跑 ×3, 滑铲, 左/右
转弯, 原地跳, 向前大跳 ×2), and performance (打太极, 街舞, 扭扭舞, 后空翻,
蹲姿转体, 待机 ×2, 沮丧) — each with `m_image_url`, `m_gif_url` and a source
`m_fbx_url`.

`disableRewrite: false` lets the server rewrite a Chinese prompt into its
canonical English form and infer the duration; `true` requires a standard
English prompt and an explicit duration.

Result:

```json
"modelInfo": { "motionRetargetRsp": {
  "fbxUrl": "…fbx",                        // animated
  "oriFbxUrl": "…fbx",                     // the rigged input
  "imageUrl": "…png",
  "historyFbxUrl": { "<m_uid>": "…fbx" } } }   // one entry per action applied
```

`workFlow: hunyuan-3d-motion-retarget-v2.0`, ~30 s. `historyFbxUrl` accumulates,
so one rigged work can carry a whole action set and the UI offers each again
without re-running.

Verified in Blender: the animated fbx keeps the 28-bone armature and full
skinning and adds one action, `Armature|Armature|<m_uid>_remap`.

## Verified end to end

- `webai studio quota` → `30 runs remaining`, decrementing per job.
- `webai studio rig <glb> --wait --out <dir>` → preflight (150 000 triangles) →
  COS upload → glb→fbx conversion → humanoid validation → rig → poll → rigged
  fbx + skeleton png downloaded. ~50 s.
- `webai studio animate <rigWorksId> --motion 打太极 --wait --out <dir>` →
  animated fbx + cover png. ~30 s.
- `webai studio motions` → 47 actions; `webai studio list` → both works with
  node and status.
- 10 unit tests in `test/hunyuan-studio.test.js` (pipeline/status enums,
  endpoint paths, work normalization including the JSON-string `inputInfo`,
  per-node output extraction, glb triangle preflight), 268/268 for the suite.

## Not wired up

Reachable but unimplemented in the CLI, in rough order of usefulness:
`low_poly_topology` (would remove the local decimation step),
`geometry_generation/*` (studio-native text/image → mesh, likely a newer model
than the playground's V3.1), `component_splitting/*`, `uv_unwrapping`,
`texture_painting/*`, `concept_design/*`. All follow the same
submit → `worksId` → `get_works_list` shape, so adding one is a payload and an
output key.
