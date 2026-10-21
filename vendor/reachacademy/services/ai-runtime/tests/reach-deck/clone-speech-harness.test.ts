import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ReachDeckSpeechMarkupV1 } from '@reachany/reach-deck-dsl';

import {
  CLONE_SPEECH_HARNESS_MAX_REQUEST_BYTES,
  normalizeCloneSpeechHarnessCliArguments,
  prepareCloneSpeechHarness,
  proxyCloneSpeechAlignment,
  proxyCloneSpeechAsr,
  proxyCloneSpeechComparison,
  proxyCloneSpeechPreview,
  resolveCloneSpeechHarnessOutputDirectory,
  resolveCloneSpeechModelServiceUrl,
  startCloneSpeechHarnessServer,
  type CloneSpeechHarnessPreviewInput,
} from '../../scripts/reach-deck/clone-speech-harness.js';

const outputDirectory = resolveCloneSpeechHarnessOutputDirectory(
  `tmp/clone-speech-harness-test-${randomUUID()}`,
);

describe('Reach Deck clone speech harness', () => {
  beforeAll(async () => {
    await prepareCloneSpeechHarness({ outputDirectory });
  }, 30_000);

  afterAll(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it('accepts pnpm forwarding with or without its option delimiter', () => {
    expect(normalizeCloneSpeechHarnessCliArguments(['--', '--port', '4173'])).toEqual([
      '--port',
      '4173',
    ]);
    expect(normalizeCloneSpeechHarnessCliArguments(['--port', '4173'])).toEqual(['--port', '4173']);
  });

  it('emits the real editor bundle and serves it with restrictive browser headers', async () => {
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
    });
    try {
      const response = await fetch(harness.origin);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(html).toContain('/clone-speech-harness.js');
      expect(html).toContain('/clone-speech-harness.css');
      expect(html).not.toContain('apps/teacher');
    } finally {
      await harness.close();
    }
  });

  it('requires an exact same-origin JSON POST before calling model-service', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const missingOrigin = await fetch(`${harness.origin}/preview`, {
        body: JSON.stringify(previewInput()),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const foreignOrigin = await fetch(`${harness.origin}/preview`, {
        body: JSON.stringify(previewInput()),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:9999',
        },
        method: 'POST',
      });
      const wrongType = await fetch(`${harness.origin}/preview`, {
        body: JSON.stringify(previewInput()),
        headers: { 'Content-Type': 'text/plain', Origin: harness.origin },
        method: 'POST',
      });

      expect(missingOrigin.status).toBe(404);
      expect(foreignOrigin.status).toBe(404);
      expect(wrongType.status).toBe(400);
      expect(await wrongType.json()).toEqual({ code: 'SPEECH_TOOL_INVALID_REQUEST' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('bounds chunked request bodies while keeping the connection response safe', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const response = await postChunked(`${harness.origin}/preview`, [
        '{"markdown":"',
        'x'.repeat(CLONE_SPEECH_HARNESS_MAX_REQUEST_BYTES),
        '"}',
      ]);

      expect(response.status).toBe(413);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.json()).toEqual({ code: 'SPEECH_TOOL_INVALID_REQUEST' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('rejects unknown request fields without forwarding them', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const response = await fetch(`${harness.origin}/preview`, {
        body: JSON.stringify({ ...previewInput(), input: '<speak>raw XML</speak>' }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'SPEECH_TOOL_INVALID_REQUEST' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it.each([
    [
      'break',
      '你好',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 300 }],
      },
      '<break',
    ],
    [
      'sub',
      '甲乙',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from: 0, to: 1, alias: '替换' }],
      },
      '<sub',
    ],
    [
      'soundEvent',
      '甲乙',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'soundEvent', at: 1, src: 'https://example.com/chime.mp3' }],
      },
      '<soundEvent',
    ],
    [
      'say-as',
      '2026年',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'say-as', from: 0, to: 4, interpretAs: 'Cardinal' }],
      },
      '<say-as',
    ],
    [
      'phoneme',
      '你好',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'phoneme', from: 0, to: 1, alphabet: 'py', ph: 'ni3' }],
      },
      '<phoneme',
    ],
  ] as const)(
    'serializes the structured %s mark rather than accepting browser XML',
    async (_type, markdown, speechMarkup, expectedTag) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(Uint8Array.from([1, 2, 3]), {
          headers: { 'Content-Type': 'audio/mpeg' },
          status: 200,
        }),
      );

      const result = await proxyCloneSpeechPreview(
        {
          markdown,
          markdownFrom: 0,
          markdownTo: markdown.length,
          speechMarkup: {
            schemaVersion: speechMarkup.schemaVersion,
            marks: [...speechMarkup.marks],
          } as ReachDeckSpeechMarkupV1,
        },
        new AbortController().signal,
        {
          fetchImpl,
          identityFactory: () => 'mark-test',
          modelServiceUrl: 'http://127.0.0.1:18100',
        },
      );
      const forwarded = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<
        string,
        unknown
      >;

      expect(result).toEqual({ contentType: 'audio/mpeg', dataBase64: 'AQID' });
      expect(forwarded.input).toContain(expectedTag);
      expect(forwarded.input_type).toBe('ssml');
      expect(forwarded.alignment_transcript).not.toContain('<');
    },
  );

  it('serializes every speak setting before forwarding the experimental request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), {
        headers: { 'Content-Type': 'audio/mpeg' },
        status: 200,
      }),
    );
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [],
      speak: {
        bgm: 'https://example.com/music.mp3?track=1&loop=true',
        backgroundMusicVolume: 35,
        effect: 'speech_dialogue',
      },
    };

    await proxyCloneSpeechPreview(
      { markdown: '正文', markdownFrom: 0, markdownTo: 2, speechMarkup },
      new AbortController().signal,
      {
        fetchImpl,
        identityFactory: () => 'speak-settings',
        modelServiceUrl: 'http://127.0.0.1:18100',
      },
    );

    const forwarded = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(forwarded.input).toBe(
      '<speak bgm="https://example.com/music.mp3?track=1&amp;loop=true" backgroundMusicVolume="35" effect="speech_dialogue">正文</speak>',
    );
    expect(forwarded.alignment_transcript).toBe('正文');
  });

  it('returns default and clone tracks generated from identical SSML', async () => {
    let responseIndex = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      responseIndex += 1;
      return new Response(Uint8Array.from([responseIndex]), {
        headers: { 'Content-Type': 'audio/mpeg' },
        status: 200,
      });
    });

    const result = await proxyCloneSpeechComparison(previewInput(), new AbortController().signal, {
      fetchImpl,
      identityFactory: () => 'comparison-id',
      modelServiceUrl: 'http://127.0.0.1:18100',
    });

    expect(result).toEqual({
      tracks: [
        { id: 'default', label: '默认音色', contentType: 'audio/mpeg', dataBase64: 'AQ==' },
        { id: 'clone', label: '克隆音色', contentType: 'audio/mpeg', dataBase64: 'Ag==' },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![1]?.body).toBe(fetchImpl.mock.calls[1]![1]?.body);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.headers)).toEqual([
      expect.objectContaining({
        'X-ReachAny-TTS-Request-Identity': 'local-default-preview:comparison-id',
        'X-ReachAny-TTS-Voice-Mode': 'default',
      }),
      expect.objectContaining({
        'X-ReachAny-TTS-Request-Identity': 'local-clone-preview:comparison-id',
        'X-ReachAny-TTS-Voice-Mode': 'clone',
      }),
    ]);
  });

  it('forwards experimental switches and offsets native words across audio chunks', async () => {
    let responseIndex = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      responseIndex += 1;
      return new Response(
        JSON.stringify({
          contentType: 'audio/mpeg',
          dataBase64: Buffer.from([responseIndex]).toString('base64'),
          durationSeconds: 1.5,
          words: [{ word: `字${responseIndex}`, startTime: 0.2, endTime: 0.5 }],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    });
    const markdown = '这是一段用于验证整篇讲稿试听的文字。'.repeat(24);
    const result = await proxyCloneSpeechPreview(
      {
        markdown,
        markdownFrom: 0,
        markdownTo: markdown.length,
        inputMode: 'ssml_field',
        enableSubtitle: true,
        enableTimestamp: false,
      },
      new AbortController().signal,
      {
        fetchImpl,
        identityFactory: () => 'subtitle-chunks',
        modelServiceUrl: 'http://127.0.0.1:18100',
      },
    );

    expect(responseIndex).toBeGreaterThan(1);
    expect(result.durationSeconds).toBe(responseIndex * 1.5);
    expect(result.words).toHaveLength(responseIndex);
    expect(result.words?.[0]).toEqual({ word: '字1', startTime: 0.2, endTime: 0.5 });
    expect(result.words?.[1]).toEqual({ word: '字2', startTime: 1.7, endTime: 2 });
    expect(result.sourceText).toBe(markdown);
    expect(result.spokenText).toBe(markdown);
    expect(result.ssml).toHaveLength(responseIndex);
    expect(result.chunks).toHaveLength(responseIndex);
    expect(result.chunks?.[0]).toEqual(
      expect.objectContaining({
        offsetSeconds: 0,
        durationSeconds: 1.5,
        alignmentTranscript: expect.any(String),
      }),
    );
    expect(result.chunks?.[1]?.offsetSeconds).toBe(1.5);
    expect(
      result.chunks?.map((chunk) => chunk.sourceUnits.map((unit) => unit.text).join('')).join(''),
    ).toBe(markdown);
    expect(result.inputMode).toBe('ssml_field');
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual(
      Array.from({ length: responseIndex }, () =>
        expect.objectContaining({
          input_mode: 'ssml_field',
          enable_subtitle: true,
          enable_timestamp: false,
        }),
      ),
    );
  });

  it('keeps original text, spoken alias and SSML distinct for a sub mark', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          contentType: 'audio/mpeg',
          dataBase64: 'AQID',
          durationSeconds: 1,
          words: [{ word: 'A-P-I', startTime: 0.1, endTime: 0.7 }],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    const result = await proxyCloneSpeechPreview(
      {
        markdown: 'API',
        markdownFrom: 0,
        markdownTo: 3,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'sub', from: 0, to: 3, alias: 'A-P-I' }],
        },
        inputMode: 'ssml_text_type',
        enableSubtitle: true,
        enableTimestamp: false,
      },
      new AbortController().signal,
      {
        fetchImpl,
        modelServiceUrl: 'http://127.0.0.1:18100',
      },
    );
    expect(result.sourceText).toBe('API');
    expect(result.spokenText).toBe('A-P-I');
    expect(result.chunks?.[0]?.sourceUnits).toEqual([
      { text: 'API', spoken: 'A-P-I', atomic: true },
    ]);
    expect(result.ssml).toEqual(['<speak><sub alias="A-P-I">API</sub></speak>']);
  });

  it('rejects invalid experimental switches at the same-origin proxy boundary', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const response = await fetch(`${harness.origin}/preview`, {
        body: JSON.stringify({
          ...previewInput(),
          inputMode: 'ssml_field',
          enableSubtitle: 'true',
          enableTimestamp: false,
        }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      expect(response.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('compares ASR words from the same audio through the local model-service route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: '你好',
          elapsedMs: 912,
          words: [
            { word: '你', startTime: 0.41, endTime: 0.62 },
            { word: '好', startTime: 0.62, endTime: 0.83 },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    const dataBase64 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00').toString('base64');
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const response = await fetch(`${harness.origin}/asr`, {
        body: JSON.stringify({ dataBase64 }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        text: '你好',
        elapsedMs: 912,
        words: [
          { word: '你', startTime: 0.41, endTime: 0.62 },
          { word: '好', startTime: 0.62, endTime: 0.83 },
        ],
      });
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        'http://127.0.0.1:18100/internal/dev/v1/reach-deck/clone-speech/asr',
      );
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ dataBase64 });
    } finally {
      await harness.close();
    }
  });

  it('rejects cross-origin and oversized ASR requests before forwarding audio', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const wrongOrigin = await fetch(`${harness.origin}/asr`, {
        body: JSON.stringify({ dataBase64: 'AQID' }),
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:9999' },
        method: 'POST',
      });
      expect(wrongOrigin.status).toBe(404);
      const tooLarge = await fetch(`${harness.origin}/asr`, {
        body: JSON.stringify({ dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      expect(tooLarge.status).toBe(400);
      const oversizedBody = await fetch(`${harness.origin}/asr`, {
        body: JSON.stringify({ dataBase64: Buffer.alloc(9 * 1024 * 1024).toString('base64') }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      expect(oversizedBody.status).toBe(413);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('filters malformed ASR responses and upstream diagnostics', async () => {
    const audio = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00').toString('base64');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private provider diagnostic', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            text: '你好',
            elapsedMs: 800,
            words: [{ word: '你', startTime: 0.8, endTime: -1 }],
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );
    const options = { fetchImpl, modelServiceUrl: 'http://127.0.0.1:18100' };
    for (const status of [502, 502]) {
      await expect(
        proxyCloneSpeechAsr(audio, new AbortController().signal, options),
      ).rejects.toMatchObject({ code: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE', status });
    }
  });

  it('proxies a bounded Seed alignment chunk through the same-origin local route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          elapsedMs: 1512,
          exact: true,
          words: [{ word: '你好', startTime: 0.2, endTime: 0.8 }],
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    const dataBase64 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00').toString('base64');
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      const wrongOrigin = await fetch(`${harness.origin}/align`, {
        body: JSON.stringify({ dataBase64, transcript: '你好' }),
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:9999' },
        method: 'POST',
      });
      expect(wrongOrigin.status).toBe(404);
      const invalidTranscript = await fetch(`${harness.origin}/align`, {
        body: JSON.stringify({ dataBase64, transcript: '<speak>你好</speak>' }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      expect(invalidTranscript.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
      const response = await fetch(`${harness.origin}/align`, {
        body: JSON.stringify({ dataBase64, transcript: '你好' }),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        elapsedMs: 1512,
        exact: true,
        words: [{ word: '你好', startTime: 0.2, endTime: 0.8 }],
      });
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        'http://127.0.0.1:18100/internal/dev/v1/reach-deck/clone-speech/align',
      );
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
        dataBase64,
        transcript: '你好',
      });
    } finally {
      await harness.close();
    }
  });

  it('filters malformed Seed alignment words and upstream response text', async () => {
    const audio = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00').toString('base64');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private provider diagnostic', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            elapsedMs: 800,
            exact: false,
            words: [{ word: '你', startTime: 0.8, endTime: -1 }],
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );
    for (let index = 0; index < 2; index += 1) {
      await expect(
        proxyCloneSpeechAlignment(
          { dataBase64: audio, transcript: '你好' },
          new AbortController().signal,
          { fetchImpl, modelServiceUrl: 'http://127.0.0.1:18100' },
        ),
      ).rejects.toMatchObject({ code: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE', status: 502 });
    }
  });

  it('shares one preview deadline across default and clone tracks', async () => {
    const voiceModes: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      voiceModes.push((init?.headers as Record<string, string>)['X-ReachAny-TTS-Voice-Mode']!);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(Uint8Array.from([1]), {
        headers: { 'Content-Type': 'audio/mpeg' },
        status: 200,
      });
    });

    await expect(
      proxyCloneSpeechComparison(previewInput(), new AbortController().signal, {
        deadlineMs: 5,
        fetchImpl,
        identityFactory: () => 'comparison-deadline',
        modelServiceUrl: 'http://127.0.0.1:18100',
      }),
    ).rejects.toMatchObject({ code: 'SPEECH_PREVIEW_TIMEOUT', status: 504 });

    expect(voiceModes).toEqual(['default']);
  });

  it('rejects invalid experimental settings without forwarding them', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl },
    });
    try {
      for (const speechMarkup of [
        {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'soundEvent', at: 1, src: 'file:///tmp/chime.mp3' }],
        },
        {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [],
          speak: { effect: 'unsupported_effect' },
        },
      ]) {
        const response = await fetch(`${harness.origin}/preview`, {
          body: JSON.stringify({ ...previewInput(), speechMarkup }),
          headers: { 'Content-Type': 'application/json', Origin: harness.origin },
          method: 'POST',
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code: 'SPEECH_TOOL_INVALID_REQUEST' });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('synthesizes a full-document preview in order across the SSML chunk limit', async () => {
    let responseIndex = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      responseIndex += 1;
      return new Response(Uint8Array.from([responseIndex]), {
        headers: { 'Content-Type': 'audio/mpeg' },
        status: 200,
      });
    });
    const markdown = '这是一段用于验证整篇讲稿试听的文字。'.repeat(24);

    const result = await proxyCloneSpeechPreview(
      { markdown, markdownFrom: 0, markdownTo: markdown.length },
      new AbortController().signal,
      {
        fetchImpl,
        identityFactory: () => 'full-document',
        modelServiceUrl: 'http://127.0.0.1:18100',
      },
    );

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(Buffer.from(result.dataBase64, 'base64')).toEqual(
      Buffer.from(Array.from({ length: fetchImpl.mock.calls.length }, (_, index) => index + 1)),
    );
    expect(
      fetchImpl.mock.calls.map(
        (call) => (call[1]?.headers as Record<string, string>)['X-ReachAny-TTS-Request-Identity'],
      ),
    ).toEqual(
      Array.from(
        { length: fetchImpl.mock.calls.length },
        (_, index) => `local-clone-preview:full-document:${String(index + 1)}`,
      ),
    );
  });

  it('keeps one random request identity and identical provider input through queued polls', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { 'Retry-After': '2' }, status: 202 }))
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([4, 5]), {
          headers: { 'Content-Type': 'audio/mpeg' },
          status: 200,
        }),
      );
    const pollDelay = vi.fn(async () => undefined);

    await expect(
      proxyCloneSpeechPreview(previewInput(), new AbortController().signal, {
        fetchImpl,
        identityFactory: () => 'stable-id',
        modelServiceUrl: 'http://127.0.0.1:18100/api/v1',
        pollDelay,
      }),
    ).resolves.toEqual({ contentType: 'audio/mpeg', dataBase64: 'BAU=' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.headers)).toEqual([
      expect.objectContaining({
        'X-ReachAny-TTS-Request-Identity': 'local-clone-preview:stable-id',
      }),
      expect.objectContaining({
        'X-ReachAny-TTS-Request-Identity': 'local-clone-preview:stable-id',
      }),
    ]);
    expect(fetchImpl.mock.calls[0]![1]?.body).toBe(fetchImpl.mock.calls[1]![1]?.body);
    expect(pollDelay).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:18100/internal/dev/v1/reach-deck/clone-speech',
    );
  });

  it('cancels the stable upstream identity when the preview deadline expires', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(null, { headers: { 'Retry-After': '1' }, status: 202 });
    });

    await expect(
      proxyCloneSpeechPreview(previewInput(), new AbortController().signal, {
        deadlineMs: 5,
        fetchImpl,
        identityFactory: () => 'deadline-id',
        modelServiceUrl: 'http://127.0.0.1:18100',
      }),
    ).rejects.toMatchObject({ code: 'SPEECH_PREVIEW_TIMEOUT', status: 504 });

    expect(methods).toEqual(['POST', 'DELETE']);
    expect(fetchImpl.mock.calls[1]![1]?.headers).toEqual({
      'X-ReachAny-TTS-Async': 'v1',
      'X-ReachAny-TTS-Request-Identity': 'local-clone-preview:deadline-id',
      'X-ReachAny-TTS-Voice-Mode': 'clone',
    });
  });

  it('cancels an in-flight preview before closing the harness server', async () => {
    const methods: string[] = [];
    const previewStarted = Promise.withResolvers<void>();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      previewStarted.resolve();
      return new Response(null, { headers: { 'Retry-After': '60' }, status: 202 });
    });
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl, identityFactory: () => 'shutdown-id' },
    });
    const responsePromise = fetch(`${harness.origin}/preview`, {
      body: JSON.stringify(previewInput()),
      headers: { 'Content-Type': 'application/json', Origin: harness.origin },
      method: 'POST',
    });

    await previewStarted.promise;
    await expect(
      Promise.race([
        harness.close(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Harness close timed out.')), 1_000),
        ),
      ]),
    ).resolves.toBeUndefined();

    expect((await responsePromise).status).toBe(499);
    expect(methods).toEqual(['POST', 'DELETE']);
    expect(fetchImpl.mock.calls[1]![1]?.headers).toEqual({
      'X-ReachAny-TTS-Async': 'v1',
      'X-ReachAny-TTS-Request-Identity': 'local-default-preview:shutdown-id',
      'X-ReachAny-TTS-Voice-Mode': 'default',
    });
  });

  it('returns only allowlisted error data and a bounded retry delay', async () => {
    const upstreamSecret = 'provider-secret-diagnostic';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(upstreamSecret, {
        headers: {
          'Retry-After': '7',
          'X-ReachAny-TTS-Error-Code': 'TTS_PROVIDER_RATE_LIMITED',
          'X-Upstream-Debug': upstreamSecret,
        },
        status: 503,
      }),
    );
    const harness = await startCloneSpeechHarnessServer({
      modelServiceUrl: 'http://127.0.0.1:18100',
      outputDirectory,
      proxyOptions: { fetchImpl, identityFactory: () => 'privacy-id' },
    });
    try {
      const response = await fetch(`${harness.origin}/preview`, {
        body: JSON.stringify(previewInput()),
        headers: { 'Content-Type': 'application/json', Origin: harness.origin },
        method: 'POST',
      });
      const body = await response.text();

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(response.headers.get('x-upstream-debug')).toBeNull();
      expect(body).toBe('{"code":"SPEECH_TOOL_RATE_LIMITED"}');
      expect(body).not.toContain(upstreamSecret);
    } finally {
      await harness.close();
    }
  });

  it('rejects non-loopback model-service targets and non-temporary output paths', () => {
    expect(resolveCloneSpeechModelServiceUrl('http://localhost:8100')).toBe(
      'http://localhost:8100/internal/dev/v1/reach-deck/clone-speech',
    );
    expect(() => resolveCloneSpeechModelServiceUrl('https://127.0.0.1:8100')).toThrow(/loopback/);
    expect(() => resolveCloneSpeechModelServiceUrl('http://0.0.0.0:8100')).toThrow(/loopback/);
    expect(() => resolveCloneSpeechModelServiceUrl('http://model.example.test:8100')).toThrow(
      /loopback/,
    );
    expect(() => resolveCloneSpeechHarnessOutputDirectory('services/ai-runtime/generated')).toThrow(
      /tmp/,
    );
  });
});

function previewInput(): CloneSpeechHarnessPreviewInput {
  return { markdown: '你好', markdownFrom: 0, markdownTo: 2 };
}

function postChunked(url: string, chunks: readonly string[]): Promise<Response> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { 'Content-Type': 'application/json', Origin: target.origin },
        hostname: target.hostname,
        method: 'POST',
        path: target.pathname,
        port: target.port,
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => responseChunks.push(chunk));
        response.once('end', () => {
          resolve(
            new Response(Buffer.concat(responseChunks), {
              headers: new Headers(response.headers as Record<string, string>),
              status: response.statusCode,
            }),
          );
        });
      },
    );
    request.once('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
