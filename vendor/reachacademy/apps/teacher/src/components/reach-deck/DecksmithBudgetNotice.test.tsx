// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReachDeckEditor } from '@reachany/reach-deck-editor';

import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Decksmith 结果卡片上的额度收尾提示（WP4）：用 Teacher 的正式 i18n 目录渲染编辑器，
 * 两种语言都显示固定文案与剩余条数，不显示服务端任务文本或后端兼容文案。
 */
describe('Decksmith budget-limited notice', () => {
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

  it.each([
    {
      locale: 'zh-CN',
      scope: 'run',
      expected: '本次额度已用完，还有 3 项未完成，回复"继续"接着做。',
      partial: 'Decksmith 已生成部分修改建议，请检查实际变更后再决定是否采用。',
    },
    {
      locale: 'en-US',
      scope: 'run',
      expected:
        'This request used up its budget. 3 task(s) are not finished yet — reply "continue" to pick up where it stopped.',
      partial:
        'Decksmith generated a partial change proposal. Review the actual changes before applying it.',
    },
    {
      locale: 'zh-CN',
      scope: 'daily',
      expected: '今日 AI 额度已用完，还有 3 项未完成，额度恢复后回复"继续"接着做。',
      partial: 'Decksmith 已生成部分修改建议，请检查实际变更后再决定是否采用。',
    },
    {
      locale: 'en-US',
      scope: 'daily',
      expected:
        'Today’s AI quota is used up. 3 task(s) are not finished yet — reply "continue" after the quota resets.',
      partial:
        'Decksmith generated a partial change proposal. Review the actual changes before applying it.',
    },
  ] as const)(
    'renders the $scope notice in $locale from the Teacher catalog',
    async ({ expected, locale, partial, scope }) => {
      const baseline = createEditorDocument();
      const candidate = structuredClone(baseline);
      candidate.pages[0] = { ...candidate.pages[0]!, title: 'Budget result', revision: 2 };
      const onAssistantPrompt = vi.fn().mockResolvedValue({
        message: '后端中文兼容文案：不应直接显示。',
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'partial',
          rejectedFontFamilies: [],
          toolErrorCount: 0,
          remainingTasks: ['task-text-1', 'task-text-2', 'task-text-3'],
          completion: {
            state: 'budget-limited',
            scope,
            messageKey: `reachDeck.decksmith.budget.${scope}Limited`,
          },
        },
        document: candidate,
        runtimeApprovalId: `approval-${scope}-${locale}`,
      });
      const messages = REACH_DECK_MESSAGES[locale];

      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
            onAssistantPrompt={onAssistantPrompt}
            translate={(key) => messages[key] ?? key}
          />,
        ),
      );
      const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          button.textContent === messages['reachDeck.editor.assistant.suggestion.shorten'],
      );
      expect(suggestion).toBeDefined();
      await act(async () => suggestion?.click());

      const notice = container.querySelector('.reach-deck-editor__assistant-budget-notice');
      expect(notice?.textContent).toBe(expected);
      expect(notice?.getAttribute('data-budget-scope')).toBe(scope);
      expect(container.textContent).toContain(partial);
      expect(container.textContent).not.toContain('task-text-1');
      expect(container.textContent).not.toContain('后端中文兼容文案');
    },
  );

  it.each([
    {
      locale: 'zh-CN',
      expected: '本次已达到单次执行步数上限，还有 2 项未完成，回复"继续"接着做。',
    },
    {
      locale: 'en-US',
      expected:
        'This request reached its step limit. 2 task(s) are not finished yet — reply "continue" to pick up where it stopped.',
    },
  ] as const)(
    'renders the step-limited notice in $locale from the Teacher catalog',
    async ({ expected, locale }) => {
      const baseline = createEditorDocument();
      const candidate = structuredClone(baseline);
      candidate.pages[0] = { ...candidate.pages[0]!, title: 'Step result', revision: 2 };
      const onAssistantPrompt = vi.fn().mockResolvedValue({
        message: '后端中文兼容文案：不应直接显示。',
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'partial',
          rejectedFontFamilies: [],
          toolErrorCount: 0,
          remainingTasks: ['task-text-1', 'task-text-2'],
          completion: { state: 'step-limited', messageKey: 'reachDeck.decksmith.stepLimited' },
        },
        document: candidate,
        runtimeApprovalId: `approval-step-${locale}`,
      });
      const messages = REACH_DECK_MESSAGES[locale];

      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
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

      const notice = container.querySelector('.reach-deck-editor__assistant-budget-notice');
      expect(notice?.textContent).toBe(expected);
      expect(notice?.getAttribute('data-completion-state')).toBe('step-limited');
      expect(notice?.hasAttribute('data-budget-scope')).toBe(false);
      expect(container.textContent).not.toContain('task-text-1');
    },
  );
});
