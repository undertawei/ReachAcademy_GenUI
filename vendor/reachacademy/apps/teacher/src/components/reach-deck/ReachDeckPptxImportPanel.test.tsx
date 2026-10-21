// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReachDeckClient, ReachDeckModuleContext } from '@reachany/reach-deck-client';
import {
  createBlankReachDeckDocument,
  REACH_DECK_PPTX_MAX_UPLOAD_BYTES,
} from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

import { ReachDeckMaicImportPanel, ReachDeckPptxImportPanel } from './ReachDeckPptxImportPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@reachany/reach-deck-player', () => ({
  NativeV2SlideRenderer: ({
    slide,
    stage,
  }: {
    slide: { id?: string };
    stage: { width: number; height: number };
  }) => (
    <div
      data-thumbnail-slide-id={slide.id ?? ''}
      data-stage-width={stage.width}
      data-stage-height={stage.height}
    />
  ),
  ReachDeckPlayer: ({
    activePageId,
    document,
    locale,
    nativeResourceUrlsById,
    pageNavigationLocked,
    translate,
  }: {
    activePageId?: string;
    document: { title: string };
    locale?: string;
    nativeResourceUrlsById?: Readonly<Record<string, string>>;
    pageNavigationLocked?: boolean;
    translate?: unknown;
  }) => (
    <div
      data-active-page-id={activePageId}
      data-has-translate={typeof translate === 'function'}
      data-locale={locale}
      data-media-preview-url={nativeResourceUrlsById?.['media-1']}
      data-page-navigation-locked={pageNavigationLocked}
    >
      候选预览：{document.title}
    </div>
  ),
}));

const context: ReachDeckModuleContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};

