// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReachDeckEditor } from '@reachany/reach-deck-editor';

import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Decksmith 结构化提问（WP7 第一、二阶段）：用 Teacher 的正式 i18n 目录渲染编辑器，两种语言下
 * 卡片、选项、候选与文字回复入口的可见文案和无障碍名称都来自目录；问题与选项按模型原文显示。
 */
describe('Decksmith clarification card', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperties(window.Range.prototype, {
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
      getClientRects: { configurable: true, value: () => [] },
    });
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'renders the question card from the Teacher catalog in %s and answers by candidate',
    async (locale) => {
      const messages = REACH_DECK_MESSAGES[locale];
      const questionId = `dq_${'d'.repeat(32)}`;
      const onAssistantPrompt = vi
        .fn()
        .mockResolvedValueOnce({
          message: '后端中文兼容文案：不应直接显示。',
          outcome: {
            schemaVersion: 'reach-deck-decksmith-outcome/v1',
            mutationStatus: 'none',
            rejectedFontFamilies: [],
            toolErrorCount: 0,
            clarification: {
              questionId,
              question: '要改哪一个？',
              options: ['标题'],
              candidates: [
                {
                  pageId: 'page-1',
                  pageRevision: 1,
                  elementId: 'title-1',
                  label: 'textFrame "标题"',
                },
              ],
              expect: 'select-element',
            },
          },
          historyRunId: 'run-clarify',
          originPageId: 'page-1',
        })
        .mockResolvedValueOnce({
          message: 'ok',
          historyRunId: 'run-answer',
          originPageId: 'page-1',
        });

      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            onAssistantPrompt={onAssistantPrompt}
            translate={(key) => messages[key] ?? key}
          />,
        ),
      );
      const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          button.textContent === messages['reachDeck.editor.assistant.suggestion.shorten'],
      );
      await act(async () => suggestion?.click());

      const card = container.querySelector<HTMLElement>(
        `[role="group"][aria-label="${messages['reachDeck.editor.assistant.clarification.label']}"]`,
      );
      expect(card?.textContent).toContain('要改哪一个？');
      expect(container.textContent).toContain(
        messages['reachDeck.editor.assistant.outcome.clarification'],
      );
      expect(container.textContent).not.toContain('后端中文兼容文案');
      expect(
        card?.querySelector(
          `[aria-label="${messages['reachDeck.editor.assistant.clarification.options']}"]`,
        ),
      ).not.toBeNull();
      expect(
        card?.querySelector(
          `[aria-label="${messages['reachDeck.editor.assistant.clarification.candidates']}"]`,
        ),
      ).not.toBeNull();
      expect(card?.textContent).toContain(
        messages['reachDeck.editor.assistant.clarification.replyWithText'],
      );
      expect(
        container.querySelector('.reach-deck-editor__assistant-reply-link')?.textContent,
      ).toContain(messages['reachDeck.editor.assistant.clarification.replyLinked']);

      const pickLabel = messages['reachDeck.editor.assistant.clarification.pickCandidate']!.replace(
        '{label}',
        'textFrame "标题"',
      );
      const candidate = [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.getAttribute('aria-label') === pickLabel,
      );
      expect(candidate).toBeDefined();
      await act(async () => candidate?.click());
      expect(onAssistantPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({
          prompt: messages['reachDeck.editor.assistant.clarification.pickAnswer']!.replace(
            '{label}',
            'textFrame "标题"',
          ),
          answersQuestionId: questionId,
          selectedElementIds: ['title-1'],
        }),
      );
      expect(container.textContent).toContain(
        messages['reachDeck.editor.assistant.clarification.closed'],
      );
    },
  );

  const fill = (template: string | undefined, values: Record<string, string | number>) =>
    Object.entries(values).reduce(
      (current, [key, value]) => current.replaceAll(`{${key}}`, String(value)),
      template ?? '',
    );

  it.each(['zh-CN', 'en-US'] as const)(
    'labels canvas picking and context chips from the Teacher catalog in %s',
    async (locale) => {
      const messages = REACH_DECK_MESSAGES[locale];
      const questionId = `dq_${'e'.repeat(32)}`;
      const label = 'textFrame "标题"';
      const onAssistantPrompt = vi
        .fn()
        .mockResolvedValueOnce({
          message: 'clarify',
          outcome: {
            schemaVersion: 'reach-deck-decksmith-outcome/v1',
            mutationStatus: 'none',
            rejectedFontFamilies: [],
            toolErrorCount: 0,
            clarification: {
              questionId,
              question: '要改哪一个？',
              options: [],
              candidates: [{ pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label }],
              expect: 'select-element',
            },
          },
          historyRunId: 'run-clarify',
          originPageId: 'page-1',
        })
        .mockResolvedValueOnce({
          message: 'ok',
          historyRunId: 'run-answer',
          originPageId: 'page-1',
        });

      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            onAssistantPrompt={onAssistantPrompt}
            translate={(key) => messages[key] ?? key}
          />,
        ),
      );
      const canvasTitle = () =>
        container.querySelector<HTMLElement>(
          '[data-native-v2-editable] [data-native-v2-element-id="title-1"]',
        );

      // 上下文 chip：类型名 + 文本前缀，id 只出现在 title 中。
      act(() => canvasTitle()?.click());
      const chipLabel = fill(messages['reachDeck.editor.assistant.elementChip'], {
        type: messages['reachDeck.editor.assistant.elementType.textFrame']!,
        detail: 'First page',
      });
      const chip = container.querySelector<HTMLButtonElement>(
        '.reach-deck-editor__assistant-element-chip',
      );
      expect(chip?.getAttribute('aria-label')).toBe(
        fill(messages['reachDeck.editor.assistant.removeComponentFocus'], { label: chipLabel }),
      );
      expect(chip?.textContent).toBe(chipLabel);
      expect(chip?.title).toBe(
        fill(messages['reachDeck.editor.assistant.elementChipTitle'], {
          label: chipLabel,
          id: 'title-1',
        }),
      );
      act(() => chip?.click());

      const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          button.textContent === messages['reachDeck.editor.assistant.suggestion.shorten'],
      );
      await act(async () => suggestion?.click());

      // 画布点选：提示条、编号徽标与"用这个"的可见文案和无障碍名称都来自目录。
      const bar = container.querySelector<HTMLElement>(
        `[role="group"][aria-label="${messages['reachDeck.editor.assistant.clarification.pickBar']}"]`,
      );
      expect(bar?.textContent).toContain(
        messages['reachDeck.editor.assistant.clarification.pickHint'],
      );
      const candidateName = fill(
        messages['reachDeck.editor.assistant.clarification.canvasCandidate'],
        { index: 1, label },
      );
      const badge = container.querySelector<HTMLButtonElement>(
        '.reach-deck-editor__clarification-badge',
      );
      expect(badge?.getAttribute('aria-label')).toBe(candidateName);

      act(() => canvasTitle()?.click());
      expect(bar?.textContent).toContain(
        fill(messages['reachDeck.editor.assistant.clarification.pickSelected'], {
          name: candidateName,
        }),
      );
      const useThis = [...(bar?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) =>
          button.textContent?.trim() ===
          messages['reachDeck.editor.assistant.clarification.useThis'],
      );
      expect(useThis).toBeDefined();
      expect(
        [...(bar?.querySelectorAll<HTMLButtonElement>('button') ?? [])].some(
          (button) =>
            button.textContent?.trim() ===
            messages['reachDeck.editor.assistant.clarification.exitPick'],
        ),
      ).toBe(true);
      await act(async () => useThis?.click());
      expect(onAssistantPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({
          prompt: fill(messages['reachDeck.editor.assistant.clarification.pickAnswer'], { label }),
          answersQuestionId: questionId,
          selectedElementIds: ['title-1'],
        }),
      );
    },
  );
});
