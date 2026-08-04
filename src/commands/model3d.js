// webai model3d hunyuan <action> — direct-HTTP 3D asset generation.
import { existsSync } from 'node:fs';
import hunyuan from '../providers/hunyuan/index.js';
import { MOTIONS, SCENE } from '../providers/hunyuan/reqbuild.js';
import { pickFile, DEFAULT_KIND_ORDER } from '../providers/hunyuan/parse.js';
import { WebaiError, PendingError, ContentRejectedError, QuotaError } from '../errors.js';
import { resolveOutPath, timestamp } from './media-util.js';

const PROVIDERS = { hunyuan };

const MODES = ['text', 'image', 'lowpoly', 'sketch', 'texture', 'panorama', 'scene', 'reconstruct', 'animate'];

function usage() {
  process.stderr.write(`webai model3d — generate 3D assets (direct HTTP)

Usage:
  webai model3d hunyuan submit <mode> ["<prompt>"] [options]
  webai model3d hunyuan status <job-id> [--out <path>] [--kind glb] [--all] [--once] [--json]
  webai model3d hunyuan list [--limit 20] [--offset 0] [--json]
  webai model3d hunyuan quota [--json]
  webai model3d hunyuan bind --mesh-glb <url> [--image <url>] [--json]
  webai model3d hunyuan upload <file> [--json]
  webai model3d hunyuan motions

Modes: ${MODES.join(', ')}
  text        prompt -> textured mesh (glb)
  image       one image -> mesh; several --image flags -> multi-view mesh
  lowpoly     prompt or image -> low-poly mesh
  sketch      line-art image -> mesh
  texture     re-texture an existing mesh (--mesh-glb + prompt)
  panorama    prompt or image -> 360 panorama
  scene       prompt or image -> explorable 3D scene
  reconstruct several photos (or one video) of a real place -> 3D scene
  animate     rigged fbx + motion -> animated glb (see "motions")

Options:
  --image <path|url>   input image; repeat for multi-view. Local paths are uploaded.
  --video <path|url>   input video (reconstruct)
  --count <n>          results to generate (default 1)
  --version <v>        pipeline version, e.g. 3.5, 3.1, 2.1
  --title <t>          creation title (defaults to the prompt)
  --style <s>          style preset id
  --negative <t>       negative prompt
  --pbr                request PBR materials
  --tpose              standardize scale/pose (the site's "is T-pose" toggle);
                       required if the mesh is going on to "webai studio rig"
  --lowpoly            request low-poly output
  --faces <n>          target face count
  --motion <n>         motionType for animate (13 = one-hand sword combo)
  --mesh-glb <url>     source mesh glb (texture / animate / bind)
  --mesh-fbx <url>     rigged fbx (animate)
  --kind <k>           (status) file to download: ${DEFAULT_KIND_ORDER.join('|')}
  --all                (status) download every result and every available file kind
  --out <path>         (status) output file or directory
  --once               (status) poll once; exit 3 if still generating
  --json               JSON output
`);
}

export async function model3d(args) {
  const providerId = args.positional[0];
  const provider = PROVIDERS[providerId];
  if (!provider) {
    usage();
    throw new WebaiError(`webai model3d: expected "hunyuan" (got "${providerId || ''}")`);
  }
  const action = args.positional[1];
  switch (action) {
    case 'submit': return submit(provider, providerId, args);
    case 'status': return status(provider, providerId, args);
    case 'list': return listCreations(provider, args);
    case 'quota': return showQuota(provider, args);
    case 'bind': return bind(provider, args);
    case 'upload': return upload(provider, args);
    case 'motions': return showMotions(args);
    default:
      usage();
      throw new WebaiError('webai model3d: expected submit, status, list, quota, bind, upload, or motions');
  }
}

// Local paths go through COS first; anything that already looks like a URL is
// passed straight through.
async function resolveInputs(provider, values = []) {
  const out = [];
  for (const value of values) {
    if (/^https?:\/\//.test(value)) {
      out.push(value);
      continue;
    }
    if (!existsSync(value)) throw new WebaiError(`webai model3d: input file not found: ${value}`);
    process.stderr.write(`uploading ${value} …\n`);
    out.push(await provider.uploadFile(value));
  }
  return out;
}

async function submit(provider, providerId, args) {
  const mode = args.positional[2];
  if (!MODES.includes(mode)) {
    usage();
    throw new WebaiError(`webai model3d submit: expected a mode (${MODES.join(', ')}), got "${mode || ''}"`);
  }
  const prompt = args.positional.slice(3).join(' ').trim();
  const images = await resolveInputs(provider, args.images || []);
  const video = args.video ? (await resolveInputs(provider, [args.video]))[0] : undefined;

  const opts = { prompt, images, video };
  if (args.count) opts.count = Number(args.count);
  if (args.version) opts.version = String(args.version);
  if (args.title) opts.title = args.title;
  if (args.style) opts.style = args.style;
  if (args.negative) opts.negativePrompt = args.negative;
  if (args.pbr) opts.pbr = true;
  if (args.tpose) opts.scaleStandardization = true;
  if (args.lowpolyFlag) opts.lowpoly = true;
  if (args.faces) opts.faceCount = Number(args.faces);
  if (args.motion !== undefined) opts.motionType = Number(args.motion);
  if (args.meshFbx) opts.modelUrl3D = { type: 'fbx', url: args.meshFbx };
  else if (args.meshGlb && mode === 'texture') opts.modelUrl3D = { type: 'glb', url: args.meshGlb };
  if (mode === 'animate' && (args.meshGlb || args.meshFbx)) {
    opts.mesh = { fbx: args.meshFbx, glb: args.meshGlb, image_url: images[0] || '' };
  }
  if (!prompt && !images.length && !video && mode !== 'animate') {
    throw new WebaiError(`webai model3d submit ${mode}: a prompt or an --image is required`);
  }

  const { jobId, body } = await provider.submit(mode, opts);
  if (args.json) {
    process.stdout.write(JSON.stringify({ provider: providerId, mode, jobId, request: body }, null, 2) + '\n');
  } else {
    process.stdout.write(jobId + '\n');
    process.stderr.write(`\n— ${mode} job submitted. Poll with:\n    webai model3d ${providerId} status ${jobId} --out ./out\n`);
  }
}

