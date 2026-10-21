/**
 * Reach Deck 旁白合成语义的稳定版本。模型、解析参数或其他会改变音频字节/朗读语义的
 * 服务端配置发生变化时必须提升此值，使重新生成不会命中旧 profile 的持久媒体缓存。
 */
export const REACH_DECK_SPEECH_PROFILE_VERSION = 'reach-deck-tts/ssml-chunks/v11';
