import { describe, expect, it } from 'vitest';

import { ReachDeckApiError } from '@reachany/reach-deck-client';
import { REACH_DECK_MESSAGES } from '../../lib/reach-deck-i18n.js';
import { geometryPublicationErrorCopy } from './geometry-publication-error.js';

describe('geometry publication errors', () => {
  it('locates the failed experiment in both application locales', () => {
    const copy = geometryPublicationErrorCopy(
      new ReachDeckApiError(
        'geometry_mathematically_invalid:page=7;instance=triangle-1;code=assertion_failed;path=assertions[0]',
        422,
      ),
    );
    expect(copy).toEqual({
      key: 'reachDeck.module.geometryInvalidAtPage',
      replacements: { page: 7, instance: 'triangle-1' },
    });
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const text = REACH_DECK_MESSAGES[locale][copy!.key]!.replace(/\{(\w+)\}/g, (_, key: string) =>
        String(copy!.replacements![key]),
      );
      expect(text).toContain('7');
      expect(text).toContain('triangle-1');
      expect(text).not.toMatch(/geometry_mathematically_invalid|assertion_failed|undefined|\{/);
    }
  });

  it.each([
    'geometry_mathematically_invalid',
    'geometry_mathematically_invalid:page=0;instance=A;code=assertion_failed;path=assertions[0]',
    'geometry_mathematically_invalid:page=2;instance=<script>;code=assertion_failed;path=assertions[0]',
    'geometry_mathematically_invalid:page=2;instance=A;code=assertion_failed;path=bad\npath',
    `geometry_mathematically_invalid:page=2;instance=A;code=assertion_failed;path=${'a'.repeat(161)}`,
    `geometry_mathematically_invalid:${'x'.repeat(2048)}`,
  ])('falls back to translated generic failure for malformed diagnostics: %s', (message) => {
    expect(geometryPublicationErrorCopy(new Error(message))).toEqual({
      key: 'reachDeck.module.geometryInvalid',
    });
  });

  it.each([
    ['geometry_evaluator_unavailable', 'reachDeck.module.geometryUnavailable'],
    ['geometry_evaluator_saturated', 'reachDeck.module.geometrySaturated'],
    [
      'geometry_structurally_invalid:page_heavy_exceeded: $',
      'reachDeck.module.geometryStructureInvalid',
    ],
    [
      'geometry_structurally_invalid:marker_bytes_exceeded: $[0]',
      'reachDeck.module.geometryStructureInvalid',
    ],
    [
      'geometry_structurally_invalid:unknown_reference: $.spec.objects.A',
      'reachDeck.module.geometryStructureInvalid',
    ],
    ['geometry_publication_limit_exceeded', 'reachDeck.module.geometryPublicationLimit'],
  ])('translates %s with actionable copy in both locales', (message, key) => {
    expect(geometryPublicationErrorCopy(new ReachDeckApiError(message, 503))).toEqual({ key });
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(REACH_DECK_MESSAGES[locale][key]).toBeTruthy();
      expect(REACH_DECK_MESSAGES[locale][key]).not.toContain('geometry_');
    }
  });

  it('leaves unrelated failures to the existing editor handling', () => {
    expect(geometryPublicationErrorCopy(new Error('revision conflict'))).toBeUndefined();
    expect(geometryPublicationErrorCopy('geometry_evaluator_unavailable')).toBeUndefined();
    expect(geometryPublicationErrorCopy(null)).toBeUndefined();
  });
});
