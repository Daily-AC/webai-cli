import { chatgptDirectChat } from './chatgpt/direct.js';
import { claudeDirectChat } from './claude/direct.js';
import { deepseekChat } from './deepseek/chat.js';
import { doubaoChat } from './doubao/chat.js';
import { geminiChat } from './gemini/chat.js';

export const chatProviders = Object.freeze([geminiChat, doubaoChat]);
export const experimentalChatProviders = Object.freeze([
  deepseekChat,
  claudeDirectChat,
  chatgptDirectChat,
]);
export const allChatProviders = Object.freeze([...chatProviders, ...experimentalChatProviders]);

const providersByModel = new Map(allChatProviders.map((provider) => [provider.id, provider]));

export function getChatProvider(idOrSite) {
  if (typeof idOrSite !== 'string' || !idOrSite) return null;
  const normalized = idOrSite.toLowerCase();
  return providersByModel.get(normalized) || providersByModel.get(`${normalized}-web`) || null;
}
