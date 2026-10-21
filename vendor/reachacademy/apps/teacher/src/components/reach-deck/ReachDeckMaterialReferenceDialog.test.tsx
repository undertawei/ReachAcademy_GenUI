// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenerationWorkspace, type GenerationWorkspace } from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { ReachDeckMaterialReferenceDialog } from './ReachDeckMaterialReferenceDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const assetId = '00000000-0000-4000-8000-000000000001';

function fixture(): GenerationWorkspace {
  return {
    ...createGenerationWorkspace({
      runId: 'references',
      documentId: 'deck',
      source: 'Brief',
      createdAt: '2026-09-30T00:00:00Z',
    }),
    materialSources: {
      schemaVersion: 'reach-deck-material-sources/v1',
      documents: [
        {
          fileName: 'lesson.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          diagnostics: ['image_mime_corrected', 'warning'],
          blocks: [
            { type: 'text', text: 'Before image <script>alert(1)</script>' },
            { type: 'image', assetId, mimeType: 'image/webp' },
            { type: 'text', text: 'After image' },
          ],
        },
        {
          fileName: 'lesson.pptx',
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          pageCount: 3,
          diagnostics: [],
          blocks: [{ type: 'text', text: 'Second file', page: 1 }],
        },
      ],
      webSearch: {
        query: 'Countryside',
        answer: 'Research summary',
        sources: [
          {
            title: 'Research article',
            url: 'https://example.test/research',
            content: 'Research evidence',
          },
          { title: 'Unsafe legacy URL', url: 'javascript:alert(1)', content: 'Escaped evidence' },
        ],
        excludedSources: [
          {
            title: 'PDF index',
            url: 'https://example.test/index.pdf',
            reason: 'pdf_binary_content',
          },
        ],
      },
    },
  };
}

describe('Reach Deck reference materials', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function render(
    workspace: GenerationWorkspace,
    preview = vi.fn().mockResolvedValue({
      assetId,
      contentType: 'image/webp',
      downloadUrl: 'https://example.test/image.webp',
    }),
    locale: 'zh-CN' | 'en-US' = 'en-US',
  ) {
    await act(async () =>
      root.render(
        <PortalI18nProvider locale={locale}>
          <ReachDeckMaterialReferenceDialog
            workspace={workspace}
            onPreviewMaterialAsset={preview}
          />
        </PortalI18nProvider>,
      ),
    );
    return preview;
  }
  async function open() {
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it.each(['zh-CN', 'en-US'] as const)(
    'shows readonly file and research tabs in %s with localized image states',
    async (locale) => {
      const preview = await render(fixture(), undefined, locale);
      const dialog = await open();
      expect(preview).toHaveBeenCalledWith(assetId);
      expect(dialog.querySelectorAll('[role="tab"]')).toHaveLength(3);
      expect(dialog.textContent).toContain('Before image <script>alert(1)</script>');
      expect(dialog.querySelector('script')).toBeNull();
      expect(dialog.querySelector('textarea,input,[contenteditable="true"]')).toBeNull();
      expect(dialog.textContent).not.toContain('image_mime_corrected');
      expect(dialog.textContent).toContain(locale === 'zh-CN' ? '正在加载图片' : 'Loading image');
      const image = dialog.querySelector('img')!;
      expect(image.alt).toContain('lesson.docx');
      expect(image.alt).toBe(
        locale === 'zh-CN'
          ? '从 lesson.docx 提取的第 1 张图片'
          : 'Extracted image 1 from lesson.docx',
      );
      await act(async () => fireEvent.load(image));
      expect(dialog.textContent).not.toContain(
        locale === 'zh-CN' ? '正在加载图片' : 'Loading image',
      );
      const tabs = dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      await act(async () => tabs[0]!.focus());
      await act(async () => fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' }));
      expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tabs[1]);
      expect(dialog.textContent).toContain('Second file');
      await act(async () => fireEvent.keyDown(tabs[1]!, { key: 'End' }));
      expect(dialog.textContent).toContain('Research evidence');
      expect(dialog.textContent).toContain(
        locale === 'zh-CN' ? '已排除的检索结果' : 'Excluded search results',
      );
      expect(dialog.querySelector<HTMLAnchorElement>('a')?.href).toBe(
        'https://example.test/research',
      );
      expect(
        [...dialog.querySelectorAll('a')].some((link) => link.href.startsWith('javascript:')),
      ).toBe(false);
    },
  );

  it('loads images only on opening, renews failed images on retry, and retains images across rerenders', async () => {
    const workspace = fixture();
    const preview = vi.fn().mockRejectedValueOnce(new Error('expired')).mockResolvedValue({
      assetId,
      contentType: 'image/webp',
      downloadUrl: 'https://example.test/new.webp',
    });
    await render(workspace, preview);
    expect(preview).not.toHaveBeenCalled();
    let dialog = await open();
    expect(dialog.textContent).toContain('The extracted image could not be loaded.');
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Retry loading image"]')?.click(),
    );
    expect(preview).toHaveBeenCalledTimes(2);
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('https://example.test/new.webp');
    await act(async () => fireEvent.load(dialog.querySelector('img')!));
    await render({ ...workspace, updatedAt: '2026-09-30T00:00:01Z' }, preview);
    dialog = document.querySelector('[role="dialog"]')!;
    expect(preview).toHaveBeenCalledTimes(2);
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('https://example.test/new.webp');
    await act(async () => fireEvent.error(dialog.querySelector('img')!));
    expect(dialog.textContent).toContain('The extracted image could not be loaded.');
  });

  it('hides the icon without uploads or research and opens a research-only tab for a refreshed workspace', async () => {
    const workspace = fixture();
    await render({ ...workspace, materialSources: undefined });
    expect(host.querySelector('button')).toBeNull();
    await render({
      ...workspace,
      materialSources: {
        schemaVersion: 'reach-deck-material-sources/v1',
        documents: [],
        webSearch: workspace.materialSources!.webSearch,
      },
    });
    const dialog = await open();
    expect(dialog.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(dialog.textContent).toContain('Research evidence');
  });

  it('returns focus to the document icon when the readonly dialog closes', async () => {
    await render(fixture());
    const trigger = host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => trigger.focus());
    const dialog = await open();
    await act(async () =>
      dialog
        .querySelector<HTMLButtonElement>('button[aria-label="Close reference materials"]')
        ?.click(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(document.activeElement).toBe(trigger);
  });
});
