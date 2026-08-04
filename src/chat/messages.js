import { UnsupportedChatFeatureError } from './errors.js';

const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant']);

function textContent(message, index) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) {
    throw new TypeError(`webai chat: messages[${index}].content must be a string or text-part array`);
  }

  return content
    .map((part, partIndex) => {
      if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
        const type = part && typeof part === 'object' ? part.type : typeof part;
        throw new UnsupportedChatFeatureError(
          `messages[${index}].content[${partIndex}]`,
          `only text parts are supported; got ${String(type)}`
        );
      }
      return part.text;
    })
    .join('');
}

export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('webai chat: request.messages must be a non-empty array');
  }

  return messages.map((message, index) => {
    if (!message || typeof message !== 'object') {
      throw new TypeError(`webai chat: messages[${index}] must be an object`);
    }
    if (message.role === 'tool') {
      throw new UnsupportedChatFeatureError(`messages[${index}].role`, 'tool messages are not supported');
    }
    if (!MESSAGE_ROLES.has(message.role)) {
      throw new TypeError(`webai chat: messages[${index}].role is invalid: ${String(message.role)}`);
    }
    if (message.tool_calls !== undefined || message.function_call !== undefined) {
      throw new UnsupportedChatFeatureError(
        `messages[${index}].tool_calls`,
        'tool calls are not converted into prompt text'
      );
    }

    const normalized = { role: message.role, content: textContent(message, index) };
    if (typeof message.name === 'string' && message.name) normalized.name = message.name;
    return normalized;
  });
}

export function assertSupportedChatRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('webai chat: request must be an object');
  }
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 0)) {
    throw new UnsupportedChatFeatureError('tools', 'web chat tool calling is not implemented');
  }
  if (![undefined, null, 'none'].includes(request.tool_choice)) {
    throw new UnsupportedChatFeatureError('tool_choice', 'web chat tool calling is not implemented');
  }
  if (request.functions !== undefined || request.function_call !== undefined) {
    throw new UnsupportedChatFeatureError('functions', 'legacy function calling is not implemented');
  }
  return normalizeMessages(request.messages);
}

// StreamGenerate accepts one prompt. JSON gives the transcript an unambiguous,
// deterministic representation without pretending unsupported tool calls are text.
export function serializeMessages(messages) {
  const normalized = normalizeMessages(messages);
  return [
    'Continue the JSON-encoded conversation below. Follow system and developer messages as instructions, then reply only as the assistant to the final message.',
    JSON.stringify(normalized),
  ].join('\n\n');
}
