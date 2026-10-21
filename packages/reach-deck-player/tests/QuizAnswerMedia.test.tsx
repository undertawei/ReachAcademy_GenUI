import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuizQuestion, emptyQuizRichText, type QuizScene } from '@reachany/reach-deck-dsl';
import { QuizScenePlayer } from '../src/QuizScenePlayer';
import { QuizAnswerEditor, type QuizAnswerUploadedAsset } from '../src/QuizAnswerEditor';

const asset: QuizAnswerUploadedAsset = {
  assetId: 'asset-1',
  objectKey: 'answer/photo.png',
  contentType: 'image/png',
  downloadUrl: 'https://example.test/photo.png',
  name: 'photo.png',
  sizeBytes: 5,
};
const scene: QuizScene = {
  schemaVersion: 'reach-quiz-scene/v1',
  id: 'photos',
  title: 'Photos',
  sceneType: 'quiz',
  content: {
    display_mode: 'single_question',
    navigation: 'horizontal',
    show_progress: false,
    show_question_index: true,
    answer_reveal: 'after_submit',
    allow_previous: true,
    allow_skip: false,
    questions: [createQuizQuestion('short_answer', 1, 'photo-question')],
  },
};
let host: HTMLDivElement;
let root: Root;
async function upload(paste = false) {
  const file = new File(['photo'], 'photo.png', { type: 'image/png' });
  await act(async () => {
    if (paste) {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
          getData: () => '',
        },
      });
      host.querySelector('.ProseMirror')!.dispatchEvent(event);
    } else {
      const input = host.querySelector('input[accept="image/*"][multiple]')!;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperties(window.Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
describe('Deck learner image adapter', () => {
  it.each([false, true])(
    'preserves selected image order and successful images before a later failure (failure=%s)',
    async (failLast) => {
      const names = ['first.png', 'second.png', 'third.png'];
      const uploadAsset = vi.fn(async (file: File) => {
        if (failLast && file.name === 'third.png') throw new Error('Upload interrupted');
        return {
          ...asset,
          assetId: file.name,
          name: file.name,
          objectKey: `answer/${file.name}`,
          downloadUrl: `https://example.test/${file.name}`,
        };
      });
      const onChange = vi.fn();
      await act(async () =>
        root.render(
          <QuizAnswerEditor
            questionId="ordered-images"
            allowAttachments
            disabled={false}
            uploadAsset={uploadAsset}
            onChange={onChange}
            value={{ kind: 'rich_text', document: emptyQuizRichText(), attachments: [] }}
          />,
        ),
      );
      const input = host.querySelector('input[accept="image/*"][multiple]')!;
      Object.defineProperty(input, 'files', {
        value: names.map((name) => new File(['photo'], name, { type: 'image/png' })),
        configurable: true,
      });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      expect(
        [...host.querySelectorAll('.ProseMirror img')].map((image) => image.getAttribute('alt')),
      ).toEqual(failLast ? names.slice(0, 2) : names);
      expect(uploadAsset.mock.calls.map(([file]) => file.name)).toEqual(names);
      if (failLast)
        expect(host.querySelector('[role="alert"]')?.textContent).toBe('Upload interrupted');
    },
  );
  it.each(['更多格式', 'More formatting'])(
    'keeps camera and quick tools visible with advanced formatting collapsed (%s)',
    async (label) => {
      await act(async () =>
        root.render(
          <QuizAnswerEditor
            questionId="compact"
            allowAttachments
            disabled={false}
            uploadAsset={vi.fn().mockResolvedValue(asset)}
            onChange={() => {}}
            translate={(key) =>
              key === 'reachDeck.player.quiz.answer.moreFormatting' ? label : `test:${key}`
            }
            value={{ kind: 'rich_text', document: emptyQuizRichText(), attachments: [] }}
          />,
        ),
      );
      const toolbar = host.querySelector('.quiz-answer-editor__toolbar')!;
      const details = toolbar.querySelector<HTMLDetailsElement>('details')!;
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe(label);
      const bold = toolbar.querySelector<HTMLButtonElement>(
        'button[aria-label="test:reachDeck.editor.richText.mark.bold"]',
      )!;
      expect(bold.querySelector('svg')).not.toBeNull();
      expect(bold.textContent).toBe('');
      expect(bold.getAttribute('aria-pressed')).toBe('false');
      await act(async () => bold.click());
      expect(bold.getAttribute('aria-pressed')).toBe('true');
      expect(
        toolbar.querySelector(
          ':scope > button[aria-label="test:reachDeck.editor.richText.mark.bold"]',
        ),
      ).not.toBeNull();
      expect(
        toolbar.querySelector(
          ':scope > button[aria-label="test:reachDeck.editor.richText.mark.italic"]',
        ),
      ).not.toBeNull();
      expect(
        toolbar.querySelector(
          ':scope > button[aria-label="test:reachDeck.editor.richText.insertInlineMath"]',
        ),
      ).not.toBeNull();
      expect(
        details.querySelector('select[aria-label="test:reachDeck.editor.richText.font"]'),
      ).not.toBeNull();
      expect(
        details.querySelector<HTMLSelectElement>(
          'select[aria-label="test:reachDeck.editor.richText.font"]',
        )?.value,
      ).toBe('');
      expect(details.querySelector('button[aria-label="test:learnerEditor.takePhoto"]')).toBeNull();
      for (const key of ['takePhoto', 'uploadImage']) {
        const mediaButton = [...toolbar.querySelectorAll('button')].find(
          (button) => button.textContent === `test:learnerEditor.${key}`,
        );
        expect(mediaButton).toBeDefined();
        expect(mediaButton?.closest('details')).toBeNull();
      }
      expect(toolbar.querySelectorAll('[role="toolbar"]')).toHaveLength(0);
      await act(async () => details.querySelector('summary')?.click());
      expect(details.open).toBe(true);
      expect(
        details.querySelector(
          'button[aria-label="test:reachDeck.editor.richText.clearFormatting"]',
        ),
      ).not.toBeNull();
      await upload();
      expect(host.querySelector('.ProseMirror img')?.getAttribute('src')).toBe(asset.downloadUrl);
    },
  );
  it.each(['manual', 'paste'])(
    'submits a photo-only %s answer after upload finishes',
    async (route) => {
      let resolve!: (asset: QuizAnswerUploadedAsset) => void;
      const uploadAnswerAsset = vi.fn(
        () =>
          new Promise<QuizAnswerUploadedAsset>((done) => {
            resolve = done;
          }),
      );
      const onSubmit = vi.fn();
      await act(async () =>
        root.render(
          <QuizScenePlayer
            scene={scene}
            onSubmit={onSubmit}
            uploadAnswerAsset={uploadAnswerAsset}
          />,
        ),
      );
      expect(host.textContent).toContain('Take photo');
      await upload(route === 'paste');
      const submit = host.querySelector<HTMLButtonElement>('.quiz-scene__submit')!;
      expect(submit.disabled).toBe(true);
      await act(async () => submit.click());
      expect(onSubmit).not.toHaveBeenCalled();
      await act(async () => resolve(asset));
      expect(host.querySelector('.ProseMirror img')?.getAttribute('src')).toBe(asset.downloadUrl);
      expect(submit.disabled).toBe(false);
      await act(async () => submit.click());
      expect(uploadAnswerAsset).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(onSubmit.mock.calls[0][1])).toContain(asset.objectKey);
    },
  );

  it('does not release a new answer upload when an unmounted old upload completes', async () => {
    const pending: Array<(asset: QuizAnswerUploadedAsset) => void> = [];
    const uploadAsset = vi.fn(
      () => new Promise<QuizAnswerUploadedAsset>((resolve) => pending.push(resolve)),
    );
    let busyCount = 0;
    const onBusyChange = (busy: boolean) => {
      busyCount += busy ? 1 : -1;
    };
    const render = async (questionId: string) =>
      act(async () =>
        root.render(
          <QuizAnswerEditor
            key={questionId}
            questionId={questionId}
            allowAttachments
            disabled={false}
            onBusyChange={onBusyChange}
            uploadAsset={uploadAsset}
            onChange={() => {}}
            value={{ kind: 'rich_text', document: emptyQuizRichText(), attachments: [] }}
          />,
        ),
      );
    await render('first');
    await upload();
    expect(busyCount).toBe(1);
    await render('next');
    await upload();
    expect(busyCount).toBe(1);
    await act(async () => pending[0](asset));
    expect(busyCount).toBe(1);
    await act(async () => pending[1](asset));
    expect(busyCount).toBe(0);
  });
});
