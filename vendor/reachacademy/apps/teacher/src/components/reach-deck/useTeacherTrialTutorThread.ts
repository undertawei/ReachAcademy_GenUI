'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tutorGuardrailStopCode, type TutorGuardrailStopCode } from '@reachany/tutor-ui';

import type { ReachDeckPlayerActivity } from '@reachany/reach-deck-player';

export interface TeacherTrialTutorLearningContext {
  schemaVersion: 'reach-deck-teacher-trial-context/v1';
  attemptId: string;
  pageId: string;
  observedAt: string;
  activity: ReachDeckPlayerActivity;
  learningFence?: {
    questionId: string;
    sceneId: string;
  };
}

export type TutorVote = 'up' | 'down' | 'none';
export type TutorFeedbackTarget = 'question' | 'answer';

export interface TutorDiscussionEntry {
  /** Run id；历史条目为真实 uuid，本地新提交在 Run 创建前是临时 id */
  key: string;
  runId?: string;
  question: string;
  answer: string;
  /** Run 提交时随 learningContext 记录的页 id；无 learningContext 的历史为 undefined */
  pageId?: string;
  /** 话题内追问指向的根 Run id；根消息为 undefined */
  replyToRunId?: string;
  /** 教师提问的提交时间（ISO），用于消息时间展示 */
  askedAt?: string;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  statusText?: string;
  guardrailStopCode?: TutorGuardrailStopCode;
  votes: Record<TutorFeedbackTarget, TutorVote>;
}

/** 一个话题 = 根讨论 + 话题内全部追问（按时间排列）。 */
export interface TutorDiscussionTopic {
  root: TutorDiscussionEntry;
  replies: TutorDiscussionEntry[];
}

export function groupIntoTopics(entries: TutorDiscussionEntry[]): TutorDiscussionTopic[] {
  const topics: TutorDiscussionTopic[] = [];
  const byRunId = new Map<string, TutorDiscussionTopic>();
  for (const entry of entries) {
    const parent = entry.replyToRunId ? byRunId.get(entry.replyToRunId) : undefined;
    if (parent) {
      parent.replies.push(entry);
      continue;
    }
    const topic: TutorDiscussionTopic = { root: entry, replies: [] };
    topics.push(topic);
    if (entry.runId) byRunId.set(entry.runId, topic);
  }
  return topics;
}

interface ThreadHistoryEntry {
  run?: {
    id?: unknown;
    status?: unknown;
    error?: unknown;
    queuedAt?: unknown;
    input?: {
      message?: unknown;
      learningContext?: {
        schemaVersion?: unknown;
        fenceId?: unknown;
        pageId?: unknown;
        questionId?: unknown;
        sceneId?: unknown;
        learningFence?: { questionId?: unknown; sceneId?: unknown };
      };
      replyToRunId?: unknown;
    };
  };
  events?: Array<{
    id?: unknown;
    type?: unknown;
    payload?: {
      text?: unknown;
      delta?: unknown;
      code?: unknown;
      message?: unknown;
      target?: unknown;
      vote?: unknown;
    };
  }>;
}

interface ThreadSummary {
  id?: unknown;
  domainScope?: unknown;
}

export interface UseTutorThreadResult {
  entries: TutorDiscussionEntry[];
  threadReady: boolean;
  busy: boolean;
  trialFenceReleasePending: boolean;
  error: string;
  /** 提交一个新问题或话题内追问；队列失败时返回 false 并保留幂等键供重试 */
  submit(
    message: string,
    learningContext?: TeacherTrialTutorLearningContext,
    options?: { replyToRunId?: string },
  ): Promise<boolean>;
  cancel(): Promise<void>;
  vote(runId: string, target: TutorFeedbackTarget, vote: TutorVote): Promise<boolean>;
  clearRetryIfChanged(nextInput: string): void;
}

