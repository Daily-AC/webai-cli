import { existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Resolve an --out value that may be a file path, a directory, or omitted.
// Returns an absolute file path to write to.
export function resolveOutPath(out, defaultName) {
  if (!out) return resolve(process.cwd(), defaultName);
  const abs = resolve(out);
  const isDir = out.endsWith('/') || (existsSync(abs) && statSync(abs).isDirectory());
  if (isDir) {
    mkdirSync(abs, { recursive: true });
    return join(abs, defaultName);
  }
  return abs;
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
