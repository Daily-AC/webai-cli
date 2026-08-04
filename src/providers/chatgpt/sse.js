import { ChatGptProtocolError } from './errors.js';

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
      throw new ChatGptProtocolError(`chatgpt chat: invalid SSE JSON (${error.message})`);
    }
  }
  return { event, data, rawData };
}

export class ChatGptSseDecoder {
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

function messageChannel(message) {
  return String(message?.channel ?? message?.metadata?.channel ?? '');
}

function partText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  for (const key of ['text', 'content', 'summary']) {
    if (typeof part[key] === 'string') return part[key];
  }
  return '';
}

function messageText(message) {
  if (typeof message?.content?.text === 'string') return message.content.text;
  if (!Array.isArray(message?.content?.parts)) return '';
  return message.content.parts.map(partText).join('');
}

function outputFor(channel, value) {
  if (!value) return { textDelta: '', reasoningDelta: '' };
  if (channel === 'analysis') return { textDelta: '', reasoningDelta: value };
  if (channel && channel !== 'final') return { textDelta: '', reasoningDelta: '' };
  return { textDelta: value, reasoningDelta: '' };
}

function combine(left, right) {
  return {
    textDelta: left.textDelta + right.textDelta,
    reasoningDelta: left.reasoningDelta + right.reasoningDelta,
  };
}

function patchPath(path) {
  const value = String(path || '');
  return value.startsWith('/') ? value : `/${value}`;
}

function isTextPath(path) {
  return /^\/message\/content\/(?:parts\/0|text)$/.test(patchPath(path));
}

export class ChatGptDeltaState {
  constructor() {
    this.encoding = '';
    this.activeMessageId = '';
    this.activeChannel = '';
    this.conversationId = '';
    this.messageId = '';
    this.text = '';
    this.reasoning = '';
    this.completed = false;
    this.finishedMessage = false;
    this.handoff = null;
    this.resumeToken = '';
    this.upstreamError = null;
    this.sawLiveMessage = false;
    this.pendingFinished = null;
    this.messages = new Map();
  }

  noteDelta(delta) {
    this.text += delta.textDelta;
    this.reasoning += delta.reasoningDelta;
    return delta;
  }

  entryForActive() {
    const key = this.activeMessageId || '__implicit__';
    let entry = this.messages.get(key);
    if (!entry) {
      entry = { channel: this.activeChannel, content: '', live: true };
      this.messages.set(key, entry);
    }
    if (this.activeChannel) entry.channel = this.activeChannel;
    return entry;
  }

  append(value) {
    if (typeof value !== 'string' || !value) return { textDelta: '', reasoningDelta: '' };
    const entry = this.entryForActive();
    entry.content += value;
    return outputFor(entry.channel, value);
  }

  replace(value) {
    if (typeof value !== 'string') return { textDelta: '', reasoningDelta: '' };
    const entry = this.entryForActive();
    const previous = entry.content;
    if (value === previous || (previous && previous.startsWith(value))) return { textDelta: '', reasoningDelta: '' };
    entry.content = value;
    return outputFor(entry.channel, value.startsWith(previous) ? value.slice(previous.length) : '');
  }

  applyMessage(message, { deltaEncoded = false } = {}) {
    if (!message || typeof message !== 'object' || message.author?.role !== 'assistant') {
      return { textDelta: '', reasoningDelta: '' };
    }
    const id = String(message.id || this.activeMessageId || '__implicit__');
    const channel = messageChannel(message);
    const status = String(message.status || '');
    const cumulative = messageText(message);
    const live = status === 'in_progress' || (status === '' && deltaEncoded);

    this.messageId = id === '__implicit__' ? this.messageId : id;
    if (live) {
      this.sawLiveMessage = true;
      this.pendingFinished = null;
      this.activeMessageId = id;
      if (channel) this.activeChannel = channel;
      const entry = this.messages.get(id) || { channel: channel || this.activeChannel, content: '', live: true };
      entry.live = true;
      if (channel) entry.channel = channel;
      this.messages.set(id, entry);
      return this.replace(cumulative);
    }

    const existing = this.messages.get(id);
    if (existing?.live) {
      this.activeMessageId = id;
      if (channel) this.activeChannel = channel;
      if (channel) existing.channel = channel;
      if (status === 'finished_successfully') this.finishedMessage = true;
      return this.replace(cumulative);
    }

    if (status === 'finished_successfully') {
      this.pendingFinished = { id, channel, content: cumulative };
      return { textDelta: '', reasoningDelta: '' };
    }

    this.activeMessageId = id;
    if (channel) this.activeChannel = channel;
    const entry = existing || { channel: channel || this.activeChannel, content: '', live: true };
    entry.live = true;
    if (channel) entry.channel = channel;
    this.messages.set(id, entry);
    return this.replace(cumulative);
  }