describe('ReachDeckPptxImportPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('describes the explicit before-first target without inventing an anchor title', async () => {
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckPptxImportPanel
            client={{} as ReachDeckClient}
            context={context}
            onClose={vi.fn()}
            request={{ mode: 'before-first' }}
          />
        </PortalI18nProvider>,
      );
    });

    expect(container.textContent).toContain('Insert before the first page.');
    expect(container.textContent).not.toContain('undefined');
  });

  it('refuses an oversized deck at selection instead of spending the upload', async () => {
    const preflightPptx = vi.fn();
    const client = { preflightPptx } as unknown as ReachDeckClient;

    await act(async () => {
      root.render(
        <ReachDeckPptxImportPanel
          client={client}
          context={context}
          createIdempotencyKey={() => 'pptx-import-1'}
          onClose={vi.fn()}
          request={{ mode: 'create' }}
        />,
      );
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['PK'], 'huge.pptx');
    Object.defineProperty(file, 'size', { value: REACH_DECK_PPTX_MAX_UPLOAD_BYTES + 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));

    expect(container.textContent).toContain('128 MB');
    // The file is not kept, so there is nothing to preflight.
    expect(container.textContent).not.toContain('huge.pptx');
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === '解析并预览',
    );
    await act(async () => button?.click());
    expect(preflightPptx).not.toHaveBeenCalled();
  });

  it('shows structured blocking diagnostics without offering a degrading apply action', async () => {
    const preflightPptx = vi.fn().mockResolvedValue({
      ok: true,
      schemaVersion: 'reach-deck-pptx-preflight/v1',
      applicationId: `pptx-import-${'1'.repeat(32)}`,
      importerVersion: '0.1.0',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      summary: {
        slideCount: 2,
        widthEmu: 9_144_000,
        heightEmu: 6_858_000,
        partCount: 7,
        assetCount: 0,
        assetBytes: 0,
      },
      diagnostics: [
        {
          code: 'pptx.inventory.incomplete',
          severity: 'error',
          feature: 'unknown-ooxml',
          message: 'Capability inventory is incomplete.',
          location: { partPath: '/ppt/presentation.xml' },
        },
      ],
      canApply: false,
    });
    const client = { preflightPptx } as unknown as ReachDeckClient;

    await act(async () => {
      root.render(
        <ReachDeckPptxImportPanel
          client={client}
          context={context}
          createIdempotencyKey={() => 'pptx-import-1'}
          onClose={vi.fn()}
          request={{ mode: 'insert-after', afterPageId: 'page-2', anchorTitle: '第二页' }}
        />,
      );
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['PK'], 'lesson.pptx');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === '解析并预览',
    );
    await act(async () => button?.click());

    expect(preflightPptx).toHaveBeenCalledWith(
      context,
      file,
      {
        mode: 'insert-after',
        afterPageId: 'page-2',
      },
      // The panel subscribes to import progress so a long import is not silent.
      { idempotencyKey: 'pptx-import-1', onProgress: expect.any(Function) },
    );
    expect(container.textContent).toContain('2 页');
    expect(container.textContent).toContain('现有 Deck 未发生变化');
    expect(container.textContent).toContain('第二页');

    // 诊断详情收进“查看问题”弹窗，不直接铺在界面上。
    expect(container.textContent).not.toContain('pptx.inventory.incomplete');
    const issuesButton = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('查看问题'),
    );
    expect(issuesButton?.textContent).toContain('1');
    await act(async () => issuesButton?.click());
    expect(container.textContent).toContain('pptx.inventory.incomplete');
    expect(container.textContent).toContain('Capability inventory is incomplete.');

    const confirm = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === '确认并插入页面',
    );
    expect(confirm?.disabled).toBe(true);

    // 动作已经关死，状态条就得是阻断色；内容丢失的琥珀色会让人以为还能导入。
    const status = container.querySelector('[aria-live="polite"] > div') as HTMLElement;
    expect(status.className).toContain('border-[#e4b6ad]');
    expect(status.className).not.toContain('border-[#e8d3ae]');
  });

  it.each([
    ['create', false],
    ['before-first', false],
    ['create', true],
    ['before-first', true],
  ] as const)(
    'uses the fitted candidate stage in both previews and keeps %s mode mutation-free until confirmed',
    async (mode, generate) => {
      const blankDocument = createBlankReachDeckDocument({
        id: context.moduleVersionId,
        title: '服务端候选文档',
        generatedAt: '2026-08-01T01:02:03.000Z',
      });
      const importedPageId = 'imported-page-1';
      const importedSlideId = 'imported-native-slide-1';
      const result = {
        ok: true as const,
        schemaVersion: 'reach-deck-pptx-preflight/v1' as const,
        applicationId: `pptx-import-${'2'.repeat(32)}`,
        importerVersion: '0.1.0',
        sourceDigest: `sha256:${'b'.repeat(64)}`,
        summary: {
          slideCount: 1,
          widthEmu: 9_144_000,
          heightEmu: 6_858_000,
          partCount: 5,
          assetCount: 0,
          assetBytes: 0,
        },
        diagnostics: [],
        mapping: {
          schemaVersion: 'pptx-reach-deck-v2-mapping/v1' as const,
          generatedAt: '2026-08-01T01:02:03.000Z',
          profileDigest: `sha256:${'c'.repeat(64)}`,
          candidateDigest: `sha256:${'d'.repeat(64)}`,
          mediaDigest: `sha256:${'e'.repeat(64)}`,
          document: {
            ...blankDocument,
            pages: [
              {
                ...blankDocument.pages[0]!,
                pageId: importedPageId,
                title: '第一页',
              },
            ],
            nativeSlides: [
              {
                pageId: importedPageId,
                slide: {
                  schemaVersion: 'reach-deck-slide/v2' as const,
                  id: importedSlideId,
                  title: '第一页',
                  background: { kind: 'none' as const },
                  elements: [],
                  animations: [],
                },
              },
            ],
          },
          pageReports: [
            {
              pageId: importedPageId,
              sourceOrder: 1,
              title: '第一页',
              status: 'ok' as const,
              diagnostics: [],
            },
          ],
        },
        canApply: true,
        canApplyDegraded: true,
      };
      const preflightPptx = vi.fn().mockResolvedValue(result);
      const onConfirm = vi.fn();
      const client = { preflightPptx } as unknown as ReachDeckClient;
      await act(async () => {
        root.render(
          <ReachDeckPptxImportPanel
            client={client}
            context={context}
            createIdempotencyKey={() => 'pptx-import-2'}
            onClose={vi.fn()}
            onConfirm={onConfirm}
            request={{ mode }}
          />,
        );
      });
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['PK'], 'new-deck.pptx');
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      await act(async () =>
        [...container.querySelectorAll('button')]
          .find((candidate) => candidate.textContent === '解析并预览')
          ?.click(),
      );

      const renderers = container.querySelectorAll(
        `[data-thumbnail-slide-id="${importedSlideId}"]`,
      );
      expect(renderers).toHaveLength(2);
      for (const renderer of renderers) {
        expect(renderer.getAttribute('data-stage-width')).toBe('1600');
        expect(renderer.getAttribute('data-stage-height')).toBe('900');
      }
      expect(onConfirm).not.toHaveBeenCalled();
      expect(container.textContent).toContain('1. 第一页');
      expect(
        container.querySelector(`[data-thumbnail-slide-id="${importedSlideId}"]`),
      ).not.toBeNull();
      await act(async () =>
        [...container.querySelectorAll('button')]
          .find(
            (candidate) =>
              candidate.textContent ===
              (generate
                ? '导入并生成讲稿、音频和动画'
                : mode === 'create'
                  ? '确认并新建 Deck'
                  : '确认并插入页面'),
          )
          ?.click(),
      );
      expect(onConfirm).toHaveBeenCalledWith({
        ...(generate ? { completionAction: 'generate-narration' } : {}),
        file,
        idempotencyKey: 'pptx-import-2',
        request: { mode },
        result,
        acceptDegraded: false,
      });
    },
  );

  it('detects a compatible JSON document and keeps its preview copy format-neutral', async () => {
    const result = {
      ok: true as const,
      schemaVersion: 'reach-deck-maic-preflight/v1' as const,
      applicationId: `maic-import-${'3'.repeat(32)}`,
      importerVersion: '0.1.0',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      summary: {
        pageCount: 1,
        canvasCount: 1,
        quizCount: 0,
        interactiveCount: 0,
        mediaCount: 0,
      },
      diagnostics: [
        {
          code: 'maic.document.structure',
          severity: 'warning' as const,
          feature: 'document' as const,
          message: 'MAIC JSON compatibility warning.',
        },
      ],
      mapping: {
        schemaVersion: 'maic-reach-deck-v2-mapping/v1' as const,
        generatedAt: '2026-08-13T01:02:03.000Z',
        profileDigest: `sha256:${'b'.repeat(64)}`,
        candidateDigest: `sha256:${'c'.repeat(64)}`,
        mediaDigest: `sha256:${'d'.repeat(64)}`,
        document: {
          schemaVersion: 'reach-deck-document/v2' as const,
          title: 'JSON candidate',
          stage: { width: 1600, height: 900, aspectRatio: '16:9' },
          pages: [{ pageId: 'maic-page-1', title: 'Canvas page' }],
          nativeSlides: [],
          resources: { themes: [], media: [] },
        },
        pageReports: [
          {
            pageId: 'maic-page-1',
            sourceOrder: 1,
            title: 'Canvas page',
            status: 'ok' as const,
            diagnostics: [],
          },
        ],
      },
      canApply: true,
      canApplyDegraded: true,
    };
    const preflightMaic = vi.fn().mockResolvedValue(result);
    const onConfirm = vi.fn();
    const client = { preflightMaic } as unknown as ReachDeckClient;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckMaicImportPanel
            client={client}
            context={context}
            createIdempotencyKey={() => 'maic-import-1'}
            onClose={vi.fn()}
            onConfirm={onConfirm}
            request={{ mode: 'create' }}
          />
        </PortalI18nProvider>,
      );
    });

    expect(container.textContent).toContain('Create a Deck from JSON');
    expect(container.textContent).not.toContain('MAIC');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const source = JSON.stringify({ title: 'Course', width: 1600, height: 900, slides: [] });
    const file = new File([source], 'course.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: () => Promise.resolve(source),
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Parse and preview')
        ?.click(),
    );

    await act(async () => {
      await vi.waitFor(() =>
        expect(preflightMaic).toHaveBeenCalledWith(
          context,
          file,
          { mode: 'create' },
          { idempotencyKey: 'maic-import-1' },
        ),
      );
    });
    // The candidate is applicable, so its diagnostics read as notes.
    const issuesButton = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('View notes'),
    );
    await act(async () => issuesButton?.click());
    expect(container.textContent).toContain('document.structure');
    expect(container.textContent).not.toContain('JSON.document.structure');
    expect(container.textContent).not.toContain('MAIC');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Close import issues')
        ?.click(),
    );
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Confirm and create Deck')
        ?.click(),
    );
    expect(onConfirm).toHaveBeenCalledWith({
      file,
      idempotencyKey: 'maic-import-1',
      request: { mode: 'create' },
      result,
      acceptDegraded: false,
    });
  });

  it('previews Quiz and Interactive pages through a page-locked shared player', async () => {
    const result = maicPreflightResult({
      diagnostics: [],
      pages: [
        { pageId: 'quiz-page', title: 'Quiz page', sceneType: 'quiz' },
        { pageId: 'interactive-page', title: 'Interactive page', sceneType: 'interactive' },
      ],
      pageReports: [
        {
          pageId: 'quiz-page',
          sourceOrder: 1,
          title: 'Quiz page',
          status: 'ok',
          diagnostics: [],
        },
        {
          pageId: 'interactive-page',
          sourceOrder: 2,
          title: 'Interactive page',
          status: 'ok',
          diagnostics: [],
        },
      ],
    });
    const client = {
      preflightMaic: vi.fn().mockResolvedValue(result),
    } as unknown as ReachDeckClient;

    await previewMaic(root, container, client);

    const player = container.querySelector('[data-active-page-id="quiz-page"]');
    expect(player).not.toBeNull();
    expect(player?.getAttribute('data-page-navigation-locked')).toBe('true');
    expect(player?.getAttribute('data-has-translate')).toBe('true');
    expect(player?.getAttribute('data-locale')).toBe('en-US');
    expect(player?.getAttribute('data-media-preview-url')).toBe('https://preview.test/image.png');

    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('Interactive page'))
        ?.click(),
    );
    expect(container.querySelector('[data-active-page-id="interactive-page"]')).not.toBeNull();
    expect(container.textContent).not.toContain('See View issues for details.');
  });

  it('counts aggregate/page diagnostics once and retains unmatched page diagnostics', async () => {
    const pageDiagnostic = {
      code: 'maic.canvas.background_degraded',
      severity: 'warning' as const,
      feature: 'canvas',
      message: 'Background degraded.',
      location: { pageId: 'source-page', sourceOrder: 1, field: 'background' },
    };
    const orphanDiagnostic = {
      code: 'maic.canvas.orphan',
      severity: 'warning' as const,
      feature: 'canvas',
      message: 'Page diagnostic without a report.',
      location: { pageId: 'orphan-page', sourceOrder: 9, field: 'background' },
    };
    const globalDiagnostic = {
      code: 'maic.document.structure',
      severity: 'warning' as const,
      feature: 'document',
      message: 'Document diagnostic.',
    };
    const result = maicPreflightResult({
      diagnostics: [
        pageDiagnostic,
        structuredClone(pageDiagnostic),
        orphanDiagnostic,
        globalDiagnostic,
      ],
      pages: [{ pageId: 'candidate-page', title: 'Canvas page', sceneType: 'slide' }],
      pageReports: [
        {
          pageId: 'candidate-page',
          sourceOrder: 1,
          title: 'Canvas page',
          status: 'warning',
          diagnostics: [structuredClone(pageDiagnostic)],
        },
      ],
    });
    const client = {
      preflightMaic: vi.fn().mockResolvedValue(result),
    } as unknown as ReachDeckClient;

    await previewMaic(root, container, client);

    const issuesButton = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('View notes'),
    );
    expect(issuesButton?.textContent).toContain('3');
    await act(async () => issuesButton?.click());
    expect(container.textContent?.match(/canvas\.background_degraded/g)).toHaveLength(1);
    expect(container.textContent?.match(/canvas\.orphan/g)).toHaveLength(1);
    expect(container.textContent?.match(/document\.structure/g)).toHaveLength(1);
    expect(container.textContent).toContain('Other page issues');
    // Nothing was lost, so the warning page reads as simplified, not partial.
    expect(container.textContent).toContain('complete; some styling simplified');
    expect(container.textContent).not.toContain('individual elements omitted');
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'localizes chart compatibility diagnostics with field context in %s',
    async (locale) => {
      const cases = [
        ['option_unsupported', 'options.lineSmooth'],
        ['option_unsupported', 'options.axisMinimum'],
        ['color_unsupported', 'themeColors[1]'],
        ['data_invalid', 'data.series[0][2]'],
        ['type_unsupported', 'chartType'],
        ['data_invalid', undefined],
      ] as const;
      const result = maicPreflightResult({
        diagnostics: cases.map(([code, field]) => ({
          code: 'maic.chart.' + code,
          feature: 'chart',
          severity: 'warning',
          message: 'MAIC raw chart diagnostic must not be shown: ' + code,
          ...(field ? { location: { field } } : {}),
        })),
        pages: [{ pageId: 'chart-page', title: 'Chart', sceneType: 'slide' }],
        pageReports: [],
      });
      await previewMaic(
        root,
        container,
        { preflightMaic: vi.fn().mockResolvedValue(result) } as unknown as ReachDeckClient,
        { locale },
      );
      await act(async () =>
        [...container.querySelectorAll('button')]
          .find((button) =>
            button.textContent?.includes(locale === 'zh-CN' ? '查看说明' : 'View notes'),
          )
          ?.click(),
      );
      const text = container.textContent;
      const expected =
        locale === 'zh-CN'
          ? [
              '平滑折线将显示为直线，分类和数值保持不变。',
              '暂不支持图表设置 options.axisMinimum，将使用原生图表默认值。',
              '暂不支持图表颜色 themeColors[1]，将使用默认系列颜色。',
              '图表数据 data.series[0][2] 无效，该页无法导入。',
              '暂不支持 chartType 指定的图表类型，目前仅支持折线图。',
              '图表数据 未指定字段 无效，该页无法导入。',
            ]
          : [
              'Smooth lines will display as straight segments; categories and values remain unchanged.',
              'Chart setting options.axisMinimum is not supported; native chart defaults are used.',
              'Chart color themeColors[1] is not supported; the default series color is used.',
              'Chart data at data.series[0][2] is invalid; this page cannot be imported.',
              'Chart type at chartType is not supported; only line charts can currently be imported.',
              'Chart data at unspecified field is invalid; this page cannot be imported.',
            ];
      for (const value of expected) expect(text).toContain(value);
      expect(text).not.toContain('raw chart diagnostic');
      expect(text).not.toContain('MAIC');
    },
  );

  it('localizes image conversion notes and falls back for malformed details', async () => {
    const validDiagnostic = {
      code: 'maic.media.image_normalized',
      severity: 'warning' as const,
      feature: 'media',
      message:
        'MAIC image image/gif (1727357 bytes) was converted to image/webp (691396 bytes) for Reach Deck compatibility.',
      details: {
        sourceContentType: 'image/gif',
        sourceByteLength: 1_727_357,
        storedContentType: 'image/webp',
        storedByteLength: 691_396,
      },
    };
    const malformedDiagnostic = {
      ...validDiagnostic,
      message: 'MAIC image conversion details were unavailable.',
      details: { sourceContentType: 'image/gif' },
    };
    const result = maicPreflightResult({
      diagnostics: [validDiagnostic, malformedDiagnostic],
      pages: [{ pageId: 'candidate-page', title: 'Canvas page', sceneType: 'slide' }],
      pageReports: [
        {
          pageId: 'candidate-page',
          sourceOrder: 1,
          title: 'Canvas page',
          status: 'ok',
          diagnostics: [],
        },
      ],
    });
    const client = {
      preflightMaic: vi.fn().mockResolvedValue(result),
    } as unknown as ReachDeckClient;

    await previewMaic(root, container, client);
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('View notes'))
        ?.click(),
    );
    expect(container.textContent).toContain(
      'image/gif image (1727357 bytes) was converted to image/webp (691396 bytes) for Reach Deck compatibility.',
    );
    expect(container.textContent).toContain('image conversion details were unavailable.');

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckMaicImportPanel
            client={client}
            context={context}
            createIdempotencyKey={() => 'maic-import-preview'}
            onClose={vi.fn()}
            request={{ mode: 'create' }}
          />
        </PortalI18nProvider>,
      );
    });
    expect(container.textContent).toContain(
      'image/gif 图片（1727357 字节）已转换为 image/webp（691396 字节）以兼容 Reach Deck。',
    );
    expect(container.textContent).not.toContain(
      'image/gif image (1727357 bytes) was converted to image/webp',
    );
    expect(container.textContent).toContain('image conversion details were unavailable.');
  });

  it('offers a direct confirm for an applicable candidate and a degrading apply only when content is lost', async () => {
    const lossDiagnostic = {
      code: 'maic.canvas.dropped',
      severity: 'error' as const,
      feature: 'canvas',
      message: 'An element could not be imported.',
      location: { pageId: 'source-page', sourceOrder: 1, field: 'elements' },
    };
    const page = { pageId: 'candidate-page', title: 'Canvas page', sceneType: 'slide' as const };

    // Applicable candidate: direct confirmation, no "Import anyway".
    const applicable = maicPreflightResult({
      diagnostics: [],
      pages: [page],
      pageReports: [
        {
          pageId: 'candidate-page',
          sourceOrder: 1,
          title: 'Canvas page',
          status: 'ok' as const,
          diagnostics: [],
        },
      ],
    });
    await previewMaic(root, container, {
      preflightMaic: vi.fn().mockResolvedValue(applicable),
    } as unknown as ReachDeckClient);
    expect(container.textContent).toContain('Native conversion passed');
    const buttonLabels = () =>
      [...container.querySelectorAll('button')].map((candidate) => candidate.textContent ?? '');
    expect(buttonLabels()).toContain('Confirm and create Deck');
    expect(buttonLabels().some((label) => label.includes('Import anyway'))).toBe(false);

    // Lost content: the degrading apply replaces the direct confirmation.
    const degraded = {
      ...maicPreflightResult({
        diagnostics: [lossDiagnostic],
        pages: [page],
        pageReports: [
          {
            pageId: 'candidate-page',
            sourceOrder: 1,
            title: 'Canvas page',
            status: 'warning' as const,
            diagnostics: [structuredClone(lossDiagnostic)],
          },
        ],
      }),
      canApply: false,
    };
    await previewMaic(root, container, {
      preflightMaic: vi.fn().mockResolvedValue(degraded),
    } as unknown as ReachDeckClient);
    expect(container.textContent).toContain('Some content cannot be imported');
    expect(buttonLabels().some((label) => label.includes('Import anyway'))).toBe(true);
    expect(buttonLabels()).not.toContain('Confirm and create Deck');

    // Lost content that the server still deems applicable — the PPTX gate,
    // which refuses only an unreadable file — keeps the direct confirmation
    // but must call the loss a loss, not "styling simplified".
    const applicableWithLoss = maicPreflightResult({
      diagnostics: [structuredClone(lossDiagnostic)],
      pages: [page],
      pageReports: [
        {
          pageId: 'candidate-page',
          sourceOrder: 1,
          title: 'Canvas page',
          status: 'warning' as const,
          diagnostics: [structuredClone(lossDiagnostic)],
        },
      ],
    });
    await previewMaic(root, container, {
      preflightMaic: vi.fn().mockResolvedValue(applicableWithLoss),
    } as unknown as ReachDeckClient);
    expect(container.textContent).toContain('some content could not be carried over');
    expect(container.textContent).not.toContain('no content lost');
    expect(buttonLabels()).toContain('Confirm and create Deck');
    expect(buttonLabels().some((label) => label.includes('Import anyway'))).toBe(false);
    expect(buttonLabels().some((label) => label.startsWith('View issues'))).toBe(true);
  });

  it.each([
    [
      'en-US',
      'MAIC media preview expired or is unavailable; parse and preview the file again',
      'The import preview has expired or is unavailable. Parse and preview the file again, then confirm the new preview.',
    ],
    [
      'zh-CN',
      'MAIC media preview expired or is unavailable; parse and preview the file again',
      '导入预览已过期或暂不可用，请重新解析并预览文件，再确认新的预览结果。',
    ],
    [
      'en-US',
      'MAIC mapping identity does not match the previewed candidate',
      'The import content no longer matches the preview. Parse and preview the file again before importing.',
    ],
    [
      'zh-CN',
      'MAIC mapping identity does not match the previewed candidate',
      '待导入内容与预览不一致，请重新解析并预览文件后再导入。',
    ],
  ] as const)(
    'shows an actionable localized JSON confirmation error in %s: %s',
    async (locale, errorMessage, expected) => {
      const result = maicPreflightResult({
        diagnostics: [],
        pages: [{ pageId: 'page-1', title: 'Page one', sceneType: 'slide' }],
        pageReports: [],
      });
      const client = {
        preflightMaic: vi.fn().mockResolvedValue(result),
      } as unknown as ReachDeckClient;
      const onConfirm = vi.fn().mockRejectedValue(new Error(errorMessage));
      await previewMaic(root, container, client, { locale, onConfirm });
      const label = locale === 'zh-CN' ? '确认并新建 Deck' : 'Confirm and create Deck';
      const confirm = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === label,
      );
      expect(confirm).toBeDefined();
      await act(async () => confirm?.click());
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
      expect(container.textContent).not.toContain(errorMessage);
      expect(container.textContent).not.toContain('MAIC');
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'starts the JSON import generation action once in %s',
    async (locale) => {
      const result = maicPreflightResult({
        diagnostics: [],
        pages: [{ pageId: 'page-1', title: 'Page one', sceneType: 'slide' }],
        pageReports: [],
      });
      const client = {
        preflightMaic: vi.fn().mockResolvedValue(result),
      } as unknown as ReachDeckClient;
      let finish!: () => void;
      const onConfirm = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await previewMaic(root, container, client, { locale, onConfirm });
      const label =
        locale === 'zh-CN'
          ? '导入并生成讲稿、音频和动画'
          : 'Import and generate narration, audio and animation';
      const button = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === label,
      )!;
      expect(button).toBeDefined();
      await act(async () => {
        button.click();
        button.click();
      });
      expect(onConfirm).toHaveBeenCalledOnce();
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ completionAction: 'generate-narration', acceptDegraded: false }),
      );
      expect(button.disabled).toBe(true);
      await act(async () => finish());
      expect(button.disabled).toBe(false);
    },
  );

  it('rejects an unrelated JSON shape before calling the compatibility parser', async () => {
    const preflightMaic = vi.fn();
    const client = { preflightMaic } as unknown as ReachDeckClient;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckMaicImportPanel
            client={client}
            context={context}
            createIdempotencyKey={() => 'json-import-1'}
            onClose={vi.fn()}
            request={{ mode: 'create' }}
          />
        </PortalI18nProvider>,
      );
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const source = JSON.stringify({ version: 1, pages: [] });
    const file = new File([source], 'course.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: () => Promise.resolve(source),
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === '解析并预览')
        ?.click(),
    );

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '暂不支持此 JSON 格式',
    );
    expect(container.textContent).not.toContain('MAIC');
    expect(preflightMaic).not.toHaveBeenCalled();
  });
});

