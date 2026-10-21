// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StarterKit from '@tiptap/starter-kit';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectedTutorDiscussion, type UseDirectedTutorThreadResult } from '@reachany/tutor-ui';

const captured = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('@tiptap/react', async (load) => {
  const actual = await load<typeof import('@tiptap/react')>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      const editor = actual.useEditor(...args);
      captured.editor = editor;
      return editor;
    },
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const richText = {
  createExtensions: () => [StarterKit],
  serialize: (doc: unknown) => JSON.stringify(doc),
  MessageContent: () => null,
};
let root: Root;
let container: HTMLDivElement;
const submit = vi.fn().mockResolvedValue(true);
function render(
  overrides: Partial<UseDirectedTutorThreadResult> = {},
  activePageId?: string,
  sendButton?: 'icon' | 'label' | 'shortcut',
) {
  const thread = {
    messages: [],
    roster: [
      { agentId: 'a', displayName: 'Alice', agentRole: 'teacher', languageCode: 'en-US' },
      { agentId: 'b', displayName: 'Bob', agentRole: 'classmate', languageCode: 'en-US' },
    ],
    initializing: false,
    unavailable: false,
    busy: false,
    submissionPending: false,
    threadReady: true,
    error: '',
    submit,
    refreshRoster: vi.fn(),
    clearRetryIfChanged: vi.fn(),
    ...overrides,
  } as unknown as UseDirectedTutorThreadResult;
  root.render(
    <DirectedTutorDiscussion
      activePageId={activePageId}
      ariaLabel="Tutor"
      contextReady
      emptyText="Empty"
      locale="en-US"
      pages={[
        { pageId: 'page-1', title: 'Lesson', order: 1 },
        { pageId: 'page-3', title: 'Later lesson', order: 3 },
      ]}
      resolveLearningContext={() => ({})}
      richText={richText}
      sendButton={sendButton}
      subtitle="Discussion"
      t={(key) => key}
      thread={thread}
      waitingText="Wait"
    />,
  );
}
async function type(text: string) {
  await act(async () => {
    captured.editor!.commands.setContent(`<p>${text}</p>`);
    captured.editor!.commands.setTextSelection(text.length + 1);
  });
}
async function key(value: string, modifiers: KeyboardEventInit = {}) {
  await act(async () => {
    captured.editor!.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers }),
    );
  });
}
beforeEach(async () => {
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  submit.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => render());
});
afterEach(async () => {
  // Run Tiptap's deferred focus/selection scroll while its editor is still mounted.
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
describe('directed Tutor inline mentions', () => {
  it('offers mentions after Chinese prose without matching an email address', async () => {
    await type('请@');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    await type('请问@Al');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await key('Enter');
    expect(captured.editor!.getText()).toBe('请问@Alice ');
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'student.tutor.send',
    )!;
    await act(async () => send.click());
    expect(submit).toHaveBeenCalledWith(
      expect.stringContaining('请问@Alice '),
      {},
      { mentions: ['a'] },
    );
    await type('name@Al');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
  it('offers members only at @, supports arrow selection and sends structured routing directives', async () => {
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await type('@');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    await key('ArrowDown');
    await key('Enter');
    expect(captured.editor!.getText()).toBe('@Bob ');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'student.tutor.send',
    )!;
    await act(async () => send.click());
    expect(submit).toHaveBeenCalledWith(expect.stringContaining('@Bob '), {}, { mentions: ['b'] });
  });
  it('filters suggestions, inserts on click, dismisses on Escape and updates when selection moves', async () => {
    await type('@Al');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () =>
      (container.querySelector('[role="option"]') as HTMLButtonElement).click(),
    );
    expect(captured.editor!.getText()).toBe('@Alice ');
    await type('@');
    await key('Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await type('@Bo');
    await act(async () => captured.editor!.commands.setTextSelection(1));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});

it('opens only actor topics and keeps delayed, cross-page and agent-to-agent replies under their question', async () => {
  const question = {
    id: 'question',
    authorKind: 'actor',
    sequenceNumber: 1,
    contextWatermark: 1,
    pageId: 'page-1',
    content: 'First question',
    status: 'completed',
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none',
    generationEpoch: 0,
  } as const;
  const tutor = {
    ...question,
    id: 'tutor',
    authorKind: 'course_agent' as const,
    sequenceNumber: 2,
    authorRole: 'teacher',
    content: 'Tutor answer',
    replyToMessageId: question.id,
  };
  const followup = {
    ...question,
    id: 'followup',
    sequenceNumber: 3,
    contextWatermark: 3,
    pageId: 'page-3',
    content: 'My reply starts a new topic',
    replyToMessageId: tutor.id,
  };
  const assistant = {
    ...tutor,
    id: 'assistant',
    sequenceNumber: 4,
    contextWatermark: 3,
    pageId: 'page-3',
    authorRole: 'teaching_assistant',
    replyToMessageId: tutor.id,
  };
  const lateReply = {
    ...tutor,
    id: 'late',
    sequenceNumber: 5,
    replyToMessageId: undefined,
    pageId: undefined,
  };
  const newReply = {
    ...tutor,
    id: 'new-reply',
    sequenceNumber: 6,
    contextWatermark: 3,
    replyToMessageId: undefined,
  };
  await act(async () =>
    render({ messages: [question, tutor, followup, assistant, lateReply, newReply] }),
  );
  expect(
    [...container.querySelectorAll('[data-tutor-topic]')].map((node) =>
      node.getAttribute('data-tutor-topic'),
    ),
  ).toEqual(['question', 'followup']);
  const topic = container.querySelector('[data-tutor-topic="question"]')!;
  expect(
    [...topic.querySelectorAll('[data-tutor-message]')].map((node) =>
      node.getAttribute('data-tutor-message'),
    ),
  ).toEqual(['question', 'tutor', 'assistant', 'late']);
  expect(topic.closest('[data-discussion-group]')?.getAttribute('data-discussion-group')).toBe(
    'page-1',
  );
  expect(
    container
      .querySelector('[data-tutor-message="new-reply"]')
      ?.closest('[data-tutor-topic]')
      ?.getAttribute('data-tutor-topic'),
  ).toBe('followup');
  expect(container.querySelector('[data-tutor-message="followup"]')?.textContent).toContain(
    'tutorDiscussion.replyingTo',
  );
});

it('does not promote orphan agent messages to root topics', async () => {
  await act(async () =>
    render({
      messages: [
        {
          id: 'orphan',
          authorKind: 'default_tutor',
          sequenceNumber: 1,
          contextWatermark: 0,
          content: 'No question',
          status: 'completed',
          createdAt: '2026-09-19T00:00:00Z',
          feedbackVote: 'none',
          generationEpoch: 0,
        },
      ],
    }),
  );
  expect(container.querySelector('[data-tutor-topic]')).toBeNull();
});

it('cancels a quoted reply without losing the draft and keeps placeholder inside the empty editor', async () => {
  submit.mockResolvedValue(true);
  const question = {
    id: 'question',
    authorKind: 'actor' as const,
    sequenceNumber: 1,
    contextWatermark: 1,
    content: 'A long question to quote',
    status: 'completed' as const,
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none' as const,
    generationEpoch: 0,
  };
  await act(async () => render({ messages: [question] }));
  expect(
    container.querySelector('[data-tutor-placeholder]')?.closest('[data-tutor-composer]'),
  ).not.toBeNull();
  const reply = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('tutorDiscussion.replyToMessage'),
  )!;
  await act(async () => reply.click());
  const cancel = container.querySelector<HTMLButtonElement>(
    '[title="tutorDiscussion.cancelReply"]',
  )!;
  expect(cancel.closest('[data-tutor-reply-target]')).not.toBeNull();
  await type('Keep this draft');
  expect(container.querySelector('[data-tutor-placeholder]')).toBeNull();
  await act(async () => cancel.click());
  expect(container.querySelector('[data-tutor-reply-target]')).toBeNull();
  expect(captured.editor!.getText()).toBe('Keep this draft');
  const send = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'student.tutor.send',
  )!;
  await act(async () => send.click());
  expect(submit).toHaveBeenCalledWith(expect.stringContaining('Keep this draft'), {}, {});
  expect(container.querySelector('[data-tutor-placeholder]')).not.toBeNull();
});

it('keeps waiting and between-speaker status in the actor page, then shows the active member', async () => {
  const actor = {
    id: 'actor',
    authorKind: 'actor',
    sequenceNumber: 1,
    contextWatermark: 1,
    pageId: 'page-1',
    content: 'Question',
    status: 'completed',
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none',
    generationEpoch: 0,
  } as const;
  const round = {
    id: 'round',
    inputWatermark: 1,
    status: 'queued',
  } as UseDirectedTutorThreadResult['activeRound'];
  await act(async () => render({ messages: [actor], busy: true, activeRound: round }));
  let pending = container.querySelector('[data-tutor-pending]');
  expect(pending?.textContent).toContain('tutorDiscussion.directed.queued');
  expect(pending?.closest('[data-discussion-group]')?.getAttribute('data-discussion-group')).toBe(
    'page-1',
  );
  const list = container.querySelector('[aria-live="polite"]') as HTMLElement;
  const group = container.querySelector('[data-discussion-group="page-1"]') as HTMLElement;
  Object.defineProperty(list, 'scrollHeight', { value: 2000 });
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ bottom: 300 } as DOMRect);
  vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({ bottom: 400 } as DOMRect);
  await act(async () =>
    render({ messages: [actor], busy: true, activeRound: { ...round!, status: 'directing' } }),
  );
  expect(container.querySelector('[data-tutor-pending]')?.textContent).toContain(
    'tutorDiscussion.directed.directing',
  );
  expect(list.scrollTop).toBe(100);
  const member = {
    ...actor,
    id: 'member',
    sequenceNumber: 2,
    authorKind: 'course_agent' as const,
    authorDisplayName: 'Bob',
    content: '',
    status: 'streaming' as const,
  };
  await act(async () =>
    render({
      messages: [actor, member],
      busy: true,
      activeRound: { ...round!, status: 'generating', activeMessageId: 'member' },
    }),
  );
  expect(container.querySelector('[data-tutor-pending]')).toBeNull();
  expect(container.querySelector('[data-tutor-message="member"]')?.textContent).toContain('Bob');
  expect(container.querySelector('[data-tutor-message="member"]')?.textContent).toContain(
    'student.tutor.thinking',
  );
  await act(async () =>
    render({
      messages: [actor, { ...member, status: 'completed', content: 'Answer' }],
      busy: true,
      activeRound: { ...round!, status: 'directing' },
    }),
  );
  expect(container.querySelector('[data-tutor-pending]')).not.toBeNull();
});
it('preserves scroll position when reading older messages', async () => {
  const list = container.querySelector('[aria-live="polite"]') as HTMLElement;
  Object.defineProperties(list, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  list.scrollTop = 100;
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => render({ messages: [] }));
  expect(list.scrollTop).toBe(100);
  list.scrollTop = 780;
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => render({ messages: [] }));
  expect(list.scrollTop).toBe(1000);
});

