import { readdirSync, statSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { runOpencli } from './opencli.js';

// Browser-mediated downloads: we can't read cross-origin / CSP-guarded media
// URLs ourselves, so we click the page's own download button (via opencli's CDP
// native click — a trusted gesture; a programmatic el.click() is ignored by
// Chrome for downloads) and watch Chrome's download directory for a NEW file.
//
// We snapshot the directory first and only accept files that weren't there
// before — Chrome names generated media unpredictably (e.g.
// `Gemini_Generated_Image_<rand>.png`), so matching by name would risk picking
// up a stale download from an earlier run.
export function downloadDir() {
  return process.env.WEBAI_DOWNLOAD_DIR || join(homedir(), 'Downloads');
}

export async function downloadViaClick(session, tabId, buttonSelector, { extns = null, timeoutMs = 120_000 } = {}) {
  const dir = downloadDir();
  const before = listing(dir);
  runOpencli(['browser', session, 'click', '--tab', tabId, buttonSelector]);

  const deadline = Date.now() + timeoutMs;
  let lastPath = null;
  let lastSize = -1;
  let stableHits = 0;
  while (Date.now() < deadline) {
    const added = readdirSync(dir).filter(
      (f) => !before.has(f) && !f.endsWith('.crdownload') && !f.startsWith('.')
    );
    const matched = extns ? added.filter((f) => extns.some((e) => f.toLowerCase().endsWith(e))) : added;
    if (matched.length) {
      const newest = matched
        .map((f) => ({ p: join(dir, f), m: safeMtime(join(dir, f)) }))
        .sort((a, b) => b.m - a.m)[0];
      const size = safeSize(newest.p);
      if (newest.p === lastPath && size === lastSize && size > 0) {
        if (++stableHits >= 2) return newest.p; // size held steady → complete
      } else {
        stableHits = 0;
        lastPath = newest.p;
        lastSize = size;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('webai: timed out waiting for the browser download to finish');
}

function listing(dir) { try { return new Set(readdirSync(dir)); } catch { return new Set(); } }
function safeMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function safeSize(p) { try { return statSync(p).size; } catch { return -1; } }

// Move a downloaded file to the user's requested output path. `out` may be a
// directory (keep original name) or a full file path. Returns final abs path.
export function moveTo(srcPath, out) {
  if (!out) return resolve(srcPath); // leave it in the download dir
  let dest = resolve(out);
  const isDir = (existsSync(dest) && statSync(dest).isDirectory()) || out.endsWith('/');
  if (isDir) {
    mkdirSync(dest, { recursive: true });
    dest = join(dest, basename(srcPath));
  } else {
    mkdirSync(dirname(dest), { recursive: true });
  }
  renameSync(srcPath, dest);
  return dest;
}
