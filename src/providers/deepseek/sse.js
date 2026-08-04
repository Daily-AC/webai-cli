import { WebaiError } from '../../errors.js';

const OUTPUT_FRAGMENT_TYPES = new Set(['RESPONSE', 'SEARCH', 'TEXT', 'TEXT_REASONING']);
const REASONING_FRAGMENT_TYPES = new Set(['THINK', 'REASONING']);

function parseFrame(block) {
  let event = '';
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    let value = separator < 0 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!event && dataLines.length === 0) return null;

  const rawData = dataLines.join('\n');
  let data = null;
  if (rawData && rawData !== '[DONE]') {
    try {
      data = JSON.parse(rawData);
    } catch (error) {
      throw new WebaiError(`deepseek chat: invalid SSE JSON (${error.message})`);
    }
  }
  return { event, data, rawData };
}

export class DeepSeekSseDecoder {
  constructor() {
    this.buffer = '';
  }

  push(text) {
    this.buffer += text;
    const frames = [];
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const frame = parseFrame(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  finish() {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const block = this.buffer;
    this.buffer = '';
    const frame = parseFrame(block);
    return frame ? [frame] : [];
  }
}

function fragmentType(fragment) {
  return String(fragment?.type || '').toUpperCase();
}

function isOutputFragment(fragment) {
  return OUTPUT_FRAGMENT_TYPES.has(fragmentType(fragment));
}

function normalizePath(path) {
  const value = String(path || '').replace(/^\/+/, '');
  return value.startsWith('response/') || value === 'response' ? value : `response/${value}`;
}

export class DeepSeekStreamState {
  constructor() {
    this.fragments = [];
    this.lastPath = '';
    this.responseId = '';
    this.requestId = '';
    this.modelType = '';
    this.finishReason = '';
    this.completed = false;
    this.upstreamError = null;
  }

  get reasoning() {
    return this.fragments
      .filter((fragment) => REASONING_FRAGMENT_TYPES.has(fragmentType(fragment)))
      .map((fragment) => String(fragment.content || ''))
      .join('');
  }

  appendFragment(value) {
    const incoming = Array.isArray(value) ? value : [value];
    let delta = '';
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') continue;
      const fragment = { ...raw, content: String(raw.content || '') };
      this.fragments.push(fragment);
      if (isOutputFragment(fragment)) delta += fragment.content;
    }
    return delta;
  }

  setFragmentContent(index, value, operation) {
    const realIndex = index < 0 ? this.fragments.length + index : index;
    const fragment = this.fragments[realIndex];
    if (!fragment || typeof value !== 'string') return '';
    if (operation === 'SET') {
      const previous = String(fragment.content || '');
      fragment.content = value;
      return isOutputFragment(fragment) && value.startsWith(previous) ? value.slice(previous.length) : '';
    }
    fragment.content = String(fragment.content || '') + value;
    return isOutputFragment(fragment) ? value : '';
  }

  replaceSnapshot(response) {
    let delta = '';
    const incoming = Array.isArray(response.fragments) ? response.fragments : [];
    if (this.fragments.length === 0) {
      delta += this.appendFragment(incoming);
    } else {
      for (let index = 0; index < incoming.length; index++) {
        const next = incoming[index];
        if (!this.fragments[index]) delta += this.appendFragment(next);
        else if (next && typeof next === 'object') {
          this.fragments[index].type = next.type || this.fragments[index].type;
          delta += this.setFragmentContent(index, String(next.content || ''), 'SET');
        }
      }
    }
    if (incoming.length === 0 && typeof response.content === 'string') {
      delta += this.appendFragment({ type: 'RESPONSE', content: response.content });
    }
    if (response.message_id !== undefined) this.responseId = String(response.message_id);
    if (response.model) this.modelType = String(response.model);
    if (response.finish_reason) this.finishReason = String(response.finish_reason);
    if (response.status === 'FINISHED' || response.quasi_status === 'FINISHED') this.completed = true;
    return delta;
  }

  applyPatch(path, operation, value) {
    const normalized = normalizePath(path);
    if (normalized === 'response/fragments' && operation === 'APPEND') {
      return this.appendFragment(value);
    }

    const contentMatch = /^response\/fragments\/(-?\d+)\/content$/.exec(normalized);
    if (contentMatch) {
      return this.setFragmentContent(Number.parseInt(contentMatch[1], 10), value, operation || 'APPEND');
    }

    if (normalized === 'response' && operation === 'BATCH' && Array.isArray(value)) {
      let delta = '';
      for (const patch of value) {
        if (!patch || typeof patch !== 'object') continue;
        delta += this.applyPatch(patch.p, patch.o, patch.v);
      }
      return delta;
    }

    if (/^response\/(?:status|quasi_status)$/.test(normalized) && value === 'FINISHED') {
      this.completed = true;
    }
    if (normalized === 'response/finish_reason' && typeof value === 'string') {
      this.finishReason = value;
    }
    if (normalized === 'response/message_id' && value !== undefined) {
      this.responseId = String(value);
    }
    return '';
  }

  apply(frame) {
    const data = frame?.data;
    if (frame?.event === 'close' || frame?.rawData === '[DONE]') this.completed = true;
    if (!data || typeof data !== 'object') return '';

    if (data.request_message_id !== undefined) this.requestId = String(data.request_message_id);
    if (data.response_message_id !== undefined) this.responseId = String(data.response_message_id);
    if (data.model_type) this.modelType = String(data.model_type);
    if (data.finish_reason) this.finishReason = String(data.finish_reason);

    if (frame.event === 'toast' && String(data.type || '').toLowerCase() === 'error') {
      this.upstreamError = {
        message: String(data.content || data.msg || 'DeepSeek returned an error event'),
        finishReason: String(data.finish_reason || ''),
      };
      return '';
    }
    if (frame.event === 'error' || data.type === 'error') {
      this.upstreamError = {
        message: String(data.content || data.message || data.msg || 'DeepSeek returned an error event'),
        finishReason: String(data.finish_reason || ''),
      };
      return '';
    }

    if (data.v && typeof data.v === 'object' && !Array.isArray(data.v) && data.v.response) {
      this.lastPath = 'response/fragments/-1/content';
      return this.replaceSnapshot(data.v.response);
    }

    if (data.p !== undefined) this.lastPath = String(data.p);
    if (data.v === undefined) return '';
    return this.applyPatch(this.lastPath, data.o, data.v);
  }
}
