// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuizQuestion, type QuizScene } from '@reachany/reach-deck-dsl';
import { ReachDeckAttachmentList } from '../src/ReachDeckAttachmentList.js';
import { QuizScenePlayer } from '../src/QuizScenePlayer.js';
import { QuizAnswerEditor } from '../src/QuizAnswerEditor.js';
import { richTextFromPlainText } from '@reachany/reach-deck-dsl';

const attachment = {
  assetId: 'attachment-id',
  objectKey: 'uploads/file.pdf',
  name: 'file.pdf',
  contentType: 'application/pdf',
  sizeBytes: 30,
  order: 1,
};

describe('Reach Deck attachments', () => {
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

  it('resolves inline only on preview and attachment disposition only on download', async () => {
    const resolveAttachmentUrl = vi.fn(async (_ref, disposition: 'inline' | 'attachment') => ({
      url: 'https://example.test/file.pdf',
      disposition,
      contentType: 'application/pdf',
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[attachment]}
          resolveAttachmentUrl={resolveAttachmentUrl}
        />,
      ),
    );
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="预览 file.pdf"]')!.click(),
    );
    expect(resolveAttachmentUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ assetId: attachment.assetId, objectKey: attachment.objectKey }),
      'inline',
    );
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://example.test/file.pdf',
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="下载 file.pdf"]')!.click(),
    );
    expect(resolveAttachmentUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ objectKey: attachment.objectKey }),
      'attachment',
    );
    expect(click).toHaveBeenCalledOnce();
  });

  it('does not expose fallback downloads or claim PDF inline authorization without a resolver', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[attachment]}
          mediaUrlsByObjectKey={{ [attachment.objectKey]: 'https://example.test/legacy.pdf' }}
        />,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="预览 file.pdf"]')!.click(),
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.body.textContent).toContain('暂不支持在线预览');
    expect(document.querySelector('[aria-label="在新标签页打开"]')).toBeNull();
    expect(host.querySelector('[aria-label="下载 file.pdf"]')).toBeNull();
    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent === '下载'),
    ).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    act(() => root.render(<ReachDeckAttachmentList attachments={[attachment]} />));
    expect(host.textContent).toContain('file.pdf');
    expect(host.querySelector('button')).toBeNull();
  });

  it('keeps unavailable references inert with a resolver and skips them in preview navigation', async () => {
    const unavailable = {
      ...attachment,
      assetId: 'blocked',
      objectKey: 'blocked.pdf',
      name: 'blocked.pdf',
    };
    const available = {
      ...attachment,
      assetId: 'available',
      objectKey: 'available.pdf',
      name: 'available.pdf',
    };
    const resolveAttachmentUrl = vi.fn(async (_ref, disposition: 'inline' | 'attachment') => ({
      url: 'https://example.test/file.pdf',
      disposition,
      contentType: 'application/pdf',
    }));
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[attachment, unavailable, available]}
          resolveAttachmentUrl={resolveAttachmentUrl}
          isAttachmentUnavailable={(ref) => ref.objectKey === unavailable.objectKey}
          translate={(key) => (key === 'attachment.unavailable' ? 'Attachment unavailable' : key)}
        />,
      ),
    );
    const blockedRow = [...host.querySelectorAll('li')].find((row) =>
      row.textContent?.includes('blocked.pdf'),
    )!;
    expect(blockedRow.textContent).toContain('Attachment unavailable');
    expect(blockedRow.querySelector('button')).toBeNull();
    await act(async () => blockedRow.querySelector<HTMLElement>('[title="blocked.pdf"]')!.click());
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="预览 file.pdf"]')!.click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="下一个"]')!.click(),
    );
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);
    expect(resolveAttachmentUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ objectKey: available.objectKey }),
      'inline',
    );
  });

  it('keeps Office fallback filenames inert and rejects executable URL protocols', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const office = {
      ...attachment,
      name: 'notes.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    await act(async () =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[office]}
          mediaUrlsByObjectKey={{ [office.objectKey]: 'https://example.test/notes.docx' }}
        />,
      ),
    );
    expect(
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'notes.docx'),
    ).toBeUndefined();
    expect(host.querySelector('[aria-label="下载 notes.docx"]')).toBeNull();
    expect(click).not.toHaveBeenCalled();
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[office]}
          mediaUrlsByObjectKey={{ [office.objectKey]: 'javascript:alert(1)' }}
        />,
      ),
    );
    expect(host.querySelector('button')).toBeNull();
    expect(click).not.toHaveBeenCalled();
  });

  it('previews media from resource attachment URLs and renders one ordered list', async () => {
    const image = {
      ...attachment,
      name: 'image.png',
      objectKey: 'image.png',
      assetId: 'image',
      contentType: 'image/png',
    };
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[attachment, image]}
          mediaUrlsByObjectKey={{ 'image.png': 'https://example.test/image.png' }}
        />,
      ),
    );
    expect(host.querySelectorAll('ol')).toHaveLength(1);
    expect(
      [...host.querySelectorAll('.rx-file-list-index')].map((node) => node.textContent),
    ).toEqual(['1.', '2.']);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="预览 image.png"]')!.click(),
    );
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/image.png',
    );
    expect(document.querySelector('[aria-label="在新标签页打开"]')).toBeNull();
    const download = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '下载',
    );
    expect(download).toBeUndefined();
    expect(host.querySelector('[aria-label="下载 image.png"]')).toBeNull();
  });

  it('marks every concurrent download row as busy', async () => {
    const finish: (() => void)[] = [];
    const resolveAttachmentUrl = vi.fn(
      (_ref, disposition: 'inline' | 'attachment') =>
        new Promise<{ url: string; disposition: 'inline' | 'attachment' }>((resolve) => {
          finish.push(() => resolve({ url: 'https://example.test/file.pdf', disposition }));
        }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const second = {
      ...attachment,
      assetId: 'second',
      objectKey: 'second.pdf',
      name: 'second.pdf',
    };
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[attachment, second]}
          resolveAttachmentUrl={resolveAttachmentUrl}
        />,
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="下载 file.pdf"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="下载 second.pdf"]')!.click());
    expect(host.querySelectorAll('li[aria-busy="true"]')).toHaveLength(2);
    await act(async () => finish.forEach((resolve) => resolve()));
    expect(host.querySelectorAll('li[aria-busy="true"]')).toHaveLength(0);
  });

  it('shows preview failures only in the dialog and ignores failures from a previous attachment', async () => {
    let rejectFirst!: (error: Error) => void;
    const second = {
      ...attachment,
      assetId: 'second',
      objectKey: 'second.png',
      name: 'second.png',
      contentType: 'image/png',
    };
    const resolveAttachmentUrl = vi.fn((ref: { objectKey: string }) =>
      ref.objectKey === attachment.objectKey
        ? new Promise<{ url: string; disposition: 'inline' }>((_resolve, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve({
            url: 'https://example.test/second.png',
            disposition: 'inline' as const,
            contentType: 'image/png',
          }),
    );
    act(() =>
      root.render(
        <ReachDeckAttachmentList
          attachments={[attachment, second]}
          resolveAttachmentUrl={resolveAttachmentUrl}
        />,
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="预览 file.pdf"]')!.click());
    await act(async () =>
      [...document.querySelectorAll('button')]
        .find((button) => button.getAttribute('aria-label') === '下一个')!
        .click(),
    );
    await act(async () => rejectFirst(new Error('Expired previous attachment')));
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/second.png',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain('加载失败');
  });

  it('renders question attachments without exposing analysis attachments', () => {
    const scene: QuizScene = {
      schemaVersion: 'reach-quiz-scene/v1',
      id: 'quiz',
      sceneType: 'quiz',
      title: 'Quiz',
      content: {
        display_mode: 'single_question',
        navigation: 'horizontal',
        show_progress: true,
        show_question_index: true,
        answer_reveal: 'after_submit',
        allow_previous: true,
        allow_skip: false,
        questions: [
          {
            ...createQuizQuestion('single_choice', 1, 'q'),
            question_attachments: [attachment],
            analysis_attachments: [
              { ...attachment, objectKey: 'analysis.pdf', name: 'analysis.pdf' },
            ],
          },
        ],
      },
    };
    act(() => root.render(<QuizScenePlayer scene={scene} />));
    expect(host.textContent).toContain('file.pdf');
    expect(host.textContent).not.toContain('analysis.pdf');
  });

  it('keeps submitted answer attachments usable without an uploader', async () => {
    const resolveAttachmentUrl = vi.fn(async () => ({
      url: 'https://example.test/file.pdf',
      disposition: 'inline' as const,
    }));
    act(() =>
      root.render(
        <QuizAnswerEditor
          allowAttachments
          disabled
          questionId="q"
          onChange={vi.fn()}
          resolveAttachmentUrl={resolveAttachmentUrl}
          value={{
            kind: 'rich_text',
            document: richTextFromPlainText('Answer'),
            attachments: [attachment],
          }}
        />,
      ),
    );
    const preview = host.querySelector<HTMLButtonElement>('[aria-label="预览 file.pdf"]')!;
    expect(preview.disabled).toBe(false);
    await act(async () => preview.click());
    expect(resolveAttachmentUrl).toHaveBeenCalled();
    expect(host.querySelector('[aria-label="移除 file.pdf"]')).toBeNull();
    expect(host.querySelector('.quiz-answer-editor__attach-action')).toBeNull();
  });
});