  applyPatch(path, operation, value) {
    const normalized = patchPath(path);
    const op = String(operation || '').toLowerCase();
    if ((normalized === '/' || normalized === '') && op === 'patch' && Array.isArray(value)) {
      return value.reduce(
        (delta, patch) =>
          patch && typeof patch === 'object'
            ? combine(delta, this.applyPatch(patch.p ?? patch.path, patch.o ?? patch.op, patch.v ?? patch.value))
            : delta,
        { textDelta: '', reasoningDelta: '' }
      );
    }
    if ((normalized === '/' || normalized === '') && (op === 'add' || op === 'replace')) {
      const message = value?.message ?? value;
      return this.applyMessage(message, { deltaEncoded: true });
    }
    if (/^\/message\/channel$/.test(normalized) && typeof value === 'string') {
      this.activeChannel = value;
      this.entryForActive().channel = value;
      return { textDelta: '', reasoningDelta: '' };
    }
    if (/^\/message\/id$/.test(normalized) && value != null) {
      this.activeMessageId = String(value);
      this.messageId = String(value);
      return { textDelta: '', reasoningDelta: '' };
    }
    if (/^\/message\/status$/.test(normalized) && value === 'finished_successfully') {
      this.finishedMessage = true;
      return { textDelta: '', reasoningDelta: '' };
    }
    if (!isTextPath(normalized)) return { textDelta: '', reasoningDelta: '' };
    if (op === 'replace') return this.replace(partText(value));
    if (op === 'append' || op === 'add' || !op) return this.append(partText(value));
    return { textDelta: '', reasoningDelta: '' };
  }

  finishStream() {
    let delta = { textDelta: '', reasoningDelta: '' };
    if (this.pendingFinished && this.text === '') {
      this.activeMessageId = this.pendingFinished.id;
      this.messageId = this.pendingFinished.id;
      this.activeChannel = this.pendingFinished.channel;
      const entry = {
        channel: this.pendingFinished.channel,
        content: this.pendingFinished.content,
        live: false,
      };
      this.messages.set(this.pendingFinished.id, entry);
      delta = outputFor(entry.channel, entry.content);
    }
    this.completed = true;
    this.finishedMessage = true;
    return delta;
  }

  apply(frame) {
    const data = frame?.data;
    if (frame?.event === 'delta_encoding') {
      this.encoding = typeof data === 'string' ? data : String(data?.encoding || '');
      return { textDelta: '', reasoningDelta: '' };
    }
    if (frame?.rawData === '[DONE]' || frame?.event === 'done' || frame?.event === 'close') {
      return this.noteDelta(this.finishStream());
    }
    if (!data || typeof data !== 'object') return { textDelta: '', reasoningDelta: '' };

    if (data.conversation_id != null) this.conversationId = String(data.conversation_id);
    const type = String(data.type || frame?.event || '');
    if (type === 'resume_conversation_token') {
      if (data.token) this.resumeToken = String(data.token);
      return { textDelta: '', reasoningDelta: '' };
    }
    if (type === 'stream_handoff') {
      this.handoff = data;
      return { textDelta: '', reasoningDelta: '' };
    }
    if (type === 'error' || frame?.event === 'error' || data.error) {
      const error = data.error;
      this.upstreamError = {
        message: String(
          (typeof error === 'object' && (error?.message || error?.detail)) ||
            error ||
            data.message ||
            data.detail ||
            'ChatGPT returned an error event'
        ),
        code: String((typeof error === 'object' && error?.code) || data.code || ''),
      };
      return { textDelta: '', reasoningDelta: '' };
    }

    let delta = { textDelta: '', reasoningDelta: '' };
    if (data.message && frame?.event !== 'delta') {
      delta = this.applyMessage(data.message);
    } else if (frame?.event === 'delta' || this.encoding === 'v1') {
      if (data.p === undefined && data.o === undefined && typeof data.v === 'string') {
        delta = this.append(data.v);
      } else if (data.v?.message && data.p === undefined && data.o === undefined) {
        delta = this.applyMessage(data.v.message, { deltaEncoded: true });
      } else {
        delta = this.applyPatch(data.p ?? data.path, data.o ?? data.op, data.v ?? data.value);
      }
    } else if (data.v?.message) {
      delta = this.applyMessage(data.v.message, { deltaEncoded: true });
    }
    return this.noteDelta(delta);
  }
}
