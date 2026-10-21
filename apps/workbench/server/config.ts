export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value?.trim()) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    baseUrl: env.GENUI_API_BASE_URL?.trim().replace(/\/+$/, '') ?? '',
    apiKey: env.GENUI_API_KEY?.trim() ?? '',
    model: env.GENUI_MODEL?.trim() ?? '',
    maxTokens: boundedInteger(env.GENUI_MAX_TOKENS, 16000, 256, 64000),
    timeoutMs: boundedInteger(env.GENUI_TIMEOUT_MS, 180000, 1000, 600000),
  };
}

export function safeBaseUrl(config: ModelConfig): string {
  try {
    const url = new URL(config.baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return '';
    // Permit HTTP for explicitly configured local inference servers only.
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return '';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function isConfigured(config: ModelConfig): boolean {
  return Boolean(
    safeBaseUrl(config) &&
    config.apiKey &&
    !/[\r\n]/.test(config.apiKey) &&
    config.model &&
    config.model.length <= 200,
  );
}
