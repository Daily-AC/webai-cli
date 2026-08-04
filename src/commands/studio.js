// webai studio — Hunyuan 3D Studio game-asset pipeline (auto-rigging + animation).
import { existsSync } from 'node:fs';
import studio from '../providers/hunyuan/studio.js';
import { WebaiError, PendingError, QuotaError } from '../errors.js';
import { resolveOutPath, timestamp } from './media-util.js';

const NODE_BY_NAME = {
  all: 0, concept: 1, geometry: 2, component: 3, poly: 4, uv: 5, texture: 6, rigging: 7, animation: 8,
};

function usage() {
  process.stderr.write(`webai studio — Hunyuan 3D Studio pipeline (auto-rig + animation)

Usage:
  webai studio rig <file|url> [--keep-bone] [--wait] [--out <dir>]
  webai studio animate <rig-works-id> --motion <name|uid> [--wait] [--out <dir>]
  webai studio animate <rig-works-id> --prompt "<text>" [--duration <s>] [--wait]
  webai studio animate <rig-works-id> --video <url> [--wait]
  webai studio motions [--json]
  webai studio status <works-id> [--out <dir>] [--once] [--json]
  webai studio list [--node rigging] [--limit 20] [--json]
  webai studio quota
  webai studio upload <file>
  webai studio convert <url> [--fmt fbx|glb]
  webai studio delete <works-id...>

rig
  Takes a local .glb/.fbx (uploaded automatically) or a URL already inside the
  studio bucket, and returns a 28-bone Mixamo-named humanoid skeleton with the
  mesh skinned to it. Only A/T-pose humanoid characters are accepted; props and
  non-humanoid creatures are rejected server-side. Meshes above
  ${studio.MAX_RIG_FACES.toLocaleString('en-US')} triangles are refused — decimate first.

animate
  Retargets an action onto a rigged work. Pick a template with --motion (see
  "webai studio motions"), describe one with --prompt, or transfer motion from a
  reference clip with --video.

Options:
  --keep-bone      keep the input's existing skeleton instead of predicting one
  --with-bone      declare that the input already carries a skeleton
  --motion <m>     motion template: uid, or a name from "webai studio motions"
  --prompt <t>     text-to-motion prompt
  --duration <s>   text-to-motion length in seconds
  --video <url>    video-to-motion reference clip
  --mesh-fbx <url> rigged fbx to animate, when not passing a works id
  --node <n>       (list) pipeline node: ${Object.keys(NODE_BY_NAME).join('|')}
  --fmt <f>        (convert) target format, default fbx
  --wait           poll until the job finishes, then download the result
  --out <path>     output file or directory
  --once           (status) poll once; exit 3 if still generating
  --json           JSON output
`);
}

export async function studioCmd(args) {
  const action = args.positional[0];
  switch (action) {
    case 'rig': return rig(args);
    case 'animate': return animate(args);
    case 'motions': return listMotions(args);
    case 'status': return status(args);
    case 'list': return listWorks(args);
    case 'quota': return quota(args);
    case 'upload': return upload(args);
    case 'convert': return convert(args);
    case 'delete': return remove(args);
    default:
      usage();
      throw new WebaiError('webai studio: expected rig, animate, motions, status, list, quota, upload, convert, or delete');
  }
}

// A local path is uploaded into the studio bucket; a URL is passed through. The
// pipeline works on fbx, so a glb source is converted server-side first.
async function resolveMesh(value, { wantFbx = true } = {}) {
  let url = value;
  if (!/^https?:\/\//.test(value)) {
    if (!existsSync(value)) throw new WebaiError(`webai studio: file not found: ${value}`);
    const triangles = studio.glbTriangleCount(value);
    if (triangles !== null) {
      process.stderr.write(`${value}: ${triangles.toLocaleString('en-US')} triangles\n`);
      if (triangles > studio.MAX_RIG_FACES) {
        throw new WebaiError(
          `webai studio rig: ${triangles.toLocaleString('en-US')} triangles exceeds the ` +
            `${studio.MAX_RIG_FACES.toLocaleString('en-US')} limit — decimate the mesh first`
        );
      }
    }
    process.stderr.write(`uploading ${value} …\n`);
    url = await studio.uploadModel(value);
  }
  if (wantFbx && !/\.fbx(\?|$)/i.test(url)) {
    process.stderr.write('converting to fbx …\n');
    url = await studio.convert(url, 'fbx');
  }
  return url;
}