/**
 * Tutor 线程共享状态：按 domainScope 恢复/复用/创建 student.tutor Thread，
 * 把线程历史（含 message.feedback 投票）重建为结构化讨论条目，提交新 Run 并经
 * SSE 流式接收回答，支持取消与点赞/点踩。
 *
 * 数据源：Teacher BFF `/api/ai-runtime/*` → AI Runtime（public.ai_thread /
 * public.ai_run / public.ai_run_event）。
 * 核心逻辑：
 * 1. localStorage 恢复线程 id，失败则按 domainScope 匹配已有线程，再失败则创建；
 * 2. 历史 Run 逐条映射为 {question, answer, pageId, status, votes}；同一 target
 *    的投票以最新 message.feedback 事件为准；
 * 3. submit 使用幂等键，503 等队列失败时保留同键重试；
 * 4. SSE message.delta 增量拼接，message.completed 定稿，run.failed/cancelled 收尾；
 * 5. vote 乐观更新本地状态并 POST feedback，失败回滚。
 */
export function useTeacherTrialTutorThread({
  domainScope,
  failedText,
  stoppedText,
  initErrorText,
  unavailableText,
  connectionLostText,
  runFailedText,
  describeError,
  onTrialFenceReleased,
}: {
  domainScope: Record<string, string>;
  failedText: string;
  stoppedText: string;
  initErrorText: string;
  unavailableText: string;
  connectionLostText: string;
  runFailedText: string;
  describeError?: (error: unknown) => string | undefined;
  onTrialFenceReleased?: () => void;
}): UseTutorThreadResult {
  const [entries, setEntries] = useState<TutorDiscussionEntry[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [threadReady, setThreadReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trialFenceReleasePendingScopeKey, setTrialFenceReleasePendingScopeKey] =
    useState<string>();
  const [error, setError] = useState('');
  const describeErrorRef = useRef(describeError);
  describeErrorRef.current = describeError;
  const [activeRunId, setActiveRunId] = useState<string>();
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const streamRef = useRef<EventSource | null>(null);
  const onTrialFenceReleasedRef = useRef(onTrialFenceReleased);
  activeRunIdRef.current = activeRunId;
  onTrialFenceReleasedRef.current = onTrialFenceReleased;
  const retrySubmissionRef = useRef<
    { contextKey: string; message: string; requestKey: string } | undefined
  >(undefined);
  const pendingVotesRef = useRef(new Set<string>());
  const pendingTrialFenceReleaseScopesRef = useRef(new Set<string>());
  const releasedNotificationScopesRef = useRef(new Set<string>());
  const scopeKey = useMemo(
    () =>
      JSON.stringify(
        Object.entries(domainScope).sort(([left], [right]) => left.localeCompare(right)),
      ),
    [domainScope],
  );

  const markTrialFenceReleasePending = useCallback(() => {
    if (
      domainScope.tutorDomain !== 'learning_fence' ||
      releasedNotificationScopesRef.current.has(scopeKey)
    ) {
      return;
    }
    pendingTrialFenceReleaseScopesRef.current.add(scopeKey);
    setTrialFenceReleasePendingScopeKey(scopeKey);
    // The release is authoritative, so the final answer may continue but can no longer be cancelled.
    activeRunIdRef.current = undefined;
    setActiveRunId(undefined);
  }, [domainScope.tutorDomain, scopeKey]);

  const notifyTrialFenceReleased = useCallback(() => {
    if (
      domainScope.tutorDomain !== 'learning_fence' ||
      !pendingTrialFenceReleaseScopesRef.current.has(scopeKey) ||
      releasedNotificationScopesRef.current.has(scopeKey)
    ) {
      return;
    }
    pendingTrialFenceReleaseScopesRef.current.delete(scopeKey);
    releasedNotificationScopesRef.current.add(scopeKey);
    setTrialFenceReleasePendingScopeKey((current) => (current === scopeKey ? undefined : current));
    onTrialFenceReleasedRef.current?.();
  }, [domainScope.tutorDomain, scopeKey]);

  const openEventStream = useCallback(
    (runId: string, entryKey: string, after?: string) => {
      streamRef.current?.close();
      const eventsUrl = `/api/ai-runtime/runs/${encodeURIComponent(runId)}/events${
        after ? `?after=${encodeURIComponent(after)}` : ''
      }`;
      const source = new EventSource(eventsUrl);
      streamRef.current = source;
      const finish = () => {
        source.close();
        if (streamRef.current === source) streamRef.current = null;
        activeRunIdRef.current = undefined;
        setActiveRunId(undefined);
        setBusy(false);
      };
      const patch = (updater: (entry: TutorDiscussionEntry) => TutorDiscussionEntry) => {
        setEntries((current) =>
          current.map((entry) => (entry.key === entryKey ? updater(entry) : entry)),
        );
      };
      source.addEventListener('message.delta', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { delta?: unknown };
        if (typeof payload.delta !== 'string') return;
        patch((entry) => ({ ...entry, answer: entry.answer + payload.delta }));
      });
      source.addEventListener('message.completed', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { text?: unknown };
        patch((entry) => ({
          ...entry,
          status: 'completed',
          answer: typeof payload.text === 'string' ? payload.text : entry.answer,
        }));
      });
      source.addEventListener('learning_fence.trial_released', () => {
        markTrialFenceReleasePending();
      });
      source.addEventListener('open', () => {
        setError('');
      });
      source.addEventListener('run.completed', () => {
        patch((entry) =>
          entry.status === 'streaming' ? { ...entry, status: 'completed' } : entry,
        );
        finish();
        notifyTrialFenceReleased();
      });
      source.addEventListener('run.cancelled', () => {
        patch((entry) => ({ ...entry, status: 'cancelled', statusText: stoppedText }));
        finish();
        notifyTrialFenceReleased();
      });
      source.addEventListener('run.guardrail_stopped', (event) => {
        const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
        const code = tutorGuardrailStopCode(payload);
        if (!code) return;
        patch((entry) => ({ ...entry, status: 'failed', guardrailStopCode: code }));
        // The entry owns this localized notice, including after restoring history.
        setError('');
        finish();
        notifyTrialFenceReleased();
      });
      source.addEventListener('run.failed', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { message?: unknown };
        const code = tutorGuardrailStopCode(payload);
        setError(
          code
            ? ''
            : (describeErrorRef.current?.(payload) ??
                (typeof payload.message === 'string' ? payload.message : runFailedText)),
        );
        patch((entry) => ({
          ...entry,
          status: 'failed',
          statusText: failedText,
          guardrailStopCode: tutorGuardrailStopCode(payload) ?? entry.guardrailStopCode,
        }));
        finish();
        notifyTrialFenceReleased();
      });
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) return;
        setError(connectionLostText);
        if (pendingTrialFenceReleaseScopesRef.current.has(scopeKey)) {
          // EventSource will reconnect with Last-Event-ID. A transport error is not a Run terminal;
          // keep receiving the final Tutor answer before exposing the passed state.
          return;
        }
        finish();
      };
    },
    [
      connectionLostText,
      failedText,
      markTrialFenceReleasePending,
      notifyTrialFenceReleased,
      runFailedText,
      scopeKey,
      stoppedText,
    ],
  );

  useEffect(() => {
    let disposed = false;
    const storageKey = `reachany:tutor-thread:${scopeKey}`;

    async function initializeThread() {
      setThreadReady(false);
      setError('');
      streamRef.current?.close();
      let candidateThreadId = globalThis.localStorage.getItem(storageKey) ?? undefined;
      if (candidateThreadId) {
        const restored = await fetch(
          `/api/ai-runtime/threads/${encodeURIComponent(candidateThreadId)}`,
        ).catch(() => undefined);
        if (restored?.ok) {
          const body = (await restored.json()) as {
            thread?: ThreadSummary;
            history?: ThreadHistoryEntry[];
          };
          if (disposed) return;
          if (sameScope(body.thread?.domainScope, domainScope)) {
            const restoredThreadId =
              typeof body.thread?.id === 'string' ? body.thread.id : candidateThreadId;
            globalThis.localStorage.setItem(storageKey, restoredThreadId);
            restoreThread(restoredThreadId, body.history);
            return;
          }
        }
        globalThis.localStorage.removeItem(storageKey);
        candidateThreadId = undefined;
      }

      const listed = await fetch('/api/ai-runtime/threads?sceneKey=student.tutor');
      if (listed.ok) {
        const body = (await listed.json()) as { threads?: ThreadSummary[] };
        const matching = body.threads?.find(
          (thread) => typeof thread.id === 'string' && sameScope(thread.domainScope, domainScope),
        );
        if (typeof matching?.id === 'string') candidateThreadId = matching.id;
      }
      if (candidateThreadId) {
        const restored = await fetch(
          `/api/ai-runtime/threads/${encodeURIComponent(candidateThreadId)}`,
        );
        if (restored.ok) {
          const body = (await restored.json()) as {
            thread?: ThreadSummary;
            history?: ThreadHistoryEntry[];
          };
          if (disposed) return;
          const restoredThreadId =
            typeof body.thread?.id === 'string' ? body.thread.id : candidateThreadId;
          globalThis.localStorage.setItem(storageKey, restoredThreadId);
          restoreThread(restoredThreadId, body.history);
          return;
        }
      }

      const contextSummary = Object.entries(domainScope)
        .map(([key, value]) => `${key}: ${value}`)
        .join(' · ');
      const created = await fetch('/api/ai-runtime/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sceneKey: 'student.tutor',
          title: (contextSummary || 'AI Tutor').slice(0, 240),
          domainScope,
        }),
      });
      const body = (await created.json()) as { thread?: { id?: unknown }; error?: string };
      if (!created.ok || typeof body.thread?.id !== 'string') {
        throw Object.assign(new Error(body.error ?? `AI Runtime returned HTTP ${created.status}`), {
          code: (body as { code?: unknown }).code,
        });
      }
      if (disposed) return;
      globalThis.localStorage.setItem(storageKey, body.thread.id);
      setThreadId(body.thread.id);
      setEntries([]);
      setThreadReady(true);
    }

    function restoreThread(restoredThreadId: string, history: ThreadHistoryEntry[] | undefined) {
      const matchingHistory = filterTutorDomainHistory(history, domainScope);
      setThreadId(restoredThreadId);
      setEntries(restoreEntries(matchingHistory, failedText, stoppedText));
      setThreadReady(true);
      const released =
        domainScope.tutorDomain === 'learning_fence' && hasTrialFenceRelease(matchingHistory);
      if (released) markTrialFenceReleasePending();
      const active = findActiveRun(matchingHistory);
      if (active) {
        setEntries((current) => {
          const last = current.at(-1);
          if (last?.runId === active.runId) return current;
          return current;
        });
        setBusy(true);
        if (!released) {
          activeRunIdRef.current = active.runId;
          setActiveRunId(active.runId);
        }
        openEventStream(active.runId, `history-${active.runId}`, active.after);
      } else {
        setBusy(false);
        if (released) notifyTrialFenceReleased();
      }
    }

    void initializeThread().catch((cause) => {
      if (disposed) return;
      setError(cause instanceof Error ? cause.message : initErrorText);
      setThreadReady(false);
    });
    return () => {
      disposed = true;
      streamRef.current?.close();
      streamRef.current = null;
      const runId = activeRunIdRef.current;
      if (runId) {
        void fetch(`/api/ai-runtime/runs/${encodeURIComponent(runId)}/cancel`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [
    domainScope,
    failedText,
    initErrorText,
    markTrialFenceReleasePending,
    notifyTrialFenceReleased,
    openEventStream,
    scopeKey,
    stoppedText,
  ]);

  const submit = useCallback(
    async (
      message: string,
      learningContext?: TeacherTrialTutorLearningContext,
      options?: { replyToRunId?: string },
    ): Promise<boolean> => {
      if (!message || busy || !threadId) return false;
      setError('');
      setBusy(true);
      const entryKey = globalThis.crypto.randomUUID();
      const replyToRunId = options?.replyToRunId;
      const contextKey = JSON.stringify([learningContext ?? null, replyToRunId ?? null]);
      const requestKey =
        retrySubmissionRef.current?.message === message &&
        retrySubmissionRef.current.contextKey === contextKey
          ? retrySubmissionRef.current.requestKey
          : globalThis.crypto.randomUUID();
      setEntries((current) => [
        ...current,
        {
          key: entryKey,
          question: message,
          answer: '',
          // 视频上下文没有 pageId，仅 reach-deck 上下文归组到 Deck 页。
          pageId:
            learningContext !== undefined && 'pageId' in learningContext
              ? learningContext.pageId
              : undefined,
          ...(replyToRunId ? { replyToRunId } : {}),
          askedAt: new Date().toISOString(),
          status: 'streaming',
          votes: { question: 'none', answer: 'none' },
        },
      ]);

      try {
        const response = await fetch('/api/ai-runtime/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': requestKey },
          body: JSON.stringify({
            threadId,
            sceneKey: 'student.tutor',
            message,
            domainScope,
            ...(learningContext ? { learningContext } : {}),
            ...(replyToRunId ? { replyToRunId } : {}),
          }),
        });
        const body = (await response.json()) as {
          runId?: string;
          error?: string;
          eventsAfter?: unknown;
        };
        if (!response.ok || !body.runId) {
          throw Object.assign(
            new Error(body.error ?? `AI Runtime returned HTTP ${response.status}`),
            { code: (body as { code?: unknown }).code },
          );
        }
        retrySubmissionRef.current = undefined;
        const runId = body.runId;
        setEntries((current) =>
          current.map((entry) => (entry.key === entryKey ? { ...entry, runId } : entry)),
        );
        activeRunIdRef.current = runId;
        setActiveRunId(runId);
        openEventStream(
          runId,
          entryKey,
          typeof body.eventsAfter === 'string' ? body.eventsAfter : undefined,
        );
        return true;
      } catch (caught) {
        setBusy(false);
        setError(
          describeErrorRef.current?.(caught) ??
            (caught instanceof Error ? caught.message : unavailableText),
        );
        retrySubmissionRef.current = { contextKey, message, requestKey };
        setEntries((current) => current.filter((entry) => entry.key !== entryKey));
        return false;
      }
    },
    [busy, domainScope, openEventStream, threadId, unavailableText],
  );

  const cancel = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/ai-runtime/runs/${encodeURIComponent(activeRunId)}/cancel`, {
      method: 'POST',
    }).catch(() => undefined);
  }, [activeRunId]);

  const vote = useCallback(
    async (runId: string, target: TutorFeedbackTarget, nextVote: TutorVote): Promise<boolean> => {
      const voteKey = `${runId}:${target}`;
      if (pendingVotesRef.current.has(voteKey)) return false;
      let previous: TutorVote = 'none';
      let unchanged = false;
      setEntries((current) =>
        current.map((entry) => {
          if (entry.runId !== runId) return entry;
          previous = entry.votes[target];
          if (previous === nextVote) {
            unchanged = true;
            return entry;
          }
          return { ...entry, votes: { ...entry.votes, [target]: nextVote } };
        }),
      );
      if (unchanged) return true;
      pendingVotesRef.current.add(voteKey);
      const response = await fetch(`/api/ai-runtime/runs/${encodeURIComponent(runId)}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, vote: nextVote }),
      }).catch(() => undefined);
      pendingVotesRef.current.delete(voteKey);
      if (response?.ok) return true;
      setEntries((current) =>
        current.map((entry) =>
          entry.runId === runId
            ? { ...entry, votes: { ...entry.votes, [target]: previous } }
            : entry,
        ),
      );
      return false;
    },
    [],
  );

  const clearRetryIfChanged = useCallback((nextInput: string) => {
    if (retrySubmissionRef.current?.message !== nextInput.trim()) {
      retrySubmissionRef.current = undefined;
    }
  }, []);

  return {
    entries,
    threadReady,
    busy,
    trialFenceReleasePending: trialFenceReleasePendingScopeKey === scopeKey,
    error,
    submit,
    cancel,
    vote,
    clearRetryIfChanged,
  };
}

