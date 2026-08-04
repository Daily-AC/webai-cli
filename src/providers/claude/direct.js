import { getProvider } from '../../auth/store.js';
import { createImpersonatedFetch, normalizeTlsProfile } from '../../http/impersonated.js';
import { normalizeClaudeCredential, streamChat } from './chat.js';

export function createClaudeDirectProvider({ createTransport = createImpersonatedFetch } = {}) {
  return {
    id: 'claude-web',
    stability: 'experimental',
    async *streamChat(request, options = {}) {
      const credential = options.credential ?? getProvider('claude');
      const normalized = normalizeClaudeCredential(credential);
      const fetchImpl = options.fetchImpl ?? createTransport({
        profile: normalizeTlsProfile(normalized.tlsProfile),
      });
      yield* streamChat(request, { ...options, credential: normalized, fetchImpl });
    },
  };
}

export const claudeDirectChat = createClaudeDirectProvider();

export default claudeDirectChat;
