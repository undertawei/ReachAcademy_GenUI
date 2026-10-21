import { LAYOUT_REFERENCE_CATALOG } from '@reachany/reach-deck-dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateHarnessHtml } from '../../scripts/reach-deck/html-layout-server.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../scripts/reach-deck/html-layout/prompts.js';
import { buildReferenceAssetInstructions } from '../../lib/reach-deck/prompts/reference-design.js';
import { HTML_REFERENCE_LAYOUT_PROMPT } from '../../lib/reach-deck/html-layout/reference-tables.js';

const env = {
  REACHANY_LITELLM_BASE_URL: 'https://model.example.test',
  REACHANY_LITELLM_API_KEY: 'test-only-key',
  REACH_DECK_E2E_MODEL: 'test-model',
};
const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('HTML layout harness generation', () => {
  it('preserves the core prompt and projects layout guidance without V1 examples', async () => {
    const html = '<section id="slide"><h1>Test</h1></section>';
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ choices: [{ finish_reason: 'stop', message: { content: html } }] }),
      );
    vi.stubGlobal('fetch', fetch);
    const reference = LAYOUT_REFERENCE_CATALOG[0]!;
    const result = await generateHarnessHtml(
      { source: 'A short teaching slide', style: 'High contrast', referenceId: reference.id },
      env,
      signal(),
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [endpoint, request] = fetch.mock.calls[0]!;
    expect(endpoint).toBe('https://model.example.test/v1/chat/completions');
    const body = JSON.parse(request.body);
    expect(body.model).toBe('test-model');
    const prompt = [
      DEFAULT_SYSTEM_PROMPT,
      buildReferenceAssetInstructions(),
      HTML_REFERENCE_LAYOUT_PROMPT,
    ].join('\n\n');
    expect(body.messages[0]).toEqual({ role: 'system', content: prompt });
    const payload = JSON.parse(body.messages[1].content);
    expect(payload.content).toBe('A short teaching slide');
    expect(payload.StyleSpec.preference).toBe('High contrast');
    expect(payload.layoutReference).toEqual({
      id: reference.id,
      name: reference.name,
      principles: reference.principles,
      readingPath: reference.readingPath,
      focalHierarchy: reference.focalHierarchy,
      recommendedRatios: reference.recommendedRatios,
      examples: reference.examples.slice(0, 2).map((example) => ({
        compositionNotes: example.compositionNotes,
        visibleCopyBudget: example.brief.visibleCopyBudget,
      })),
    });
    expect(JSON.stringify(payload.layoutReference)).not.toContain('reach-deck-slide/v1');
    expect(result.html).toBe(html);
    expect(JSON.parse(result.serializedModelInput).messages[0].content).toBe(prompt);
  });

  it.each([
    null,
    [],
    {},
    { source: '   ' },
    { source: 'x'.repeat(24_001) },
    { source: 'Valid content', style: 42 },
    { source: 'Valid content', style: 'x'.repeat(4_001) },
    { source: 'Valid content', referenceId: 'unknown-layout-reference' },
  ])('rejects invalid input before requesting the model: %j', async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(generateHarnessHtml(input, env, signal())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects truncated model HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ finish_reason: 'length', message: { content: '<section id="slide">' } }],
        }),
      ),
    );
    await expect(generateHarnessHtml({ source: 'Valid content' }, env, signal())).rejects.toThrow(
      'Model HTML was truncated',
    );
  });
});
