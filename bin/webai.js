#!/usr/bin/env node
import { exitCodeFor } from '../src/errors.js';

// Keep the entrypoint free of provider and browser imports. Commands are loaded
// on demand so `webai serve` never initializes the legacy Chrome/opencli path.
const SITE_IDS = ['grok', 'deepseek', 'gemini', 'doubao', 'claude', 'chatgpt'];

const USAGE = `webai — reverse-engineered CLI for chat web apps

Usage:
  webai ask <site> <prompt...>         Send a prompt, print the final answer
  webai stream <site> <prompt...>      Send a prompt, stream the answer
  webai history <site>                 List recent conversations from the sidebar
  webai detail <site> <id-or-url>      Print transcript of a single conversation
  webai video gemini submit "<p>"      Start a Veo video (direct HTTP)
  webai video gemini status <job-id>   Poll a video job; download mp4 when ready
  webai image gemini "<prompt>"        Generate an image and download it (direct HTTP)
  webai model3d hunyuan submit <mode>  Generate a 3D asset (text/image/scene/animate/…)
  webai model3d hunyuan status <id>    Poll a 3D job; download glb/fbx when ready
  webai studio rig <file>              Auto-rig a humanoid mesh (bones + skinning)
  webai studio animate <id> --motion   Retarget an action onto a rigged model
  webai studio motions                 List the built-in action library
  webai serve                          Run the local OpenAI-compatible sidecar
  webai auth login <provider>          Prompt securely, verify chat, then save credentials
  webai auth import <provider> --stdin Import credentials without a browser
  webai auth import <provider> --file <path>
  webai auth import chrome             Import .google.com cookies from Chrome

Sites: ${SITE_IDS.join(', ')}

Common flags:
  --json                               JSON output instead of plain text
  --verbose                            Print site/conversationId/model on stderr (ask)
  --thinking                           Include thinking-trace output where supported
  --raw                                (stream) Emit the raw streaming body
  --new-chat                           Start a fresh chat before sending
  --limit <n>                          (history) max items, default 20
  --image <path>                       (video) reference image for image->video
  --out <path>                         (video status / image) output file or dir
  --host <address>                     (serve) bind address, default 127.0.0.1
  --port <n>                           (serve) listen port, default 8787
  --token-file <path>                  (serve) read the bearer token from a file
  --experimental                       (serve) expose unverified direct providers

Environment:
  WEBAI_SERVER_TOKEN                   Bearer token accepted by webai serve
  WEBAI_SESSION                        opencli browser session name override
                                       (defaults to "webai-<site>")

Examples:
  webai ask grok "respond pong"
  webai ask deepseek --thinking "what's 17 * 23 step by step"
  webai stream gemini --json "name three colors"
  webai history grok --limit 5
  webai detail grok https://grok.com/c/0123abcd-...
`;

function parseArgs(argv) {
  const args = { positional: [], json: false, verbose: false, raw: false, thinking: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--raw') args.raw = true;
    else if (a === '--thinking') args.thinking = true;
    else if (a === '--new-chat' || a === '--new') args.newChat = true;
    else if (a === '--limit') args.limit = argv[++i];
    else if (a === '--image') {
      args.image = argv[++i];
      (args.images ||= []).push(args.image);
    } else if (a === '--out') args.out = argv[++i];
    else if (a === '--video') args.video = argv[++i];
    else if (a === '--count') args.count = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--style') args.style = argv[++i];
    else if (a === '--negative') args.negative = argv[++i];
    else if (a === '--pbr') args.pbr = true;
    else if (a === '--tpose') args.tpose = true;
    else if (a === '--lowpoly') args.lowpolyFlag = true;
    else if (a === '--faces') args.faces = argv[++i];
    else if (a === '--motion') args.motion = argv[++i];
    else if (a === '--mesh-glb') args.meshGlb = argv[++i];
    else if (a === '--mesh-fbx') args.meshFbx = argv[++i];
    else if (a === '--keep-bone') args.keepBone = true;
    else if (a === '--with-bone') args.withBone = true;
    else if (a === '--wait') args.wait = true;
    else if (a === '--prompt') args.prompt = argv[++i];
    else if (a === '--fmt') args.fmt = argv[++i];
    else if (a === '--node') args.node = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--offset') args.offset = argv[++i];
    else if (a === '--scene') args.scene = argv[++i];
    else if (a === '--file') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) args.fileMissing = true;
      else args.file = argv[++i];
    } else if (a === '--stdin') args.stdin = true;
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--aspect') args.aspect = argv[++i];
    else if (a === '--duration') args.duration = argv[++i];
    else if (a === '--resolution') args.resolution = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = argv[++i];
    else if (a === '--token-file') args.tokenFile = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '--experimental') args.experimental = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args.positional.push(a);
  }
  return args;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(rest);
  if (args.help) { process.stdout.write(USAGE); return; }
  try {
    switch (cmd) {
      case 'ask':     await (await import('../src/commands/ask.js')).ask(args);         break;
      case 'stream':  await (await import('../src/commands/stream.js')).stream(args);   break;
      case 'history': await (await import('../src/commands/history.js')).history(args); break;
      case 'detail':  await (await import('../src/commands/detail.js')).detail(args);   break;
      case 'video':   await (await import('../src/commands/video.js')).video(args);     break;
      case 'image':   await (await import('../src/commands/image.js')).image(args);     break;
      case 'model3d':
      case '3d':      await (await import('../src/commands/model3d.js')).model3d(args); break;
      case 'studio':  await (await import('../src/commands/studio.js')).studioCmd(args); break;
      case 'auth':    await (await import('../src/commands/auth.js')).auth(args);       break;
      case 'serve':   await (await import('../src/commands/serve.js')).serve(args);     break;
      case 'sites':   process.stdout.write(SITE_IDS.join('\n') + '\n'); break;
      default:
        process.stderr.write(`webai: unknown command "${cmd}"\n\n${USAGE}`);
        process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`webai ${cmd}: ${e.message || e}\n`);
    process.exit(exitCodeFor(e));
  }
}

main();