async function status(provider, providerId, args) {
  const jobId = args.positional[2];
  if (!jobId) {
    usage();
    throw new WebaiError('webai model3d status: a job id is required');
  }
  const deadline = Date.now() + (args.once ? 0 : 1_800_000);
  let state;
  while (true) {
    state = await provider.poll(jobId);
    if (state.status === 'ready') break;
    if (state.status === 'failed') {
      const reason = state.reason || 'unknown';
      if (/quota|次数|额度|不足/.test(reason)) throw new QuotaError(`hunyuan ${jobId} failed: ${reason}`);
      throw new ContentRejectedError(`hunyuan ${jobId} failed: ${reason}`);
    }
    if (args.once) {
      if (args.json) {
        process.stdout.write(JSON.stringify({ jobId, ready: false, status: state.creation?.status || 'pending' }, null, 2) + '\n');
      } else {
        process.stdout.write(`${state.creation?.status || 'pending'} — not ready yet (job ${jobId})\n`);
      }
      throw new PendingError(`hunyuan ${jobId} still generating`);
    }
    if (Date.now() > deadline) throw new PendingError(`hunyuan ${jobId} still generating after timeout`);
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const creation = state.creation;
  const stamp = timestamp();
  const downloads = [];
  const targets = [];
  creation.results.forEach((result, index) => {
    if (args.all) {
      for (const kind of DEFAULT_KIND_ORDER) {
        if (result.files[kind]) targets.push({ index, kind, url: result.files[kind] });
      }
    } else {
      const picked = pickFile(creation, { kind: args.kind, index });
      if (picked) targets.push({ index, kind: picked.kind, url: picked.url });
    }
  });
  if (!targets.length) {
    throw new WebaiError(`hunyuan ${jobId} finished but exposed no downloadable file`);
  }

  for (const target of targets) {
    const suffix = creation.results.length > 1 ? `_${target.index + 1}` : '';
    const name = `Hunyuan_${jobId}${suffix}_${stamp}.${target.kind === 'image' ? 'png' : target.kind}`;
    const dest = resolveOutPath(args.out, name, { forceDir: targets.length > 1 });
    const path = await provider.download(target.url, dest);
    downloads.push({ index: target.index, kind: target.kind, url: target.url, path });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ jobId, ready: true, creation, downloads }, null, 2) + '\n');
  } else {
    for (const d of downloads) process.stdout.write(d.path + '\n');
  }
}

async function listCreations(provider, args) {
  const { total, creations } = await provider.list({
    limit: args.limit ? Number(args.limit) : 20,
    offset: args.offset ? Number(args.offset) : 0,
    sceneTypes: args.scene ? [SCENE[args.scene] || args.scene] : [],
  });
  if (args.json) {
    process.stdout.write(JSON.stringify({ total, creations }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`total ${total ?? '?'}\n`);
  for (const c of creations) {
    const files = c.results.flatMap((r) => Object.keys(r.files)).join(',') || '-';
    process.stdout.write(`${c.id}  ${String(c.status).padEnd(10)} ${String(c.modelType || '').padEnd(22)} ${files}  ${c.title || c.prompt}\n`);
  }
}

async function showQuota(provider, args) {
  const data = await provider.quota();
  if (args.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(JSON.stringify(data) + '\n');
}

async function bind(provider, args) {
  const glb = args.meshGlb;
  if (!glb) throw new WebaiError('webai model3d bind: --mesh-glb <url> is required');
  const image = (args.images || [])[0] || '';
  const bound = await provider.bindBones({ glb, image });
  if (args.json) process.stdout.write(JSON.stringify(bound, null, 2) + '\n');
  else process.stdout.write(`${bound.fbx}\n`);
}

async function upload(provider, args) {
  const path = args.positional[2];
  if (!path) throw new WebaiError('webai model3d upload: a file path is required');
  const url = await provider.uploadFile(path);
  if (args.json) process.stdout.write(JSON.stringify({ path, url }, null, 2) + '\n');
  else process.stdout.write(url + '\n');
}

function showMotions(args) {
  if (args.json) {
    process.stdout.write(JSON.stringify(MOTIONS, null, 2) + '\n');
    return;
  }
  for (const [id, name] of Object.entries(MOTIONS)) process.stdout.write(`${id}\t${name}\n`);
}