it('pauses follow during page navigation and its smooth scroll until the reader scrolls back', async () => {
  const scrollTo = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });
  const question = {
    id: 'question',
    authorKind: 'actor' as const,
    content: 'Question',
    status: 'completed' as const,
    sequenceNumber: 1,
    contextWatermark: 1,
    pageId: 'page-1',
    generationEpoch: 0,
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none' as const,
  };
  const history = { ...question, id: 'history', pageId: 'page-3', sequenceNumber: 0 };
  const round = {
    id: 'round',
    inputWatermark: 1,
    status: 'directing',
  } as UseDirectedTutorThreadResult['activeRound'];
  const state = { messages: [history, question], busy: true, activeRound: round };
  await act(async () => render(state, 'page-1'));
  const list = container.querySelector('[aria-live="polite"]') as HTMLElement;
  const group = container.querySelector('[data-discussion-group="page-1"]') as HTMLElement;
  list.scrollTop = 100;
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect);
  vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({ bottom: 210 } as DOMRect);
  // A page change and incoming message can share a render. Navigation wins.
  await act(async () => render({ ...state, messages: [...state.messages] }, 'page-3'));
  expect(scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', top: expect.any(Number) });
  expect(scrollTo.mock.contexts.at(-1)).toBe(list);
  // Early smooth-scroll events can still be close to the old question.
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => render({ ...state, messages: [...state.messages] }, 'page-3'));
  expect(list.scrollTop).toBe(100);
  // Explicit user scrolling near the question resumes following.
  await act(async () => {
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await act(async () => render({ ...state, messages: [...state.messages] }, 'page-3'));
  expect(list.scrollTop).toBe(110);
});