async function rig(args) {
  const input = args.positional[1];
  if (!input) {
    usage();
    throw new WebaiError('webai studio rig: a local file or an asset URL is required');
  }
  const fbxUrl = await resolveMesh(input);

  process.stderr.write('checking the model is a standard humanoid …\n');
  await studio.validateCharacter(fbxUrl);

  const { worksId } = await studio.rig({
    fbxUrl,
    withBone: Boolean(args.withBone),
    keepBone: Boolean(args.keepBone),
  });
  return finishJob(args, worksId, { action: 'rig', fbxUrl });
}

async function animate(args) {
  const dependOnWorksId = args.positional[1] && !args.positional[1].startsWith('--') ? args.positional[1] : '';
  let fbxUrl = args.meshFbx || '';
  if (!fbxUrl && dependOnWorksId) {
    const source = await studio.work(dependOnWorksId);
    if (!source) throw new WebaiError(`webai studio animate: no work found for ${dependOnWorksId}`);
    fbxUrl = source.files.fbx || '';
    if (!fbxUrl) throw new WebaiError(`webai studio animate: work ${dependOnWorksId} exposes no rigged fbx`);
  }
  if (!fbxUrl && !args.video) {
    usage();
    throw new WebaiError('webai studio animate: pass a rigged works id or --mesh-fbx <url>');
  }

  let worksId;
  if (args.prompt) {
    ({ worksId } = await studio.textToMotion({
      prompt: args.prompt,
      duration: args.duration,
      retargetFbx: fbxUrl,
      dependOnWorksId,
    }));
  } else if (args.video) {
    ({ worksId } = await studio.videoToMotion({
      videoUrl: args.video,
      retargetFbx: fbxUrl,
      dependOnWorksId,
    }));
  } else {
    const motionType = await resolveMotion(args.motion);
    ({ worksId } = await studio.retarget({ motionType, fbxUrl, dependOnWorksId }));
  }
  return finishJob(args, worksId, { action: 'animate' });
}

async function resolveMotion(value) {
  if (!value) {
    throw new WebaiError('webai studio animate: pass --motion <name|uid>, --prompt "<text>", or --video <url>');
  }
  if (/^[0-9a-f]{32}$/i.test(value)) return value;
  const list = await studio.motions();
  const exact = list.find((m) => m.name === value);
  if (exact) return exact.uid;
  const partial = list.filter((m) => m.name.includes(value) || m.uid.startsWith(value));
  if (partial.length === 1) return partial[0].uid;
  if (partial.length > 1) {
    throw new WebaiError(
      `webai studio animate: "${value}" matches ${partial.length} motions (${partial.map((m) => m.name).join(', ')})`
    );
  }
  throw new WebaiError(`webai studio animate: no motion named "${value}" — see "webai studio motions"`);
}

async function finishJob(args, worksId, meta) {
  if (!args.wait) {
    if (args.json) process.stdout.write(JSON.stringify({ ...meta, worksId }, null, 2) + '\n');
    else {
      process.stdout.write(worksId + '\n');
      process.stderr.write(`\n— ${meta.action} submitted. Poll with:\n    webai studio status ${worksId} --out ./out\n`);
    }
    return;
  }
  await status({ ...args, positional: ['status', worksId] });
}