function maicPreflightResult(input: {
  diagnostics: Array<Record<string, unknown>>;
  pages: Array<{ pageId: string; title: string; sceneType: 'slide' | 'quiz' | 'interactive' }>;
  pageReports: Array<Record<string, unknown>>;
}) {
  return {
    ok: true as const,
    schemaVersion: 'reach-deck-maic-preflight/v1' as const,
    applicationId: `maic-import-${'4'.repeat(32)}`,
    importerVersion: '0.2.1',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    summary: {
      pageCount: input.pages.length,
      canvasCount: input.pages.filter((page) => page.sceneType === 'slide').length,
      quizCount: input.pages.filter((page) => page.sceneType === 'quiz').length,
      interactiveCount: input.pages.filter((page) => page.sceneType === 'interactive').length,
      mediaCount: 1,
    },
    diagnostics: input.diagnostics,
    mapping: {
      schemaVersion: 'maic-reach-deck-v2-mapping/v1' as const,
      generatedAt: '2026-09-08T01:02:03.000Z',
      profileDigest: `sha256:${'b'.repeat(64)}`,
      candidateDigest: `sha256:${'c'.repeat(64)}`,
      mediaDigest: `sha256:${'d'.repeat(64)}`,
      document: {
        schemaVersion: 'reach-deck-document/v2' as const,
        id: 'candidate-document',
        title: 'JSON candidate',
        language: 'en-US',
        stage: { width: 1600, height: 900, aspectRatio: '16:9' },
        pages: input.pages,
        nativeSlides: [],
        resources: { themes: [], media: [] },
      },
      pageReports: input.pageReports,
      mediaPreviewUrls: { 'media-1': 'https://preview.test/image.png' },
    },
    canApply: true,
    canApplyDegraded: true,
  };
}

async function previewMaic(
  root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  client: ReachDeckClient,
  options: { locale?: 'en-US' | 'zh-CN'; onConfirm?: () => Promise<void> } = {},
) {
  await act(async () => {
    root.render(
      <PortalI18nProvider locale={options.locale ?? 'en-US'}>
        <ReachDeckMaicImportPanel
          client={client}
          context={context}
          createIdempotencyKey={() => 'maic-import-preview'}
          onClose={vi.fn()}
          onConfirm={options.onConfirm}
          request={{ mode: 'create' }}
        />
      </PortalI18nProvider>,
    );
  });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const sourceText = JSON.stringify({ title: 'Course', width: 1600, height: 900, slides: [] });
  const file = new File([sourceText], 'course.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    configurable: true,
    value: () => Promise.resolve(sourceText),
  });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find(
        (candidate) =>
          candidate.textContent ===
          (options.locale === 'zh-CN' ? '解析并预览' : 'Parse and preview'),
      )
      ?.click(),
  );
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        options.locale === 'zh-CN' ? '个媒体资源' : 'media resources',
      ),
    );
  });
}