it('follows a restored in-progress discussion when mounting with an active Deck page', async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => render({}, 'page-1'));
  const question = {
    id: 'question',
    authorKind: 'actor' as const,
    content: 'Question',
    status: 'completed' as const,
    sequenceNumber: 1,
    contextWatermark: 1,
    pageId: 'page-1',
    generationEpoch: 0,
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none' as const,
  };
  const round = {
    id: 'round',
    inputWatermark: 1,
    status: 'directing',
  } as UseDirectedTutorThreadResult['activeRound'];
  const state = { messages: [question], busy: true, activeRound: round };
  await act(async () => render(state, 'page-1'));
  const list = container.querySelector('[aria-live="polite"]') as HTMLElement;
  const group = container.querySelector('[data-discussion-group="page-1"]') as HTMLElement;
  list.scrollTop = 100;
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect);
  vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({ bottom: 250 } as DOMRect);
  await act(async () => render({ ...state, messages: [...state.messages] }, 'page-1'));
  expect(list.scrollTop).toBe(150);
});

it('keeps following an earlier page when later-page history is below it, including round completion', async () => {
  const question = {
    id: 'question',
    authorKind: 'actor' as const,
    content: 'Question',
    status: 'completed' as const,
    sequenceNumber: 2,
    contextWatermark: 2,
    pageId: 'page-1',
    generationEpoch: 0,
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none' as const,
  };
  const history = { ...question, id: 'history', pageId: 'page-3', sequenceNumber: 1 };
  const messages = [history, question];
  const round = {
    id: 'round',
    inputWatermark: 2,
    status: 'directing',
  } as UseDirectedTutorThreadResult['activeRound'];
  await act(async () => render({ messages, busy: true, activeRound: round }));
  const list = container.querySelector('[aria-live="polite"]') as HTMLElement;
  const group = container.querySelector('[data-discussion-group="page-1"]') as HTMLElement;
  Object.defineProperties(list, { scrollHeight: { value: 2000 }, clientHeight: { value: 200 } });
  list.scrollTop = 100;
  list.getBoundingClientRect = () => ({ bottom: 200 }) as DOMRect;
  let groupBottom = 210;
  group.getBoundingClientRect = () => ({ bottom: groupBottom }) as DOMRect;
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => render({ messages: [...messages], busy: true, activeRound: round }));
  expect(list.scrollTop).toBe(110);
  groupBottom = 205;
  await act(async () => render({ messages: [...messages], busy: false, activeRound: undefined }));
  expect(list.scrollTop).toBe(115);
});

