import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ReachDeckRegenerationDialog,
  type ReachDeckRegenerationSelection,
} from '../src/ReachDeckRegenerationDialog.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const empty: ReachDeckRegenerationSelection = {
  channels: { layout: false, narration: false, audio: false, animation: false },
  scope: 'failed',
  audioAnimationMode: 'preserve',
};

function mount({
  selection = empty,
  pageTitle,
  selectionLockedReason,
  imageCount,
  failedImageCount,
  onSubmit = vi.fn().mockResolvedValue(undefined),
}: {
  selection?: ReachDeckRegenerationSelection;
  pageTitle?: string;
  selectionLockedReason?: string;
  imageCount?: number;
  failedImageCount?: number;
  onSubmit?: (selection: ReachDeckRegenerationSelection) => Promise<void>;
} = {}) {
  const onOpenChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(selection);
    return (
      <ReachDeckRegenerationDialog
        open
        pageTitle={pageTitle}
        selectionLockedReason={selectionLockedReason}
        imageCount={imageCount}
        failedImageCount={failedImageCount}
        selection={value}
        onSelectionChange={setValue}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        options={(
          [
            'layout',
            ...(selection.channels.image === undefined ? [] : ['image' as const]),
            'narration',
            'audio',
            'animation',
          ] as const
        ).map((channel) => ({
          channel,
        }))}
      />
    );
  }
  act(() => root.render(<Harness />));
  return { onOpenChange };
}

describe('ReachDeckRegenerationDialog', () => {
  it('freezes uncertain request choices while allowing explicit confirmation', async () => {
    const selection = { ...empty, channels: { ...empty.channels, audio: true } };
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mount({ selection, onSubmit, selectionLockedReason: '确认上次提交结果后再开始新任务。' });
    expect(document.body.textContent).toContain('确认上次提交结果后再开始新任务。');
    for (const input of document.querySelectorAll<HTMLInputElement>('input')) {
      expect(input.matches(':disabled')).toBe(true);
    }
    const confirm = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '确认上次提交',
    )!;
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(onSubmit).toHaveBeenCalledWith(selection);
  });
  it('keeps submission disabled for an empty selection and sends the chosen channels', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { onOpenChange } = mount({ onSubmit });
    const submit = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '开始生成',
    )!;
    expect(submit.disabled).toBe(true);
    act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(onSubmit).toHaveBeenCalledWith({
      ...empty,
      channels: { ...empty.channels, layout: true },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps scope for a whole Deck and omits it for one page', () => {
    mount();
    expect(document.body.textContent).toContain('只重试失败页面');
    expect(document.body.textContent).toContain('覆盖所有页面');
    mount({ pageTitle: '用户输入的标题' });
    expect(document.body.textContent).toContain('重新生成：用户输入的标题');
    expect(document.body.textContent).not.toContain('覆盖所有页面');
  });

  it('shows animation handling only when audio is selected without animation', () => {
    mount({ selection: { ...empty, channels: { ...empty.channels, audio: true } } });
    expect(document.body.textContent).toContain('保留动画并匹配新时间戳');
    act(() => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3]!.click());
    expect(document.body.textContent).not.toContain('保留动画并匹配新时间戳');
  });

  it('blocks duplicate submission and closing until acceptance, then leaves recovery to the owner', async () => {
    let reject!: (cause: Error) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
    const { onOpenChange } = mount({
      selection: { ...empty, channels: { ...empty.channels, narration: true } },
      onSubmit,
    });
    const submit = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '开始生成',
    )!;
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => reject(new Error('private transport detail')));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '提交失败，请确认任务状态后重试。',
    );
    expect(document.body.textContent).not.toContain('private transport detail');
  });
});

it('hides page scope for image-only requests and confirms replacing more than twenty images', async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const selection = {
    ...empty,
    channels: { ...empty.channels, image: true },
    imageScope: 'all' as const,
  };
  mount({ selection, imageCount: 21, onSubmit });
  expect(document.body.textContent).not.toContain('覆盖所有页面');
  expect(document.body.textContent).toContain('将重新生成 21 张图片');
  const start = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '开始生成',
  )!;
  await act(async () => start.click());
  expect(onSubmit).not.toHaveBeenCalled();
  const confirmation = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
  ]
    .filter((button) => button.textContent === '开始生成')
    .at(-1)!;
  await act(async () => confirmation.click());
  expect(onSubmit).toHaveBeenCalledWith(selection);
});

it('disables the failed-only image scope for a page with no failed images', () => {
  mount({
    selection: { ...empty, channels: { ...empty.channels, image: true }, imageScope: 'all' },
    pageTitle: 'Page',
    imageCount: 2,
    failedImageCount: 0,
  });
  const failed = document.querySelector<HTMLInputElement>('input[type="radio"][value="failed"]');
  expect(failed?.disabled).toBe(true);
});
