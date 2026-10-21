// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizAttachmentReference } from '@reachany/reach-deck-dsl';
import { QuizQuestionAttachmentsEditor } from '../src/QuizQuestionAttachmentsEditor.js';

const attachment: QuizAttachmentReference = {
  assetId: 'asset-1',
  objectKey: 'uploads/file.pdf',
  name: 'file.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2,
  order: 0,
};

describe('QuizQuestionAttachmentsEditor', () => {
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
  });
  const choose = (files: File[]) => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('uploads with a cancellation signal and saves stable metadata with normalized order', async () => {
    const onChange = vi.fn();
    const upload = vi.fn(async () => attachment);
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor attachments={[]} upload={upload} onChange={onChange} />,
      ),
    );
    await act(async () => choose([new File(['ok'], 'file.pdf', { type: 'application/pdf' })]));
    expect(upload).toHaveBeenCalledWith(expect.any(File), expect.any(AbortSignal));
    expect(onChange.mock.calls[0]![0]([])).toEqual([attachment]);
  });

  it('rejects counts over 10 and files over 100 MiB before upload', async () => {
    const onChange = vi.fn();
    const upload = vi.fn();
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor attachments={[]} upload={upload} onChange={onChange} />,
      ),
    );
    await act(async () => choose(Array.from({ length: 11 }, () => new File(['x'], 'f.pdf'))));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('10');
    const file = new File(['x'], 'large.pdf');
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 });
    await act(async () => choose([file]));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('100 MiB');
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(['reject', 'missing'] as const)(
    'continues files three through five after the second upload fails (%s)',
    async (failure) => {
      let saved: QuizAttachmentReference[] = [];
      const upload = vi.fn(async (file: File) => {
        if (file.name === 'second.pdf') {
          if (failure === 'reject') throw new Error('Storage unavailable');
          return undefined;
        }
        return {
          ...attachment,
          assetId: file.name,
          name: file.name,
          objectKey: `uploads/${file.name}`,
        };
      });
      function Harness() {
        const [items, setItems] = useState<QuizAttachmentReference[]>([]);
        return (
          <QuizQuestionAttachmentsEditor
            attachments={items}
            upload={upload}
            onChange={(update) =>
              setItems((current) => {
                saved = update(current);
                return saved;
              })
            }
          />
        );
      }
      act(() => root.render(<Harness />));
      await act(async () =>
        choose(
          ['first.pdf', 'second.pdf', 'third.pdf', 'fourth.pdf', 'fifth.pdf'].map(
            (name) => new File(['ok'], name),
          ),
        ),
      );
      expect(saved.map((item) => [item.name, item.order])).toEqual([
        ['first.pdf', 0],
        ['third.pdf', 1],
        ['fourth.pdf', 2],
        ['fifth.pdf', 3],
      ]);
      expect(upload.mock.calls.map(([file]) => file.name)).toEqual([
        'first.pdf',
        'second.pdf',
        'third.pdf',
        'fourth.pdf',
        'fifth.pdf',
      ]);
      expect(host.querySelectorAll('.rx-file-list-row')).toHaveLength(4);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('second.pdf');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('上传失败');
      expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    },
  );

  it('summarizes every rejected or missing upload result after trying all files', async () => {
    let saved: QuizAttachmentReference[] = [];
    let finishFifth!: (value: QuizAttachmentReference) => void;
    const upload = vi.fn(async (file: File) => {
      if (file.name === 'second.pdf') throw new Error('Storage unavailable');
      if (file.name === 'fourth.pdf') return undefined;
      if (file.name === 'fifth.pdf')
        return new Promise<QuizAttachmentReference>((resolve) => {
          finishFifth = resolve;
        });
      return {
        ...attachment,
        assetId: file.name,
        name: file.name,
        objectKey: `uploads/${file.name}`,
      };
    });
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor
          attachments={[]}
          upload={upload}
          onChange={(update) => {
            saved = update(saved);
          }}
        />,
      ),
    );
    await act(async () =>
      choose(
        ['first.pdf', 'second.pdf', 'third.pdf', 'fourth.pdf', 'fifth.pdf'].map(
          (name) => new File(['ok'], name),
        ),
      ),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () =>
      finishFifth({
        ...attachment,
        assetId: 'fifth.pdf',
        name: 'fifth.pdf',
        objectKey: 'uploads/fifth.pdf',
      }),
    );
    expect(saved.map((item) => item.name)).toEqual(['first.pdf', 'third.pdf', 'fifth.pdf']);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('second.pdf、fourth.pdf');
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('first.pdf');
  });

  it.each([
    { locale: 'zh-CN', separator: '、', message: '以下附件上传失败：{names}。请重试。' },
    { locale: 'en-US', separator: ', ', message: 'Failed to upload: {names}. Try again.' },
  ])(
    'uses the translated failed filename separator for $locale',
    async ({ separator, message }) => {
      const upload = vi.fn(async () => undefined);
      const translate = vi.fn((key: string, params?: Record<string, string | number>) => {
        if (key === 'reachDeck.editor.quiz.failedAttachmentNameSeparator') return separator;
        if (key === 'reachDeck.editor.quiz.uploadAttachmentFilesFailed')
          return message.replace('{names}', String(params?.names));
        return key;
      });
      act(() =>
        root.render(
          <QuizQuestionAttachmentsEditor
            attachments={[]}
            upload={upload}
            onChange={() => undefined}
            translate={translate}
          />,
        ),
      );
      await act(async () => choose([new File(['x'], 'one.pdf'), new File(['x'], 'two.pdf')]));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        message.replace('{names}', `one.pdf${separator}two.pdf`),
      );
      expect(translate).toHaveBeenCalledWith(
        'reachDeck.editor.quiz.failedAttachmentNameSeparator',
        {},
      );
    },
  );

  it('keeps completed files when the user cancels the next file and ignores its late result', async () => {
    let saved: QuizAttachmentReference[] = [];
    let thirdSignal: AbortSignal | undefined;
    let finishThird!: (value: QuizAttachmentReference) => void;
    const onChange = vi.fn(
      (update: (current: readonly QuizAttachmentReference[]) => QuizAttachmentReference[]) => {
        saved = update(saved);
      },
    );
    const upload = vi.fn(async (file: File, signal: AbortSignal) => {
      if (file.name === 'third.pdf') {
        thirdSignal = signal;
        return new Promise<QuizAttachmentReference>((resolve) => {
          finishThird = resolve;
        });
      }
      return {
        ...attachment,
        assetId: file.name,
        name: file.name,
        objectKey: `uploads/${file.name}`,
      };
    });
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor attachments={[]} upload={upload} onChange={onChange} />,
      ),
    );
    await act(async () =>
      choose(
        ['first.pdf', 'second.pdf', 'third.pdf', 'fourth.pdf'].map(
          (name) => new File(['ok'], name),
        ),
      ),
    );
    expect(saved.map((item) => item.name)).toEqual(['first.pdf', 'second.pdf']);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="取消附件上传"]')!.click());
    expect(thirdSignal?.aborted).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('third.pdf');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已完成的附件已保留');
    await act(async () => finishThird({ ...attachment, name: 'third.pdf' }));
    expect(saved.map((item) => item.name)).toEqual(['first.pdf', 'second.pdf']);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('preserves earlier failures when cancellation rejects the active upload and skips later files', async () => {
    let saved: QuizAttachmentReference[] = [];
    const upload = vi.fn(async (file: File, signal: AbortSignal) => {
      if (file.name === 'second.pdf') return undefined;
      if (file.name === 'fourth.pdf')
        return new Promise<QuizAttachmentReference>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      return {
        ...attachment,
        assetId: file.name,
        name: file.name,
        objectKey: `uploads/${file.name}`,
      };
    });
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor
          attachments={[]}
          upload={upload}
          onChange={(update) => {
            saved = update(saved);
          }}
        />,
      ),
    );
    await act(async () =>
      choose(
        ['first.pdf', 'second.pdf', 'third.pdf', 'fourth.pdf', 'fifth.pdf'].map(
          (name) => new File(['ok'], name),
        ),
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="取消附件上传"]')!.click(),
    );
    expect(saved.map((item) => item.name)).toEqual(['first.pdf', 'third.pdf']);
    expect(upload).toHaveBeenCalledTimes(4);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      '以下附件上传失败：second.pdf',
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已取消上传 fourth.pdf');
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });

  it('disables attachment selection during another media upload', () => {
    const upload = vi.fn();
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor
          attachments={[]}
          uploadDisabled
          upload={upload}
          onChange={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    act(() => choose([new File(['ok'], 'file.pdf')]));
    expect(upload).not.toHaveBeenCalled();
  });

  it('aborts uploads on unmount and never saves their late results', async () => {
    const onChange = vi.fn();
    let signal: AbortSignal | undefined;
    let finish: (value: QuizAttachmentReference) => void = () => {};
    const upload = vi.fn((_file: File, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<QuizAttachmentReference>((resolve) => {
        finish = resolve;
      });
    });
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor attachments={[]} upload={upload} onChange={onChange} />,
      ),
    );
    act(() => choose([new File(['ok'], 'file.pdf')]));
    act(() => root.render(<div />));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(attachment));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reorders and removes attachments while retaining stable identity', () => {
    const second = {
      ...attachment,
      assetId: 'asset-2',
      objectKey: 'uploads/second.pdf',
      name: 'second.pdf',
      order: 2,
    };
    const onChange = vi.fn();
    act(() =>
      root.render(
        <QuizQuestionAttachmentsEditor attachments={[attachment, second]} onChange={onChange} />,
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="上移 second.pdf"]')!.click());
    expect(onChange.mock.calls.at(-1)![0]([attachment, second])).toEqual([
      { ...second, order: 0 },
      { ...attachment, order: 1 },
    ]);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="移除 file.pdf"]')!.click());
    expect(onChange.mock.calls.at(-1)![0]([attachment, second])).toEqual([{ ...second, order: 0 }]);
  });
});
