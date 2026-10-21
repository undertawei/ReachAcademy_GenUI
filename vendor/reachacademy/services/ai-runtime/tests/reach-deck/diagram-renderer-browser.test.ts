import { describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  renderChartSvg,
  renderStaticDiagram,
  renderStaticDiagramBatch,
} from '../../lib/reach-deck/diagram-renderer.js';
import {
  acquireDeckChromium,
  DECK_CHROMIUM_SLOTS,
} from '../../lib/reach-deck/code-media-policy.js';

const render = (source: string) => renderStaticDiagram({ source, width: 800, height: 450 });

describe('static diagram local Chromium rendering', () => {
  it.each([
    [
      'SVG',
      '<svg width="800" height="450" viewBox="0 0 800 450"><rect x="100" y="100" width="200" height="160" rx="24" fill="#2563eb"/><text x="120" y="190" font-size="30" fill="white">蒸发</text></svg>',
    ],
    [
      'HTML',
      '<div style="position:relative;width:800px;height:450px"><div style="position:absolute;left:100px;top:100px;width:200px;height:160px;border-radius:24px;background:#2563eb"><span style="position:absolute;left:20px;top:50px;font-size:30px;color:white">蒸发</span></div></div>',
    ],
  ])(
    'preserves transparent %s canvas, colored nodes and labels inside their own node',
    async (_kind, source) => {
      const result = await render(source);
      expect(await sharp(result.bytes).metadata()).toMatchObject({
        width: 800,
        height: 450,
        hasAlpha: true,
      });
      const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [
        ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
      ];
      expect(pixel(0, 0)[3]).toBe(0);
      expect(pixel(799, 449)[3]).toBe(0);
      expect(pixel(200, 220)).toEqual([37, 99, 235, 255]);
      // Alpha must composite with the actual slide background, not a white screenshot matte.
      const composed = await sharp(result.bytes)
        .flatten({ background: '#f7f2e8' })
        .raw()
        .toBuffer();
      expect([...composed.subarray(0, 3)]).toEqual([247, 242, 232]);
    },
    30_000,
  );

  it('recognizes pure black labels as visible through alpha without adding a white matte', async () => {
    const result = await render(
      '<svg width="800" height="450"><text x="100" y="130" font-size="30" fill="black">凝结过程</text></svg>',
    );
    const statistics = await sharp(result.bytes).stats();
    expect(statistics.channels.slice(0, 3).every((channel) => channel.max === 0)).toBe(true);
    expect(statistics.channels[3]).toMatchObject({ min: 0, max: 255 });
  }, 30_000);

  it.each([
    '<svg width="800" height="450"><rect width="800" height="450" fill="transparent"/></svg>',
    '<svg width="800" height="450"><text x="100" y="130" font-size="30" opacity="0.01">不可见</text></svg>',
  ])(
    'rejects a visually empty transparent canvas',
    async (source) => {
      await expect(render(source)).rejects.toThrow();
    },
    30_000,
  );

  it('renders four assets with one browser and isolated closed contexts', async () => {
    const launch = chromium.launch.bind(chromium);
    const contexts: { closed: boolean }[] = [];
    const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (...args) => {
      const browser = await launch(...args);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(async (...contextArgs) => {
        const context = await newContext(...contextArgs);
        const state = { closed: false };
        contexts.push(state);
        context.on('close', () => {
          state.closed = true;
        });
        return context;
      });
      return browser;
    });
    try {
      const result = await renderStaticDiagramBatch(
        Array.from({ length: 4 }, (_, index) => ({
          source: `<svg width="800" height="450"><text x="100" y="130" font-size="28">图示 ${index}</text></svg>`,
          width: 800,
          height: 450,
        })),
      );
      expect(result).toHaveLength(4);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(contexts).toHaveLength(4);
      expect(contexts.every((context) => context.closed)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 35_000);

  it('closes the browser when a later diagram fails and never renders remaining assets', async () => {
    const launch = chromium.launch.bind(chromium);
    let closed = false;
    let contexts = 0;
    const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (...args) => {
      const browser = await launch(...args);
      browser.on('disconnected', () => {
        closed = true;
      });
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(async (...contextArgs) => {
        contexts++;
        return newContext(...contextArgs);
      });
      return browser;
    });
    try {
      await expect(
        renderStaticDiagramBatch([
          {
            source: '<svg width="800" height="450"><circle cx="100" cy="100" r="50"/></svg>',
            width: 800,
            height: 450,
          },
          { source: '<svg width="800" height="450"></svg>', width: 800, height: 450 },
          {
            source: '<svg width="800" height="450"><circle cx="100" cy="100" r="50"/></svg>',
            width: 800,
            height: 450,
          },
        ]),
      ).rejects.toThrow(/visible painted content/);
      expect(contexts).toBe(2);
      expect(closed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 35_000);

  it('settles active browser cleanup after cancellation and never starts later assets', async () => {
    const launch = chromium.launch.bind(chromium);
    const controller = new AbortController();
    let closed = false;
    let contexts = 0;
    const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (...args) => {
      const browser = await launch(...args);
      browser.on('disconnected', () => {
        closed = true;
      });
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(async (...contextArgs) => {
        const context = await newContext(...contextArgs);
        contexts++;
        controller.abort(new Error('active batch cancelled'));
        return context;
      });
      return browser;
    });
    try {
      await expect(
        renderStaticDiagramBatch(
          Array.from({ length: 4 }, () => ({
            source: '<svg width="800" height="450"><circle cx="100" cy="100" r="50"/></svg>',
            width: 800,
            height: 450,
          })),
          controller.signal,
        ),
      ).rejects.toThrow('active batch cancelled');
      expect(contexts).toBe(1);
      expect(closed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 35_000);

  it('keeps browser callbacks self-contained under the tsx worker compiler', async () => {
    const renderer = new URL('../../lib/reach-deck/diagram-renderer.ts', import.meta.url).href;
    const source =
      '<svg width="800" height="450"><text x="100" y="130" font-size="28">凝结过程</text></svg>';
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { renderStaticDiagram } from ${JSON.stringify(renderer)};
      const result = await renderStaticDiagram({ source: ${JSON.stringify(source)}, width: 800, height: 450 });
      console.log(result.contentType);`,
      ],
      { timeout: 30_000 },
    );
    expect(stdout.trim()).toBe('image/png');
  }, 35_000);

  it.each([
    ['transparent fill', '<rect x="90" y="80" width="200" height="80" fill="transparent"/>'],
    ['zero ancestor opacity', '<g opacity="0"><rect x="90" y="80" width="200" height="80"/></g>'],
    ['zero fill opacity', '<rect x="90" y="80" width="200" height="80" fill-opacity="0"/>'],
    ['faint highlight', '<rect x="90" y="80" width="200" height="80" fill-opacity="0.15"/>'],
    ['rgba highlight', '<rect x="90" y="80" width="200" height="80" fill="rgba(0,0,0,0.1)"/>'],
    [
      'multiplied ancestor opacity',
      '<g opacity="0.6"><g opacity="0.6"><rect x="90" y="80" width="200" height="80"/></g></g>',
    ],
  ])(
    'accepts low effective-alpha SVG overlay: %s',
    async (_label, overlay) => {
      await expect(
        render(
          `<svg width="800" height="450"><text x="100" y="130" font-size="28">凝结过程</text>${overlay}</svg>`,
        ),
      ).resolves.toHaveProperty('contentType', 'image/png');
    },
    30_000,
  );

  it.each([
    ['pointer-events none', '<rect x="90" y="80" width="200" height="80" pointer-events="none"/>'],
    ['half opaque overlay', '<rect x="90" y="80" width="200" height="80" fill="rgba(0,0,0,0.5)"/>'],
    ['thick path', '<path d="M90 119H290" fill="none" stroke="black" stroke-width="10"/>'],
    ['thick line', '<line x1="90" y1="119" x2="290" y2="119" stroke="black" stroke-width="10"/>'],
  ])(
    'rejects sufficiently opaque painted SVG overlay: %s',
    async (_label, overlay) => {
      await expect(
        render(
          `<svg width="800" height="450"><text x="100" y="130" font-size="28">凝结过程</text>${overlay}</svg>`,
        ),
      ).rejects.toThrow(/obscured/);
    },
    30_000,
  );

  it.each([
    [
      'gradient',
      '<div style="position:absolute;left:90px;top:90px;width:200px;height:70px;background:linear-gradient(red,blue);pointer-events:none"></div>',
      false,
    ],
    [
      'overlapping text',
      '<span style="position:absolute;left:100px;top:100px;font-size:28px">另外标签</span>',
      false,
    ],
    [
      'transparent gradient',
      '<div style="position:absolute;left:90px;top:90px;width:200px;height:70px;background:linear-gradient(rgba(0,0,0,.1),transparent)"></div>',
      true,
    ],
    [
      'transparent ancestor',
      '<div style="opacity:0"><div style="position:absolute;left:90px;top:90px;width:200px;height:70px;background:red"></div></div>',
      true,
    ],
    [
      'half opacity ancestor',
      '<div style="opacity:.5"><div style="position:absolute;left:90px;top:90px;width:200px;height:70px;background:red"></div></div>',
      false,
    ],
  ])(
    'checks HTML painted overlay: %s',
    async (_label, overlay, accepted) => {
      const task = render(
        `<div style="position:relative;width:800px;height:450px"><span style="position:absolute;left:100px;top:100px;font-size:28px">凝结过程</span>${overlay}</div>`,
      );
      if (accepted) await expect(task).resolves.toHaveProperty('contentType', 'image/png');
      else await expect(task).rejects.toThrow(/obscured/);
    },
    30_000,
  );

  it('cancels a queued diagram immediately without waiting for another browser job', async () => {
    const held = await Promise.all(
      Array.from({ length: DECK_CHROMIUM_SLOTS }, () => acquireDeckChromium()),
    );
    const controller = new AbortController();
    const pending = renderStaticDiagram({
      source: '<svg width="800" height="450"></svg>',
      width: 800,
      height: 450,
      signal: controller.signal,
    });
    controller.abort(new Error('queued diagram cancelled'));
    try {
      await expect(pending).rejects.toThrow('queued diagram cancelled');
    } finally {
      held.forEach((release) => release());
    }
  });
  it.each([
    [
      'svg',
      '<svg width="800" height="450"><rect width="800" height="450" fill="#f8fafc"/><text x="50" y="65" font-size="30">水循环：蒸发、凝结、降水</text><circle cx="200" cy="240" r="70" fill="#93c5fd"/><text x="155" y="245" font-size="24">蒸发</text></svg>',
    ],
    [
      'html',
      '<div style="position:relative;width:800px;height:450px;background:#f8fafc"><p style="position:absolute;left:40px;top:20px;font-size:30px">青铜时代时间轴</p><div style="position:absolute;left:80px;top:240px;width:640px;height:6px;background:#2563eb"></div><span style="position:absolute;left:90px;top:170px;font-size:24px">夏：约前2070年</span></div>',
    ],
    [
      'chart',
      renderChartSvg(
        {
          type: 'bar',
          labels: ['步行', '骑行', '列车'],
          values: [1.25, 5, 20],
          title: '速度（米/秒）',
        },
        800,
        450,
      ),
    ],
  ])(
    'renders Chinese %s with bundled fonts and no external network',
    async (_kind, source) => {
      const result = await render(source);
      expect(result.contentType).toBe('image/png');
      expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      const metadata = await sharp(result.bytes).metadata();
      expect(metadata.width).toBe(800);
      expect(metadata.height).toBe(450);
      const statistics = await sharp(result.bytes).stats();
      expect(Math.max(...statistics.channels.map((channel) => channel.stdev))).toBeGreaterThan(1);
    },
    30_000,
  );

  it.each([
    [
      'vertical bar',
      { type: 'bar' as const, labels: ['甲班', '乙班'], values: [42, 57], valueLabel: '人数' },
    ],
    [
      'horizontal bar',
      {
        type: 'bar' as const,
        labels: ['第一产业增加值占比', '第二产业增加值占国内生产总值的比重', '第三产业'],
        values: [-3.5, 38.3, 54.6],
        title: '三次产业结构',
        valueLabel: '百分比',
      },
    ],
    ['pie', { type: 'pie' as const, labels: ['晴', '多云', '雨', '雪'], values: [12, 9, 6, 3] }],
  ])(
    'renders a slot-sized %s chart that passes the label readability checks',
    async (_kind, spec) => {
      const source = renderChartSvg(spec, 960, 640, {
        viewport: { width: 480, height: 320 },
        typography: { tick: 18, title: 22 },
      });
      const result = await renderStaticDiagram({ source, width: 960, height: 640 });
      expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 960, height: 640 });
    },
    30_000,
  );

  it.each([
    ['empty SVG', '<svg width="800" height="450"></svg>', /visible painted content/],
    ['empty container', '<div style="width:800px;height:450px"></div>', /visible painted content/],
    [
      'partly obscured SVG label',
      '<svg width="800" height="450"><text x="100" y="100" font-size="30">凝结过程</text><rect x="150" y="65" width="150" height="55" fill="white"/></svg>',
      /obscured/,
    ],
    [
      'obscured HTML label',
      '<div style="position:relative;width:800px;height:450px"><span style="position:absolute;left:100px;top:100px;font-size:30px">凝结过程</span><div style="position:absolute;left:140px;top:90px;width:160px;height:70px;background:white"></div></div>',
      /obscured/,
    ],
    [
      'invisible drawing',
      '<svg width="800" height="450"><text x="50" y="90" font-size="30" opacity="0">不可见内容</text></svg>',
      /visible painted content/,
    ],
    [
      'clipped SVG label',
      '<svg width="800" height="450"><text x="790" y="200" font-size="30">被裁切的中文标签</text></svg>',
      /clipped/,
    ],
    [
      'HTML overflow',
      '<div style="width:1000px;height:450px;background:#2563eb;font-size:24px">越界</div>',
      /overflowing/,
    ],
    [
      'unreadable label',
      '<svg width="800" height="450"><rect x="50" y="60" width="500" height="200" fill="#2563eb"/><text x="60" y="290" font-size="3">微小标签</text></svg>',
      /below 18px/,
    ],
  ])(
    'rejects %s instead of returning a successful image',
    async (_name, source, error) => {
      await expect(render(source as string)).rejects.toThrow(error as RegExp);
    },
    30_000,
  );
});
