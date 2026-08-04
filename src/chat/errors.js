export class UnsupportedChatFeatureError extends Error {
  constructor(feature, detail = '') {
    super(`webai chat: unsupported feature "${feature}"${detail ? ` (${detail})` : ''}`);
    this.name = 'UnsupportedChatFeatureError';
    this.code = 'unsupported_feature';
    this.feature = feature;
  }
}
