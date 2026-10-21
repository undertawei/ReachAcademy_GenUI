// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES,
  type ReachDeckClient,
  type ReachDeckModuleContext,
} from '@reachany/reach-deck-client';
import {
  createBlankReachDeckDocument,
  parseReachDeckDocumentV2,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

import { ReachDeckInteractiveHtmlImportPanel } from './ReachDeckInteractiveHtmlImportPanel';
import { INTERACTIVE_HTML_AUTHORING_SPEC } from './interactiveHtmlAuthoringSpec.generated';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@reachany/reach-deck-player', () => ({
  NativeV2SlideRenderer: () => <div />,
  ReachDeckPlayer: ({
    activePageId,
    geometryHostMode,
    interactiveMode,
    locale,
    pageNavigationLocked,
  }: {
    activePageId?: string;
    geometryHostMode?: string;
    interactiveMode?: string;
    locale?: string;
    pageNavigationLocked?: boolean;
  }) => (
    <div
      data-active-page-id={activePageId}
      data-geometry-host-mode={geometryHostMode}
      data-interactive-mode={interactiveMode}
      data-locale={locale}
      data-page-navigation-locked={pageNavigationLocked}
    >
      候选预览
    </div>
  ),
}));

const PAGE_ID = 'page-interactive-1';
const MODULE_VERSION_ID = '55555555-5555-4555-8555-555555555555';

const context: ReachDeckModuleContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: MODULE_VERSION_ID,
};

const interactiveScene = (documentHtml: string) => ({
  schemaVersion: 'reach-interactive-scene/v2' as const,
  id: PAGE_ID,
  title: '互动页',
  sceneType: 'interactive' as const,
  documentHtml,
  bridgeVersion: 'reach-interactive-bridge/v1' as const,
  runtimeDependencies: [],
  runtimePolicy: {
    completionMode: 'none' as const,
    allowReset: true,
    maximumDurationSeconds: null,
  },
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1' as const,
    events: [],
  },
});

const currentDocument = (): ReachDeckDocumentV2 =>
  parseReachDeckDocumentV2({
    ...createBlankReachDeckDocument({
      id: MODULE_VERSION_ID,
      title: 'Deck',
      generatedAt: '2026-09-16T00:00:00.000Z',
    }),
    pages: [
      {
        pageId: PAGE_ID,
        order: 1,
        revision: 3,
        sceneType: 'interactive',
        title: '互动页',
        scene: interactiveScene(
          '<!doctype html><html><head><meta charset="utf-8"><title>a</title></head><body><main>old</main></body></html>',
        ),
      },
    ],
    nativeSlides: [],
  });

const applicablePreflight = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  schemaVersion: 'reach-deck-interactive-html-preflight/v1',
  applicationId: `interactive-html-import-${'1'.repeat(32)}`,
  importerVersion: '0.1.0',
  pageId: PAGE_ID,
  sourceDigest: `sha256:${'a'.repeat(64)}`,
  canApply: true,
  diagnostics: [],
  targetIdentity: { draftRevision: 7, contentDigest: 'digest-7' },
  candidate: {
    generatedAt: '2026-09-16T00:00:00.000Z',
    candidateDigest: `sha256:${'b'.repeat(64)}`,
    documentHtmlUtf8Bytes: 4096,
    runtimeDependencies: [{ id: 'tailwind-browser', version: '4.3.0' }],
    page: {
      pageId: PAGE_ID,
      order: 1,
      revision: 4,
      sceneType: 'interactive',
      title: '互动页',
      scene: interactiveScene(
        '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head><meta charset="utf-8"><title>a</title></head><body><main class="flex">new</main></body></html>',
      ),
    },
    ...((overrides.candidate as Record<string, unknown>) ?? {}),
  },
  ...overrides,
});