describe('directed Tutor keyboard send shortcut', () => {
  beforeEach(() => window.localStorage.removeItem('reachany.tutor.send-shortcut'));

  it('sends on Enter by default, keeps Shift+Enter for a new line and shows the shortcut', async () => {
    await act(async () => render({}, undefined, 'shortcut'));
    expect(container.querySelector('[data-tutor-send-hint]')?.textContent).toBe(
      'tutorDiscussion.sendShortcut.enter',
    );
    await type('hello');
    await key('Enter', { shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    await key('Enter');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toContain('hello');
  });

  it('switches to Ctrl+Enter from the menu and remembers the choice', async () => {
    await act(async () => render({}, undefined, 'shortcut'));
    const trigger = container.querySelector('.reach-tutor-send-menu') as HTMLButtonElement;
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === 'tutorDiscussion.sendShortcut.modEnterOption',
    ) as HTMLElement;
    await act(async () => option.click());
    expect(window.localStorage.getItem('reachany.tutor.send-shortcut')).toBe('mod-enter');
    expect(container.querySelector('[data-tutor-send-hint]')?.textContent).toBe(
      'tutorDiscussion.sendShortcut.modEnter',
    );
    await type('hello');
    await key('Enter');
    expect(submit).not.toHaveBeenCalled();
    await key('Enter', { ctrlKey: true });
    expect(submit).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render({}, undefined, 'shortcut'));
    expect(container.querySelector('[data-tutor-send-hint]')?.textContent).toBe(
      'tutorDiscussion.sendShortcut.modEnter',
    );
  });

  it('keeps Enter as a line break for the label style', async () => {
    await type('hello');
    await key('Enter');
    expect(submit).not.toHaveBeenCalled();
  });
});
