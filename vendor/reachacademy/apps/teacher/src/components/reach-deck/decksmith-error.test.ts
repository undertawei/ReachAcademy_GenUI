import { ReachDeckApiError } from '@reachany/reach-deck-client';
import { describe, expect, it } from 'vitest';
import { REACH_DECK_MESSAGES } from '../../lib/reach-deck-i18n';
import { decksmithFailureCopy } from './decksmith-error';

describe('decksmithFailureCopy', () => {
  it('preserves the distinction between save, request acceptance, and observation failures', () => {
    for (const error of [
      ...[500, 502, 503, 504].map((status) => new ReachDeckApiError('raw gateway error', status)),
      new TypeError('Failed to fetch'),
      new TypeError('fetch failed'),
      new TypeError('NetworkError when attempting to fetch resource.'),
      new TypeError('Load failed'),
    ]) {
      for (const phase of ['save', 'start', 'observe'] as const) {
        const copy = decksmithFailureCopy(error, phase);
        expect(copy).toEqual({ key: `reachDeck.decksmith.error.${phase}Unconfirmed` });
        for (const locale of ['zh-CN', 'en-US'] as const) {
          expect(REACH_DECK_MESSAGES[locale][copy!.key]).toBeTruthy();
          expect(REACH_DECK_MESSAGES[locale][copy!.key]).not.toContain(error.message);
        }
      }
    }
    expect(REACH_DECK_MESSAGES['en-US']['reachDeck.decksmith.error.saveUnconfirmed']).toContain(
      'Decksmith has not started',
    );
    expect(REACH_DECK_MESSAGES['zh-CN']['reachDeck.decksmith.error.saveUnconfirmed']).toContain(
      '尚未启动',
    );
    expect(REACH_DECK_MESSAGES['en-US']['reachDeck.decksmith.error.startUnconfirmed']).toContain(
      'whether Decksmith accepted',
    );
    expect(REACH_DECK_MESSAGES['zh-CN']['reachDeck.decksmith.error.startUnconfirmed']).toContain(
      '是否已接收',
    );
    expect(REACH_DECK_MESSAGES['en-US']['reachDeck.decksmith.error.observeUnconfirmed']).toContain(
      'may still be running',
    );
    expect(REACH_DECK_MESSAGES['zh-CN']['reachDeck.decksmith.error.observeUnconfirmed']).toContain(
      '可能仍在运行',
    );
  });

  it('asks users to preserve edits before refreshing after a save conflict', () => {
    const copy = decksmithFailureCopy(new ReachDeckApiError('raw conflict', 409), 'save')!;
    expect(copy.key).toBe('reachDeck.decksmith.error.revisionConflict');
    expect(REACH_DECK_MESSAGES['en-US'][copy.key]).toContain('Copy them before refreshing');
    expect(REACH_DECK_MESSAGES['zh-CN'][copy.key]).toContain('先复制保留修改，再刷新');
    expect(REACH_DECK_MESSAGES['en-US'][copy.key]).not.toMatch(/has been loaded|have been saved/);
    expect(REACH_DECK_MESSAGES['zh-CN'][copy.key]).not.toMatch(/已加载|已保存/);
  });

  it.each([
    [401, undefined, 'authorization'],
    [403, undefined, 'authorization'],
    [404, undefined, 'notFound'],
    [423, undefined, 'pageLocked'],
    [409, 'BUSY', 'busyConflict'],
  ] as const)('uses safe existing copy for status %s and code %s', (status, code, key) => {
    expect(
      decksmithFailureCopy(
        new ReachDeckApiError('private backend message', status, undefined, code),
        'start',
      ),
    ).toEqual({ key: `reachDeck.workspace.error.${key}` });
  });

  it('hides unknown API messages while preserving intentional non-API validation errors', () => {
    expect(
      decksmithFailureCopy(new ReachDeckApiError('private backend message', 422), 'start'),
    ).toEqual({ key: 'reachDeck.decksmith.error.requestFailed' });
    expect(decksmithFailureCopy(new ReachDeckApiError('invalid document', 400), 'save')).toEqual({
      key: 'reachDeck.module.saveRejectedDetail',
    });
    expect(decksmithFailureCopy(new Error('请先选择页面'), 'start')).toBeUndefined();
    expect(
      decksmithFailureCopy(new TypeError('Cannot read properties of undefined'), 'save'),
    ).toBeUndefined();
    expect(
      decksmithFailureCopy(new TypeError('Failed to fetch input property'), 'save'),
    ).toBeUndefined();
  });

  it('keeps bilingual catalog keys in exact parity', () => {
    expect(Object.keys(REACH_DECK_MESSAGES['zh-CN']).sort()).toEqual(
      Object.keys(REACH_DECK_MESSAGES['en-US']).sort(),
    );
  });
});