const htmlFile = (name = 'activity.html', size?: number): File => {
  const file = new File(['<!doctype html><html></html>'], name, { type: 'text/html' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('ReachDeckInteractiveHtmlImportPanel', () => {
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

  const render = async (client: Partial<ReachDeckClient>, onConfirm = vi.fn()) => {
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckInteractiveHtmlImportPanel
            client={client as ReachDeckClient}
            context={context}
            createIdempotencyKey={() => 'interactive-html-1'}
            document={currentDocument()}
            onClose={vi.fn()}
            onConfirm={onConfirm}
            pageId={PAGE_ID}
            pageTitle="互动页"
          />
        </PortalI18nProvider>,
      );
    });
    return onConfirm;
  };

  const selectFile = async (file: File) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  };

  const clickButton = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    await act(async () => button?.click());
    return button;
  };

  it('offers the authoring spec for the teacher to hand to their own assistant', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render({});

    expect(container.textContent).toContain('编写规范');
    await clickButton('复制编写规范');

    expect(writeText).toHaveBeenCalledWith(INTERACTIVE_HTML_AUTHORING_SPEC);
    expect(container.textContent).toContain('已复制');
  });

  it('refuses an oversized file at selection instead of spending the upload', async () => {
    const preflightInteractiveHtml = vi.fn();
    await render({ preflightInteractiveHtml } as Partial<ReachDeckClient>);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const setValue = vi.fn();
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => 'C:\\fakepath\\huge.html',
      set: setValue,
    });

    await selectFile(htmlFile('huge.html', REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES + 1));

    expect(container.textContent).toContain('512 KiB');
    await clickButton('解析并预览');
    expect(preflightInteractiveHtml).not.toHaveBeenCalled();
    // The native input is reset so re-picking the same path after shrinking fires `change`.
    expect(setValue).toHaveBeenCalledWith('');
  });

  it('previews an applicable candidate and states the no-progress boundary', async () => {
    const preflightInteractiveHtml = vi.fn().mockResolvedValue(
      applicablePreflight({
        diagnostics: [
          {
            code: 'html.interactive.tailwind_version_replacement',
            severity: 'warning',
            feature: 'interactive',
            message: 'Tailwind Play CDN 3.x was replaced with the platform Tailwind 4.3.0 runtime.',
          },
        ],
      }),
    );
    await render({ preflightInteractiveHtml } as Partial<ReachDeckClient>);

    await selectFile(htmlFile());
    await clickButton('解析并预览');

    expect(preflightInteractiveHtml).toHaveBeenCalledWith(context, expect.any(File), PAGE_ID, {
      idempotencyKey: 'interactive-html-1',
    });
    expect(container.textContent).toContain('可以替换当前页');
    expect(container.textContent).toContain('内置运行时：tailwind-browser@4.3.0');
    expect(container.textContent).toContain('不保存状态、不计分');
    // 诊断码去掉内部命名空间前缀。
    expect(container.textContent).toContain('tailwind_version_replacement');
    expect(container.textContent).not.toContain('html.interactive.');

    const preview = container.querySelector('[data-active-page-id]');
    expect(preview?.getAttribute('data-active-page-id')).toBe(PAGE_ID);
    expect(preview?.getAttribute('data-interactive-mode')).toBe('authoring');
    expect(preview?.getAttribute('data-geometry-host-mode')).toBe('authoring-trial');
    expect(preview?.getAttribute('data-locale')).toBe('zh-CN');
    expect(preview?.getAttribute('data-page-navigation-locked')).toBe('true');
  });

  it('blocks confirmation when the candidate has a blocking diagnostic', async () => {
    const preflightInteractiveHtml = vi.fn().mockResolvedValue({
      ok: false,
      schemaVersion: 'reach-deck-interactive-html-preflight/v1',
      applicationId: `interactive-html-import-${'1'.repeat(32)}`,
      importerVersion: '0.1.0',
      pageId: PAGE_ID,
      canApply: false,
      diagnostics: [
        {
          code: 'html.interactive.unknown_dependency',
          severity: 'error',
          feature: 'interactive',
          message: 'Interactive HTML contains an unsupported external dependency.',
        },
      ],
    });
    const onConfirm = await render(
      { preflightInteractiveHtml } as Partial<ReachDeckClient>,
      vi.fn(),
    );

    await selectFile(htmlFile());
    await clickButton('解析并预览');

    expect(container.textContent).toContain('无法上传');
    expect(container.textContent).toContain('unknown_dependency');
    expect(container.querySelector('[data-active-page-id]')).toBeNull();

    await clickButton('确认并替换当前页');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms with the previewed candidate bound to the target page', async () => {
    const result = applicablePreflight();
    const preflightInteractiveHtml = vi.fn().mockResolvedValue(result);
    const onConfirm = await render(
      { preflightInteractiveHtml } as Partial<ReachDeckClient>,
      vi.fn(),
    );

    await selectFile(htmlFile());
    await clickButton('解析并预览');
    await clickButton('确认并替换当前页');

    expect(onConfirm).toHaveBeenCalledWith({
      file: expect.any(File),
      idempotencyKey: 'interactive-html-1',
      pageId: PAGE_ID,
      result,
    });
  });
});
