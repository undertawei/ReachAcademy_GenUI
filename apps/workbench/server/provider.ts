import { randomUUID } from 'node:crypto';
import type { InteractiveScene } from '@reachany/reach-deck-dsl';
import { INTERACTIVE_PROMPT } from '../../../vendor/reachacademy/services/ai-runtime/lib/reach-deck/prompts/stages.js';
import { INTERACTIVE_SCENE_SCHEMA } from '../../../vendor/reachacademy/services/ai-runtime/lib/reach-deck/model-service-schemas.js';
import {
  assertInteractiveDocumentStaticallyCompiles,
  createGeneratedInteractiveSceneParser,
} from '../../../vendor/reachacademy/services/ai-runtime/lib/reach-deck/interactive-generation-validation.js';
import type { GenerateResponse } from '../shared/types.js';
import { isConfigured, safeBaseUrl, type ModelConfig } from './config.js';
import { HttpError, isRecord, requestObject, textField, validationMessage } from './errors.js';
import { validateScene } from './scenes.js';
import { assertInteractiveInitializationContract } from './initialization.js';

export { INTERACTIVE_PROMPT };
export type FetchImplementation = typeof fetch;
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new HttpError(502, 'provider_response', '模型服务返回了空响应。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(502, 'provider_response', '模型响应过大，请缩小互动页面的范围。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function complete(
  config: ModelConfig,
  messages: Message[],
  fetchImplementation: FetchImplementation,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = `${safeBaseUrl(config)}/chat/completions`;
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: config.maxTokens,
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: requestSignal,
      // Never send the configured authorization header through a redirect.
      redirect: 'error',
    });
  } catch {
    if (timeoutSignal.aborted) {
      throw new HttpError(
        504,
        'provider_timeout',
        '模型调用超时，请稍后重试或调整 GENUI_TIMEOUT_MS。',
      );
    }
    throw new HttpError(
      502,
      'provider_unavailable',
      '无法连接模型服务，请检查地址、网络和模型配置。',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      502,
      'provider_rejected',
      `模型服务拒绝了请求（HTTP ${response.status}）。请检查 API Key、模型名称和服务额度；该服务需支持 Chat Completions JSON 输出。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedResponse(response));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (timeoutSignal.aborted) {
      throw new HttpError(504, 'provider_timeout', '读取模型响应超时，请稍后重试。');
    }
    throw new HttpError(
      502,
      'provider_response',
      '模型服务未返回有效的 Chat Completions JSON 响应。',
    );
  }
  const choice = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  if (isRecord(choice) && choice.finish_reason === 'length') {
    throw new HttpError(
      502,
      'provider_truncated',
      '模型输出达到长度上限，请提高 GENUI_MAX_TOKENS 或缩小页面范围。',
    );
  }
  if (!message || typeof message.content !== 'string' || !message.content.trim()) {
    throw new HttpError(502, 'provider_response', '模型没有返回互动页面内容。');
  }
  return message.content.trim();
}

function parseModelJson(content: string): unknown {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content);
  return JSON.parse(fenced ? fenced[1]! : content);
}

export async function generateScene(
  value: unknown,
  config: ModelConfig,
  fetchImplementation: FetchImplementation = fetch,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const body = requestObject(value, ['instruction', 'title', 'scene', 'systemPrompt']);
  const instruction = textField(body.instruction, '创作要求', 16000)!;
  const title = textField(body.title, '标题', 200, true) ?? 'GenUI 互动';
  const customPrompt = textField(body.systemPrompt, '系统提示词', 300000, true);
  const previousScene = body.scene === undefined ? undefined : await validateScene(body.scene);
  if (!isConfigured(config)) {
    throw new HttpError(
      503,
      'model_not_configured',
      '请在工作台根目录的 .env 填写 GENUI_API_BASE_URL、GENUI_API_KEY、GENUI_MODEL，然后重启工作台。示例和导入预览无需 API Key。',
    );
  }
  const id = previousScene?.id ?? `interactive-${randomUUID()}`;
  const promptVersion =
    INTERACTIVE_PROMPT.version +
    (customPrompt && customPrompt !== INTERACTIVE_PROMPT.text ? '+workbench-custom' : '');
  const outputContract = [
    'STANDALONE GENUI WORKBENCH INPUT AND OUTPUT',
    'This is one standalone Interactive page. There is no course, database, media generation, host resource upload or TTS service. narration.text is kept as a script for the teacher; omit audioResourceId.',
    'The user JSON supplies page.id, page.title, source, instruction and optionally previousScene. Treat instruction as the explicit teacher request. When previousScene is supplied, edit that scene and preserve its identity and unrelated content.',
    `Return exactly one complete InteractiveScene JSON object, without Markdown or an outer scene wrapper. Its id must be ${JSON.stringify(id)}.`,
    'Use the following original JSON output schema. In payloadFields set the inapplicable flat fields to null; the original host parser restores their discriminated canonical representation.',
    JSON.stringify(INTERACTIVE_SCENE_SCHEMA.schema),
  ].join('\n\n');
  const messages: Message[] = [
    { role: 'system', content: `${customPrompt ?? INTERACTIVE_PROMPT.text}\n\n${outputContract}` },
    {
      role: 'user',
      content: JSON.stringify({
        page: {
          id,
          title: previousScene?.title ?? title,
          sceneType: 'interactive',
          visibleTitleMode: 'topic',
        },
        source: instruction,
        instruction,
        ...(previousScene ? { previousScene } : {}),
      }),
    },
  ];

  // Reuse one parser instance for both attempts. It freezes the original's repair invariants;
  // replacing it for the correction would let a model rewrite protected content undetected.
  const parseGenerated = createGeneratedInteractiveSceneParser(id);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await complete(config, messages, fetchImplementation, signal);
    try {
      const scene: InteractiveScene = parseGenerated(parseModelJson(content));
      await assertInteractiveDocumentStaticallyCompiles(scene.documentHtml);
      assertInteractiveInitializationContract(scene.documentHtml);
      return { scene, promptVersion };
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        messages.push(
          { role: 'assistant', content },
          {
            role: 'user',
            content: [
              'The host rejected that scene. Return the complete corrected JSON once.',
              'Correct only the diagnosed structural/script/marker problem. Preserve id, title, policy, eventManifest, narration, runtime pins, teaching content and unaffected HTML/scripts. Do not replace the activity to evade validation.',
              validationMessage(error),
            ].join('\n'),
          },
        );
      }
    }
  }
  throw new HttpError(
    422,
    'generation_invalid',
    `模型生成的互动页面未通过校验：${validationMessage(lastError)}。若自动校正触发受保护内容限制，可修改需求后重新生成，或在 HTML 页签手动编辑并校验。`,
  );
}
