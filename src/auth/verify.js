import { toCookieMap } from './cookies.js';
import { parseCookieInput } from './store.js';
import { WebaiError } from '../errors.js';
import { getChatProvider } from '../providers/chat.js';

export const LOGIN_PROVIDER_IDS = Object.freeze([
  'gemini',
  'doubao',
  'deepseek',
  'claude',
  'chatgpt',
]);

const PROBE_PROMPT =
  'Reply with only the plain-text token webai-ok. Do not call tools or add any other text.';

export async function verifyChatCredential(
  provider,
  credential,
  {
    getProvider = getChatProvider,
    timeoutMs = 120_000,
  } = {}
) {
  if (!LOGIN_PROVIDER_IDS.includes(provider)) {
    throw new WebaiError(
      `webai auth login: unknown provider "${provider}" (expected one of: ${LOGIN_PROVIDER_IDS.join(', ')})`
    );
  }
  const chatProvider = getProvider(provider);
  if (!chatProvider || typeof chatProvider.streamChat !== 'function') {
    throw new WebaiError(`webai auth login: ${provider} has no direct chat verifier`);
  }

  let sawText = false;
  let sawFinish = false;
  let finishMetadata = {};
  let rotatedCookieHeader = '';
  const request = {
    model: chatProvider.id,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    timeoutMs,
  };

  for await (const event of chatProvider.streamChat(request, {
    credential,
    timeoutMs,
    onCredentialUpdate: async (cookieHeader) => {
      rotatedCookieHeader = String(cookieHeader || '').trim();
    },
  })) {
    if (event?.type === 'text_delta' && typeof event.text === 'string' && event.text) {
      sawText = true;
    }
    if (event?.type === 'finish') {
      sawFinish = true;
      if (event.metadata && typeof event.metadata === 'object') finishMetadata = event.metadata;
    }
  }

  if (!sawText || !sawFinish) {
    throw new WebaiError(
      `webai auth login: ${provider} verification did not complete a text response`
    );
  }

  const updates = {};
  if (provider === 'chatgpt' && rotatedCookieHeader) {
    const cookieJar = parseCookieInput(rotatedCookieHeader, { provider: 'chatgpt' });
    updates.cookieJar = cookieJar;
    updates.cookies = toCookieMap(cookieJar);
  }
  if (provider === 'claude' && finishMetadata.organizationId) {
    updates.organizationId = String(finishMetadata.organizationId);
  }

  return { model: chatProvider.id, updates };
}