async function status(args) {
  const worksId = args.positional[1];
  if (!worksId) {
    usage();
    throw new WebaiError('webai studio status: a works id is required');
  }
  const deadline = Date.now() + (args.once ? 0 : 1_800_000);
  let state;
  while (true) {
    state = await studio.poll(worksId);
    if (state.status === 'ready') break;
    if (state.status === 'failed') {
      throw new WebaiError(`hunyuan studio ${worksId} failed: ${state.reason || 'unknown'}`);
    }
    if (args.once) {
      const label = state.work?.statusName || 'pending';
      if (args.json) process.stdout.write(JSON.stringify({ worksId, ready: false, status: label }, null, 2) + '\n');
      else process.stdout.write(`${label} — not ready yet (works ${worksId})\n`);
      throw new PendingError(`hunyuan studio ${worksId} still generating`);
    }
    if (Date.now() > deadline) throw new PendingError(`hunyuan studio ${worksId} still generating after timeout`);
    process.stderr.write(`  ${state.work?.statusName || 'pending'} …\n`);
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const done = state.work;
  const stamp = timestamp();
  const downloads = [];
  const kinds = Object.entries(done.files);
  for (const [kind, url] of kinds) {
    const name = `HunyuanStudio_${done.nodeName}_${worksId.slice(-8)}_${stamp}.${kind === 'image' ? 'png' : kind}`;
    const dest = resolveOutPath(args.out, name, { forceDir: kinds.length > 1 });
    downloads.push({ kind, url, path: await studio.download(url, dest) });
  }
  if (!downloads.length) throw new WebaiError(`hunyuan studio ${worksId} finished but exposed no downloadable file`);

  if (args.json) process.stdout.write(JSON.stringify({ worksId, ready: true, work: done, downloads }, null, 2) + '\n');
  else for (const d of downloads) process.stdout.write(d.path + '\n');
}

async function listWorks(args) {
  const node = args.node ? NODE_BY_NAME[args.node] ?? Number(args.node) : undefined;
  const { total, works } = await studio.worksList({
    node,
    limit: args.limit ? Number(args.limit) : undefined,
    offset: args.offset ? Number(args.offset) : undefined,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify({ total, works }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`total ${total ?? works.length}\n`);
  for (const w of works) {
    const kinds = Object.keys(w.files).join(',') || '-';
    process.stdout.write(`${w.worksId}  ${w.statusName.padEnd(10)} ${w.nodeName.padEnd(10)} ${kinds.padEnd(12)} ${w.workFlow}\n`);
  }
}

async function listMotions(args) {
  const list = await studio.motions();
  if (args.json) {
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    return;
  }
  for (const m of list) process.stdout.write(`${m.uid}\t${m.name}\n`);
}

async function quota(args) {
  const remaining = await studio.remainingTimes();
  if (args.json) process.stdout.write(JSON.stringify({ remainingTimes: remaining }, null, 2) + '\n');
  else process.stdout.write(`${remaining} runs remaining\n`);
  if (remaining === 0) throw new QuotaError('hunyuan studio: no runs remaining today');
}

async function upload(args) {
  const path = args.positional[1];
  if (!path) throw new WebaiError('webai studio upload: a file path is required');
  const url = await studio.uploadModel(path);
  if (args.json) process.stdout.write(JSON.stringify({ path, url }, null, 2) + '\n');
  else process.stdout.write(url + '\n');
}

async function convert(args) {
  const url = args.positional[1];
  if (!url) throw new WebaiError('webai studio convert: an asset URL is required');
  const out = await studio.convert(url, args.fmt || 'fbx');
  if (args.json) process.stdout.write(JSON.stringify({ from: url, to: out }, null, 2) + '\n');
  else process.stdout.write(out + '\n');
}

async function remove(args) {
  const ids = args.positional.slice(1);
  if (!ids.length) throw new WebaiError('webai studio delete: at least one works id is required');
  await studio.deleteWorks(ids);
  process.stdout.write(`deleted ${ids.length}\n`);
}

export default studioCmd;