function hasTrialFenceRelease(history: ThreadHistoryEntry[]): boolean {
  return history.some((entry) =>
    entry.events?.some((event) => event.type === 'learning_fence.trial_released'),
  );
}

function filterTutorDomainHistory(
  history: ThreadHistoryEntry[] | undefined,
  domainScope: Record<string, string>,
): ThreadHistoryEntry[] {
  return (history ?? []).filter((entry) => {
    const context = entry.run?.input?.learningContext;
    const schemaVersion = context?.schemaVersion;
    const fenceContext =
      schemaVersion === 'reach-deck-learning-fence-context/v1' ||
      (schemaVersion === 'reach-deck-teacher-trial-context/v1' && context?.learningFence != null);
    if (domainScope.tutorDomain !== 'learning_fence') return !fenceContext;
    if (!fenceContext) return false;
    if (domainScope.fenceId !== undefined && context?.fenceId !== domainScope.fenceId) return false;
    const fence = context?.learningFence;
    return ['pageId', 'questionId', 'sceneId'].every((key) => {
      const expected = domainScope[key];
      if (expected === undefined) return true;
      const actual =
        key === 'pageId'
          ? context?.pageId
          : (context?.[key as 'questionId' | 'sceneId'] ??
            fence?.[key as 'questionId' | 'sceneId']);
      return actual === expected;
    });
  });
}

