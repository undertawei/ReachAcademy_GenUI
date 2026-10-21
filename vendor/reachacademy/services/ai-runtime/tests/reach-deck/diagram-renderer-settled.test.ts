import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  renderStaticDiagramBatch,
  renderStaticDiagramBatchSettled,
} from '../../lib/reach-deck/diagram-renderer.js';

const fake = vi.hoisted(() => ({ launch: vi.fn(), release: vi.fn() }));
vi.mock('../../lib/reach-deck/code-media-policy.js', () => ({
  acquireDeckChromium: async () => fake.release,
  deckChromiumLaunchOptions: () => ({}),
  launchDeckChromium: (launch: () => unknown) => launch(),
}));
vi.mock('playwright-core', () => ({ chromium: { launch: fake.launch } }));
vi.mock('../../lib/reach-deck/html-layout/fonts.js', () => ({
  loadHtmlLayoutFonts: async () => '',
}));

describe('settled static diagram browser batch', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['strict', 'settled'] as const)(
    'keeps one browser and applies the %s failure policy with closed contexts',
    async (policy) => {
      const png = await sharp({
        create: { width: 800, height: 450, channels: 4, background: 'white' },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="800" height="450"><rect width="400" height="450" fill="black"/></svg>',
            ),
          },
        ])
        .png()
        .toBuffer();
      const closed: ReturnType<typeof vi.fn>[] = [];
      let index = 0;
      const browser = {
        close: vi.fn(async () => {}),
        newContext: vi.fn(async () => {
          const fail = index++ === 1;
          const close = vi.fn(async () => {});
          closed.push(close);
          let evaluation = 0;
          return {
            close,
            route: vi.fn(),
            newPage: async () => ({
              setContent: async () => {
                if (fail) throw new Error('invalid second diagram');
              },
              evaluate: async () =>
                [undefined, { width: 800, height: 450, visible: true }, null][evaluation++],
              screenshot: async () => png,
            }),
          };
        }),
      };
      fake.launch.mockResolvedValue(browser);
      const inputs = [0, 1, 2].map(() => ({
        source: '<svg width="800" height="450"><rect width="400" height="450"/></svg>',
        width: 800,
        height: 450,
      }));
      if (policy === 'strict')
        await expect(renderStaticDiagramBatch(inputs)).rejects.toThrow('invalid second diagram');
      else {
        const results = await renderStaticDiagramBatchSettled(inputs);
        expect(results.map((result) => result.status)).toEqual([
          'fulfilled',
          'rejected',
          'fulfilled',
        ]);
      }
      expect(fake.launch).toHaveBeenCalledTimes(1);
      expect(closed).toHaveLength(policy === 'strict' ? 2 : 3);
      closed.forEach((close) => expect(close).toHaveBeenCalledOnce());
      expect(browser.close).toHaveBeenCalledOnce();
      expect(fake.release).toHaveBeenCalledOnce();
    },
  );
});
