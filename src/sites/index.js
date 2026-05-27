import { adapter as grok } from './grok.js';
import { adapter as deepseek } from './deepseek.js';
import { adapter as gemini } from './gemini.js';
import { adapter as claude } from './claude.js';
import { adapter as chatgpt } from './chatgpt.js';

export const SITES = { grok, deepseek, gemini, claude, chatgpt };
export const SITE_IDS = Object.keys(SITES);

export function getAdapter(id) {
  if (!id) throw new Error(`webai: site is required. Pick one of: ${SITE_IDS.join(', ')}`);
  const norm = String(id).toLowerCase();
  if (!SITES[norm]) {
    throw new Error(`webai: unknown site "${id}". Known: ${SITE_IDS.join(', ')}`);
  }
  return SITES[norm];
}
