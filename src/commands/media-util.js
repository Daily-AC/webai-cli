import { existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Resolve an --out value that may be a file path, a directory, or omitted.
// Returns an absolute file path to write to.
//
// `forceDir` is for callers that write several files in one run: without it an
// --out naming a directory that does not exist yet is taken for a filename, and
// every file overwrites the previous one.
export function resolveOutPath(out, defaultName, { forceDir = false } = {}) {
  if (!out) return resolve(process.cwd(), defaultName);
  const abs = resolve(out);
  const isDir = forceDir || out.endsWith('/') || (existsSync(abs) && statSync(abs).isDirectory());
  if (isDir) {
    mkdirSync(abs, { recursive: true });
    return join(abs, defaultName);
  }
  return abs;
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
