import type { ReachDeckModelEnv } from '../../lib/reach-deck/model-service-client.js';

export const directLiteLlmEndpoint = (env: ReachDeckModelEnv): string => {
  const raw = env.REACHANY_LITELLM_BASE_URL?.trim();
  if (!raw) throw new Error('REACHANY_LITELLM_BASE_URL is required for offline generation.');
  const endpoint = new URL(raw.endsWith('/') ? raw : raw + '/');
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname =
    (pathname.endsWith('/v1') ? pathname : pathname + '/v1') + '/chat/completions';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
};

export const createDirectLiteLlmFetch = (env: ReachDeckModelEnv, model: string): typeof fetch => {
  const endpoint = directLiteLlmEndpoint(env);
  const apiKey = env.REACHANY_LITELLM_API_KEY?.trim();
  if (!apiKey) throw new Error('REACHANY_LITELLM_API_KEY is required for offline generation.');
  return async (_input, init) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Reach Deck offline model requests must carry a JSON string body.');
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return fetch(endpoint, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, model }),
    });
  };
};
