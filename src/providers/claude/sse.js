import { AuthError, QuotaError, WebaiError } from '../../errors.js';

function eventError(payload) {
  const detail = String(
    payload?.error?.message || payload?.message || payload?.error || 'unknown Claude stream error'
  );
  if (/auth|session|cookie|login|sign.?in|credential|expired/i.test(detail)) {
    return new AuthError(`claude completion rejected the credential: ${detail}`);
  }
  if (/quota|rate.?limit|message.?limit|too many|usage limit/i.test(detail)) {
    return new QuotaError(`claude completion was rate limited: ${detail}`);
  }
  return new WebaiError(`claude completion failed: ${detail}`);
}

function normalizedUsage(inputTokens, outputTokens) {
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return undefined;
  const promptTokens = Number.isFinite(inputTokens) ? inputTokens : 0;
  const completionTokens = Number.isFinite(outputTokens) ? outputTokens : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function finishReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function hardMessageLimit(payload) {
  const limit = payload?.message_limit;
  if (!limit || typeof limit !== 'object') return false;
  if (limit.type === 'hit_limit') return true;
  const windows = limit.windows;
  return !!windows && typeof windows === 'object' && Object.values(windows).some(
    (window) => window && typeof window === 'object' && window.status === 'over_limit'
  );
}

function isToolBlock(block) {
  return typeof block?.type === 'string' && block.type.includes('tool');
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

export class ClaudeSseDecoder {
  constructor() {
    this.buffer = '';
    this.eventName = '';
    this.dataLines = [];
  }

  push(text) {
    this.buffer += text;
    const records = [];
    while (true) {
      const line = this.takeLine(false);
      if (line === null) break;
      const record = this.consumeLine(line);
      if (record) records.push(record);
    }
    return records;
  }

  finish() {
    const records = this.push('');
    const finalLine = this.takeLine(true);
    if (finalLine !== null) {
      const record = this.consumeLine(finalLine);
      if (record) records.push(record);
    }
    const pending = this.flush();
    if (pending) records.push(pending);
    return records;
  }

  takeLine(final) {
    for (let index = 0; index < this.buffer.length; index++) {
      const value = this.buffer[index];
      if (value === '\n') {
        const end = index > 0 && this.buffer[index - 1] === '\r' ? index - 1 : index;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(index + 1);
        return line;
      }
      if (value === '\r') {
        if (index + 1 === this.buffer.length && !final) return null;
        const width = this.buffer[index + 1] === '\n' ? 2 : 1;
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + width);
        return line;
      }
    }
    if (!final || !this.buffer) return null;
    const line = this.buffer;
    this.buffer = '';
    return line;
  }

  consumeLine(line) {
    if (line === '') return this.flush();
    if (line.startsWith(':')) return null;

    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return null;
  }

  flush() {
    if (!this.eventName && this.dataLines.length === 0) return null;
    const record = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
    };
    this.eventName = '';
    this.dataLines = [];
    return record;
  }
}

export class ClaudeStreamState {
  constructor({ parentMessageUuid = '' } = {}) {
    this.parentMessageUuid = parentMessageUuid;
    this.reasoning = '';
    this.reasoningSignature = '';
    this.toolBlocks = [];
    this.openBlocks = new Map();
    this.inputTokens = undefined;
    this.outputTokens = undefined;
    this.stopReason = 'stop';
    this.completed = false;
    this.quota = undefined;
  }

  apply(record) {
    if (!record || typeof record !== 'object') return [];
    if (record.data === '[DONE]') {
      this.completed = true;
      return [];
    }

    let payload;
    try {
      payload = JSON.parse(record.data || '{}');
    } catch {
      throw new WebaiError(`claude chat: invalid ${record.event || 'SSE'} event JSON`);
    }
    const type = payload.type || record.event;

    if (type === 'error') throw eventError(payload);
    if (type === 'message_limit') {
      this.quota = cloneJsonValue(payload.message_limit);
      if (hardMessageLimit(payload)) throw new QuotaError('Claude web message limit exceeded.');
      return [];
    }
    if (type === 'message_start') {
      const message = payload.message || {};
      const parent = message.uuid || message.id;
      if (parent) this.parentMessageUuid = String(parent);
      if (Number.isFinite(Number(message.usage?.input_tokens))) {
        this.inputTokens = Number(message.usage.input_tokens);
      }
      return [];
    }
    if (type === 'content_block_start') return this.startBlock(payload);
    if (type === 'content_block_delta') return this.updateBlock(payload);
    if (type === 'content_block_stop') {
      this.stopBlock(payload.index);
      return [];
    }
    if (type === 'message_delta') {
      const reason = payload.delta?.stop_reason;
      if (reason) this.stopReason = finishReason(reason);
      const usage = payload.usage || payload.delta?.usage;
      if (Number.isFinite(Number(usage?.output_tokens))) {
        this.outputTokens = Number(usage.output_tokens);
      }
      return [];
    }
    if (type === 'message_stop') {
      this.completed = true;
      return [];
    }
    return [];
  }

  startBlock(payload) {
    const block = payload.content_block || {};
    const index = Number.isInteger(payload.index) ? payload.index : 0;
    const events = [];
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      events.push({ type: 'text_delta', text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      this.reasoning += block.thinking;
    }

    if (isToolBlock(block)) {
      const captured = {
        index,
        type: block.type,
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
      };
      if (block.input !== undefined) captured.input = cloneJsonValue(block.input);
      if (block.content !== undefined) captured.content = cloneJsonValue(block.content);
      Object.defineProperty(captured, '_inputJson', { value: '', writable: true, enumerable: false });
      this.openBlocks.set(index, captured);
      this.toolBlocks.push(captured);
    }
    return events;
  }

  updateBlock(payload) {
    const delta = payload.delta || {};
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text ? [{ type: 'text_delta', text: delta.text }] : [];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      this.reasoning += delta.thinking;
      return [];
    }
    if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
      this.reasoningSignature += delta.signature;
      return [];
    }
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const block = this.openBlocks.get(Number.isInteger(payload.index) ? payload.index : 0);
      if (block) block._inputJson += delta.partial_json;
    }
    return [];
  }

  stopBlock(index) {
    const block = this.openBlocks.get(Number.isInteger(index) ? index : 0);
    if (!block) return;
    this.openBlocks.delete(block.index);
    if (!block._inputJson) return;
    block.inputJson = block._inputJson;
    try {
      block.input = JSON.parse(block._inputJson);
    } catch {
      // Keep inputJson verbatim; web tool result shapes can change independently.
    }
  }

  metadata() {
    return {
      parentMessageUuid: this.parentMessageUuid,
      reasoning: this.reasoning,
      ...(this.reasoningSignature ? { reasoningSignature: this.reasoningSignature } : {}),
      toolBlocks: this.toolBlocks.map((block) => ({ ...block })),
      ...(this.quota ? { quota: cloneJsonValue(this.quota) } : {}),
      ...(normalizedUsage(this.inputTokens, this.outputTokens)
        ? { usage: normalizedUsage(this.inputTokens, this.outputTokens) }
        : {}),
      completed: this.completed,
    };
  }
}