function restoreEntries(
  history: ThreadHistoryEntry[] | undefined,
  failedText: string,
  stoppedText: string,
): TutorDiscussionEntry[] {
  const restored: TutorDiscussionEntry[] = [];
  for (const entry of history ?? []) {
    const run = entry.run;
    const runId = typeof run?.id === 'string' ? run.id : undefined;
    const question = typeof run?.input?.message === 'string' ? run.input.message.trim() : '';
    if (!runId || !question) continue;
    const pageId =
      typeof run?.input?.learningContext?.pageId === 'string'
        ? run.input.learningContext.pageId
        : undefined;
    const replyToRunId =
      typeof run?.input?.replyToRunId === 'string' ? run.input.replyToRunId : undefined;
    const askedAt = typeof run?.queuedAt === 'string' ? run.queuedAt : undefined;
    const completed = entry.events?.find((event) => event.type === 'message.completed');
    const answer =
      typeof completed?.payload?.text === 'string'
        ? completed.payload.text.trim()
        : (entry.events ?? [])
            .filter(
              (event) => event.type === 'message.delta' && typeof event.payload?.delta === 'string',
            )
            .map((event) => event.payload!.delta as string)
            .join('');
    const guardrailStopCode =
      tutorGuardrailStopCode(run?.error) ??
      tutorGuardrailStopCode(
        [...(entry.events ?? [])]
          .reverse()
          .find((event) => event.type === 'run.guardrail_stopped' || event.type === 'run.failed')
          ?.payload,
      );
    const votes: Record<TutorFeedbackTarget, TutorVote> = { question: 'none', answer: 'none' };
    for (const event of entry.events ?? []) {
      if (event.type !== 'message.feedback') continue;
      const target = event.payload?.target;
      const eventVote = event.payload?.vote;
      if (
        (target === 'question' || target === 'answer') &&
        (eventVote === 'up' || eventVote === 'down' || eventVote === 'none')
      ) {
        votes[target] = eventVote;
      }
    }
    let status: TutorDiscussionEntry['status'] = 'completed';
    let statusText: string | undefined;
    if (run?.status === 'failed') {
      status = 'failed';
      statusText = failedText;
    } else if (run?.status === 'cancelled') {
      status = 'cancelled';
      statusText = stoppedText;
    } else if (run?.status === 'queued' || run?.status === 'running') {
      status = 'streaming';
    }
    restored.push({
      key: `history-${runId}`,
      runId,
      question,
      answer,
      pageId,
      ...(replyToRunId ? { replyToRunId } : {}),
      ...(askedAt ? { askedAt } : {}),
      status,
      statusText,
      guardrailStopCode,
      votes,
    });
  }
  return restored;
}

function findActiveRun(
  history: ThreadHistoryEntry[] | undefined,
): { runId: string; after?: string } | undefined {
  const last = history?.at(-1)?.run;
  if (typeof last?.id !== 'string' || (last.status !== 'queued' && last.status !== 'running')) {
    return undefined;
  }
  const eventIds = (history?.at(-1)?.events ?? [])
    .filter((event) => event.type !== 'message.feedback')
    .map((event) => (typeof event.id === 'string' && /^\d+$/.test(event.id) ? event.id : undefined))
    .filter((id): id is string => id !== undefined);
  return eventIds.length > 0 ? { runId: last.id, after: eventIds.at(-1) } : { runId: last.id };
}

function sameScope(value: unknown, expected: Record<string, string>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  // Runtime canonicalizes an omitted Tutor discriminator as ordinary on either side.
  const expectedEntries = Object.entries({
    ...expected,
    tutorDomain: expected.tutorDomain ?? 'ordinary',
  }).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries({
    ...actual,
    tutorDomain: actual.tutorDomain === undefined ? 'ordinary' : actual.tutorDomain,
  })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}
