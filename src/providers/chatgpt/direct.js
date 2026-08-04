import { getProvider, parseCookieInput, setProvider } from '../../auth/store.js';
import { toCookieMap } from '../../auth/cookies.js';
import { createImpersonatedFetch, normalizeTlsProfile } from '../../http/impersonated.js';
import { streamChat } from './chat.js';
import { normalizeChatGptCredential } from './credentials.js';

function persistRotatedCookieHeader(cookieHeader) {
  const cookieJar = parseCookieInput(cookieHeader, { provider: 'chatgpt' });
  setProvider('chatgpt', {
    cookies: toCookieMap(cookieJar),
    cookieJar,
    rotatedAt: new Date().toISOString(),
  });
}

export function createChatGptDirectProvider({ createTransport = createImpersonatedFetch } = {}) {
  return {
    id: 'chatgpt-web',
    stability: 'experimental',
    async *streamChat(request, options = {}) {
      const storedCredential = options.credential == null;
      const credential = options.credential ?? getProvider('chatgpt');
      const normalized = normalizeChatGptCredential(credential);
      const transport = options.transport ?? createTransport({
        profile: normalizeTlsProfile(normalized.tlsProfile),
      });
      const callerUpdate = options.onCredentialUpdate;
      const onCredentialUpdate = storedCredential || callerUpdate
        ? async (cookieHeader) => {
            if (storedCredential) persistRotatedCookieHeader(cookieHeader);
            await callerUpdate?.(cookieHeader);
          }
        : undefined;

      yield* streamChat(request, {
        ...options,
        credential: normalized,
        transport,
        onCredentialUpdate,
      });
    },
  };
}

export const chatgptDirectChat = createChatGptDirectProvider();

export default chatgptDirectChat;
