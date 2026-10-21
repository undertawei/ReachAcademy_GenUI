import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';

import type {
  ReachDeckTeacherTrialLearningContext,
  ReachDeckTutorLearningContext,
  RunRecord,
} from './contracts.js';
import {
  contentApiUrl,
  domainGet,
  domainPost,
  domainServiceGet,
  studentApiUrl,
} from './domain-client.js';
import { isRuntimeMockMode, type RuntimeEnv } from './env.js';
import type { RuntimeStore } from './store/index.js';
import { createTutorDeckPageTools, tutorPageMedia } from './tutor-deck-pages.js';
import {
  contextMismatch,
  contextRecord,
  executeAuditedTool,
  optionalRecord,
  requireContextIdentity,
  type RuntimeTool,
} from './tutor-tool-support.js';
import {
  createVideoTutorTools,
  isVideoTutorRun,
  resolveVideoTutorContext,
  type VideoTutorToolDeps,
} from './video-tutor-tools.js';

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new Error(`${key} must be a non-empty string no longer than 200 characters`);
  }
  return value.trim();
}

export function createTutorTools(
  run: RunRecord,
  store: RuntimeStore,
  env: RuntimeEnv = process.env,
  videoDeps?: VideoTutorToolDeps,
): AgentTool[] {
  const mock = isRuntimeMockMode(env);
  const definitions: RuntimeTool[] = [
    {
      name: 'classroom.get_current_context',
      label: '读取当前学习位置',
      description:
        'Read the learner current course/module/question references. Call this first for contextual questions.',
      parameters: Type.Object({}),
      timeoutMs: 2_000,
      outputBytes: 64_000,
      execute: async (_input, signal) => resolveTutorRunContext(run, env, signal),
    },
    ...createTutorDeckPageTools(run, env),
    {
      name: 'content.search',
      label: '检索课程目录',
      description: 'Search student-visible course outline titles by keyword.',
      parameters: Type.Object({
        keyword: Type.String(),
        courseKey: Type.Optional(Type.String()),
      }),
      timeoutMs: 10_000,
      outputBytes: 32_000,
      execute: async (input, signal) => {
        if (mock) {
          return {
            matches: [
              {
                componentKey: run.domainScope.componentKey ?? 'mock-module',
                title: '函数与变化率',
              },
            ],
          };
        }
        const keyword = requireString(input, 'keyword').toLowerCase();
        const courseKey =
          typeof input.courseKey === 'string' && input.courseKey.trim()
            ? requireString(input, 'courseKey')
            : run.domainScope.courseKey;
        const navigation = await domainGet(studentApiUrl('/my/active-navigation', env), run, {
          env,
          signal,
        });
        return {
          keyword,
          ...(courseKey ? { courseKey } : {}),
          matches: findOutlineMatches(navigation, keyword, courseKey).slice(0, 50),
        };
      },
    },
    {
      name: 'assessment.get_student_mastery',
      label: '读取我的学习进度',
      description: 'Read the current learner own track and module progress.',
      parameters: Type.Object({}),
      timeoutMs: 10_000,
      outputBytes: 48_000,
      execute: async (_input, signal) =>
        mock
          ? { modules: [{ title: '函数与变化率', status: 'in_progress', mastery: 0.62 }] }
          : domainGet(studentApiUrl('/my/student-tracks', env), run, { env, signal }),
    },
    {
      name: 'assessment.get_current_submission',
      label: '读取我的当前提交',
      description:
        'Read the learner own submission, feedback, and authoritative teaching references for private Tutor grounding.',
      parameters: Type.Object({ moduleId: Type.String() }),
      timeoutMs: 10_000,
      outputBytes: 48_000,
      execute: async (input, signal) => {
        if (mock) return { submissions: [], feedback: [] };
        const moduleId = requireString(input, 'moduleId');
        return domainGet(
          studentApiUrl(`/my/track-modules/${encodeURIComponent(moduleId)}/submissions`, env),
          run,
          { env, signal },
        );
      },
    },
  ];

  const learningContext = run.input.learningContext;
  const teacherTrial = learningContext?.schemaVersion === 'reach-deck-teacher-trial-context/v1';
  const learningFence =
    run.domainScope.tutorDomain === 'learning_fence' ||
    learningContext?.schemaVersion === 'reach-deck-learning-fence-context/v1' ||
    (teacherTrial && learningContext.learningFence !== undefined);
  if (!learningFence && run.domainScope.attemptId !== undefined) {
    definitions.push({
      name: 'learning_fence.read_history',
      label: '读取既往围栏对话',
      description:
        'Read completed learning-fence dialogues from this same learner, organization, attempt, and module scope. The scope is fixed by the current Run and takes no model-controlled identity.',
      parameters: Type.Object({}, { additionalProperties: false }),
      timeoutMs: 5_000,
      outputBytes: 48_000,
      execute: async (_input, signal) => readLearningFenceHistory(run, store, signal),
    });
  }
  if (!teacherTrial && learningContext?.schemaVersion === 'reach-deck-learning-fence-context/v1') {
    definitions.push({
      name: 'learning_fence.mark_mastered',
      label: '确认已掌握',
      description:
        'Mark the current verified learning fence mastered only after the learner independently satisfies the runtime mastery policy.',
      parameters: Type.Object({}, { additionalProperties: false }),
      timeoutMs: 10_000,
      outputBytes: 16_000,
      execute: async (_input, signal) =>
        domainPost(
          studentApiUrl(
            `/my/attempts/${encodeURIComponent(learningContext.attemptId)}/learning-fences/${encodeURIComponent(learningContext.fenceId)}/mastery`,
            env,
          ),
          run,
          { runId: run.id },
          { env, signal },
        ),
    });
  }
  if (teacherTrial && learningContext.learningFence !== undefined) {
    const trialFence = learningContext.learningFence;
    definitions.push({
      name: 'learning_fence.release_trial',
      label: '放行试学围栏',
      description:
        'Release this temporary Teacher Trial learning fence after the trial learner demonstrates mastery. This records only a runtime event and never writes Student mastery.',
      parameters: Type.Object({}, { additionalProperties: false }),
      timeoutMs: 2_000,
      outputBytes: 8_000,
      execute: async () => {
        const identity = {
          attemptId: learningContext.attemptId,
          pageId: learningContext.pageId,
          questionId: trialFence.questionId,
          sceneId: trialFence.sceneId,
        };
        const result = await store.appendEventIfAbsent(
          run.id,
          'learning_fence.trial_released',
          identity,
          { schemaVersion: 'learning-fence-trial-release/v1', ...identity },
        );
        return {
          released: true,
          alreadyReleased: !result.appended,
          eventId: result.event.id,
        };
      },
    });
  }

  const scopedDefinitions = teacherTrial
    ? definitions.filter(({ name }) =>
        [
          'classroom.get_current_context',
          'learning_fence.read_history',
          'learning_fence.release_trial',
        ].includes(name),
      )
    : definitions;
  const tools = scopedDefinitions.map(
    (definition): AgentTool => ({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_toolCallId, input, signal) =>
        executeAuditedTool(definition, run, store, input as Record<string, unknown>, signal),
    }),
  );
  // 视频 attempt 的 Run 额外启用视频工具（字幕窗口 + 有预算的片段理解）。
  return isVideoTutorRun(run)
    ? [...tools, ...createVideoTutorTools(run, store, env, videoDeps)]
    : tools;
}

async function readLearningFenceHistory(
  run: RunRecord,
  store: RuntimeStore,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 'learning-fence-history/v1',
    dialogues: await store.listTutorLearningFenceHistory({
      actor: run.actor,
      domainScope: run.domainScope,
      limit: 40,
      signal,
      timeoutMs: 4_500,
    }),
  };
}

/**
 * 按 learningContext.schemaVersion 分派的服务端上下文再解析入口：
 * reach-deck 走既有 resolveTutorCurrentContext（行为不变），视频走 resolveVideoTutorContext。
 */
export async function resolveTutorRunContext(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  await assertStudentTutorFenceBoundary(run, env, signal, fetchImpl);
  if (isVideoTutorRun(run)) return resolveVideoTutorContext(run, env, signal, fetchImpl);
  if (run.input.learningContext?.schemaVersion === 'reach-deck-teacher-trial-context/v1') {
    return resolveTeacherTrialTutorContext(run, env, signal, fetchImpl);
  }
  if (run.input.learningContext?.schemaVersion === 'reach-deck-learning-fence-context/v1') {
    return resolveLearningFenceTutorContext(run, env, signal, fetchImpl);
  }
  return resolveTutorCurrentContext(run, env, signal, fetchImpl);
}

/**
 * Re-checks the authoritative active fence immediately before persistence and again at worker
 * execution time. Browser-provided context can select a claimed fence but cannot establish that
 * the fence is active or that an ordinary Tutor turn is currently allowed.
 */
export async function assertStudentTutorFenceBoundary(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const learningContext = run.input.learningContext;
  if (
    !run.actor.roles.includes('student') ||
    (learningContext?.schemaVersion !== 'reach-deck-tutor-context/v1' &&
      learningContext?.schemaVersion !== 'reach-deck-learning-fence-context/v1')
  ) {
    return;
  }
  const attemptId = run.domainScope.attemptId;
  if (!attemptId || attemptId !== learningContext.attemptId) {
    throw contextMismatch('Tutor fence admission requires the exact attempt scope');
  }
  const value = await domainServiceGet(
    studentApiUrl(`/my/attempts/${encodeURIComponent(attemptId)}/learning-fence`, env),
    run,
    { env, signal, ...(fetchImpl ? { fetchImpl } : {}) },
  );
  const response = contextRecord(value, 'active learning fence response');
  const activeFence = response.fence;
  if (learningContext.schemaVersion === 'reach-deck-tutor-context/v1') {
    if (activeFence !== null && activeFence !== undefined) {
      throw contextMismatch('Ordinary Tutor is blocked while a learning fence is active');
    }
    return;
  }
  if (activeFence === null || activeFence === undefined) {
    throw contextMismatch('Learning-fence Tutor requires an active learning fence');
  }
  const fence = contextRecord(activeFence, 'active learning fence');
  requireContextIdentity(fence, 'status', 'active', 'Learning fence admission');
  for (const [key, expected] of Object.entries({
    attemptId: learningContext.attemptId,
    fenceId: learningContext.fenceId,
    pageId: learningContext.pageId,
    questionId: learningContext.questionId,
    sceneId: learningContext.sceneId,
  })) {
    requireContextIdentity(fence, key, expected, 'Learning fence admission');
  }
}

export async function resolveLearningFenceTutorContext(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const learningContext = run.input.learningContext;
  if (learningContext?.schemaVersion !== 'reach-deck-learning-fence-context/v1') {
    throw contextMismatch('Tutor Run does not carry a learning fence context');
  }
  const attemptId = run.domainScope.attemptId;
  if (!attemptId || attemptId !== learningContext.attemptId) {
    throw contextMismatch('Learning fence attempt does not match the Tutor Thread');
  }
  const value = await domainServiceGet(
    studentApiUrl(
      `/my/attempts/${encodeURIComponent(attemptId)}/learning-fences/${encodeURIComponent(learningContext.fenceId)}/context`,
      env,
    ),
    run,
    { env, signal, ...(fetchImpl ? { fetchImpl } : {}) },
  );
  const context = contextRecord(value, 'learning fence context');
  const fence = contextRecord(context.fence, 'learning fence');
  requireContextIdentity(fence, 'fenceId', learningContext.fenceId);
  requireContextIdentity(fence, 'attemptId', learningContext.attemptId);
  requireContextIdentity(fence, 'pageId', learningContext.pageId);
  requireContextIdentity(fence, 'sceneId', learningContext.sceneId);
  requireContextIdentity(fence, 'questionId', learningContext.questionId);
  requireContextIdentity(fence, 'status', 'active');
  if (
    typeof context.teacherPrompt !== 'string' ||
    context.teacherPrompt.trim().length === 0 ||
    context.teacherPrompt.length > 4_000
  ) {
    throw contextMismatch('Learning fence teacher prompt is invalid');
  }
  const question = contextRecord(context.question, 'learning fence question');
  requireContextIdentity(question, 'id', learningContext.questionId);
  return {
    ...run.domainScope,
    assessmentMode: 'learning_fence',
    fence,
    currentQuestion: question,
    teacherMasteryPrompt: context.teacherPrompt,
    masteryPolicy: {
      evidenceRequired:
        'The learner must independently explain the key concept, justify the correct reasoning, and correct the earlier misconception. Ask follow-up questions when evidence is incomplete.',
      toolRequired: 'learning_fence.mark_mastered',
      toolUseRule: 'Call only when the evidence is sufficient in this dialogue.',
    },
    contextTrust: {
      fence: 'server-validated-active-fence',
      currentQuestion: 'server-validated-immutable-content',
      teacherMasteryPrompt: 'server-validated-immutable-teacher-criteria',
    },
  };
}

/**
 * Re-resolves the immutable learner page and current attempt through student-service.
 * Browser activity remains explicitly marked as learner-provided and cannot establish identity.
 */
export async function resolveTutorCurrentContext(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const learningContext = run.input.learningContext;
  if (!learningContext) {
    throw contextMismatch('Tutor Run requires a learning context');
  }
  if (learningContext.schemaVersion !== 'reach-deck-tutor-context/v1') {
    // 类型窄化守卫：视频 Run 由 resolveTutorRunContext 分派到视频解析，不应到达此处。
    throw contextMismatch('Tutor Run does not carry a Reach Deck learning context');
  }
  const selectionId = run.domainScope.selectionId;
  const moduleVersionId = run.domainScope.moduleVersionId;
  const attemptId = run.domainScope.attemptId;
  if (!selectionId || !moduleVersionId || !attemptId) {
    throw contextMismatch('Tutor Run is missing selection, module version, or attempt scope');
  }

  const requestOptions = { env, signal, ...(fetchImpl ? { fetchImpl } : {}) };
  // Read-only content: the learner-facing endpoint opens the attempt under selection/attempt row
  // locks and deadlocks with the learner's own event writes when a thread is created on page open.
  const [contentValue, attemptValue] = await Promise.all([
    domainGet(
      studentApiUrl(
        `/my/track-modules/${encodeURIComponent(selectionId)}/reach-deck-content/read-only`,
        env,
      ),
      run,
      requestOptions,
    ),
    domainGet(
      studentApiUrl(`/my/track-modules/${encodeURIComponent(selectionId)}/attempts/current`, env),
      run,
      requestOptions,
    ),
  ]);
  const content = contextRecord(contentValue, 'Reach Deck learner content');
  const current = contextRecord(attemptValue, 'Reach Deck current attempt');
  requireContextIdentity(content, 'selectionId', selectionId);
  requireContextIdentity(content, 'moduleVersionId', moduleVersionId);
  requireContextIdentity(current, 'selectionId', selectionId);
  requireContextIdentity(current, 'moduleVersionId', moduleVersionId);
  const attempt = contextRecord(current.attempt, 'Reach Deck current attempt record');
  requireContextIdentity(attempt, 'attemptId', attemptId);
  requireContextIdentity(attempt, 'selectionId', selectionId);
  requireContextIdentity(attempt, 'moduleVersionId', moduleVersionId);

  const document = contextRecord(content.content, 'Reach Deck learner document');
  const { currentPage, currentSlide } = resolveAuthorizedTutorPage(document, learningContext);
  const currentPageMedia = tutorPageMedia(document, currentSlide);

  const resolved = {
    selectionId,
    moduleVersionId,
    attempt: {
      attemptId,
      status: attempt.status,
      progress: attempt.progress,
      score: attempt.score,
      lastActivityAt: attempt.lastActivityAt,
    },
    pageId: learningContext.pageId,
    currentPage,
    ...(currentSlide ? { currentSlide } : {}),
    ...(currentPageMedia.length > 0 ? { currentPageMedia } : {}),
    learnerActivity: {
      observedAt: learningContext.observedAt,
      ...learningContext.activity,
    },
    assessmentMode: 'none',
    contextTrust: {
      currentPage: 'server-validated-immutable-content',
      attempt: 'server-validated-current-attempt',
      learnerActivity: 'learner-provided-bounded-state',
    },
  };
  return resolved;
}

function resolveAuthorizedTutorPage(
  document: Record<string, unknown>,
  learningContext: ReachDeckTutorLearningContext | ReachDeckTeacherTrialLearningContext,
): {
  currentPage: Record<string, unknown>;
  currentSlide?: Record<string, unknown>;
} {
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw contextMismatch('Reach Deck Tutor context must use native-v2');
  }
  if (!Array.isArray(document.pages)) {
    throw contextMismatch('Reach Deck learner document has no pages');
  }
  const page = document.pages.find((candidate) => {
    const record = optionalRecord(candidate);
    return record?.pageId === learningContext.pageId;
  });
  const currentPage = contextRecord(page, 'Reach Deck current page');
  requireContextIdentity(currentPage, 'pageId', learningContext.pageId);
  requireContextIdentity(currentPage, 'sceneType', learningContext.activity.sceneType);
  if (currentPage.revision !== learningContext.activity.sourceRevision) {
    throw contextMismatch('Reach Deck activity revision does not match the authoritative page');
  }
  if (currentPage.sceneType !== 'slide') {
    const scene = contextRecord(currentPage.scene, 'Reach Deck current scene');
    requireContextIdentity(scene, 'id', learningContext.activity.sceneId);
    return { currentPage };
  }
  if (Object.hasOwn(currentPage, 'scene')) {
    throw contextMismatch('Reach Deck native-v2 slide page must not contain a legacy scene');
  }
  requireContextIdentity(currentPage, 'pageId', learningContext.activity.sceneId);
  if (!Array.isArray(document.nativeSlides)) {
    throw contextMismatch('Reach Deck native-v2 document has no native slide bindings');
  }
  const bindings = document.nativeSlides.filter((candidate) => {
    const record = optionalRecord(candidate);
    return record?.pageId === learningContext.pageId;
  });
  if (bindings.length !== 1) {
    throw contextMismatch('Reach Deck current page must have exactly one native slide binding');
  }
  const binding = contextRecord(bindings[0], 'Reach Deck current native slide binding');
  requireContextIdentity(binding, 'pageId', learningContext.pageId);
  return {
    currentPage,
    currentSlide: contextRecord(binding.slide, 'Reach Deck current native slide'),
  };
}

export async function resolveTeacherTrialTutorContext(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const learningContext = run.input.learningContext;
  if (learningContext?.schemaVersion !== 'reach-deck-teacher-trial-context/v1') {
    throw contextMismatch('Tutor Run does not carry a Teacher Trial context');
  }
  if (!run.actor.roles.includes('teacher') || !run.actor.roleGrantId) {
    throw contextMismatch('Teacher Trial Tutor requires an active teacher role grant');
  }
  const { organizationId, courseId, courseNodeId, moduleId, moduleVersionId, attemptId } =
    run.domainScope;
  if (
    !organizationId ||
    !courseId ||
    !courseNodeId ||
    !moduleId ||
    !moduleVersionId ||
    !attemptId
  ) {
    throw contextMismatch('Teacher Trial Tutor Run is missing its authorized scope');
  }
  if (organizationId !== run.actor.orgId || attemptId !== learningContext.attemptId) {
    throw contextMismatch('Teacher Trial Tutor actor or attempt scope does not match');
  }

  const value = await domainServiceGet(
    contentApiUrl(
      `/reach-deck/courses/${encodeURIComponent(courseId)}/nodes/${encodeURIComponent(courseNodeId)}/teacher-trial-tutor-context`,
      env,
    ),
    run,
    { env, signal, ...(fetchImpl ? { fetchImpl } : {}) },
  );
  const context = contextRecord(value, 'Teacher Trial Tutor context');
  for (const [key, expected] of Object.entries({
    organizationId,
    courseId,
    courseNodeId,
    moduleId,
    moduleVersionId,
  })) {
    requireContextIdentity(context, key, expected, 'Teacher Trial');
  }
  requireContextIdentity(context, 'courseWorkspaceType', 'draft', 'Teacher Trial');
  const document = contextRecord(context.learnerDocument, 'Teacher Trial learner document');
  const { currentPage, currentSlide } = resolveAuthorizedTutorPage(document, learningContext);
  const trialFence = learningContext.learningFence;
  let fenceContext: Record<string, unknown> = {};
  if (trialFence !== undefined) {
    if (currentPage.sceneType !== 'quiz') {
      throw contextMismatch('Teacher Trial learning fence requires a quiz page');
    }
    const scene = contextRecord(currentPage.scene, 'Teacher Trial quiz scene');
    requireContextIdentity(scene, 'id', trialFence.sceneId, 'Teacher Trial learning fence');
    const content = contextRecord(scene.content, 'Teacher Trial quiz content');
    const questions = content.questions;
    if (!Array.isArray(questions)) {
      throw contextMismatch('Teacher Trial quiz page has no questions');
    }
    const question = questions
      .map((candidate) => optionalRecord(candidate))
      .find((candidate) => candidate?.id === trialFence.questionId);
    if (question === undefined) {
      throw contextMismatch('Teacher Trial learning fence question is not in the draft');
    }
    const fence = optionalRecord(question.learning_fence);
    if (fence?.enabled !== true || typeof fence.prompt !== 'string' || fence.prompt.trim() === '') {
      throw contextMismatch('Teacher Trial learning fence configuration is no longer valid');
    }
    fenceContext = {
      assessmentMode: 'learning_fence',
      currentQuestion: question,
      teacherMasteryPrompt: fence.prompt,
      masteryPolicy: {
        evidenceRequired:
          'The learner must independently explain the key concept, justify the correct reasoning, and correct the earlier misconception. Ask follow-up questions when evidence is incomplete.',
        toolRequired: 'learning_fence.release_trial',
        toolUseRule:
          'Call only when the evidence is sufficient. This is a temporary Teacher Trial fence; never claim persistent Student mastery.',
      },
    };
  }
  const resolved = {
    organizationId,
    courseId,
    courseNodeId,
    moduleId,
    moduleVersionId,
    attemptId,
    draftRevision: context.draftRevision,
    contentDigest: context.contentDigest,
    ...(context.courseAgentRoster === undefined
      ? {}
      : { courseAgentRoster: context.courseAgentRoster }),
    pageId: learningContext.pageId,
    currentPage,
    ...(currentSlide ? { currentSlide } : {}),
    teacherActivity: {
      observedAt: learningContext.observedAt,
      ...learningContext.activity,
    },
    ...fenceContext,
    ...(fenceContext.assessmentMode === undefined ? { assessmentMode: 'none' } : {}),
    contextTrust: {
      domainScope: 'runtime-validated-teacher-trial',
      currentPage: 'server-validated-current-draft',
      teacherActivity: 'teacher-provided-bounded-state',
      ...(trialFence ? { learningFence: 'server-validated-current-draft-question' } : {}),
    },
  };
  return resolved;
}

function findOutlineMatches(
  value: unknown,
  keyword: string,
  courseKey?: string,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (courseKey && typeof record.courseKey === 'string' && record.courseKey !== courseKey) {
      return;
    }
    const title = typeof record.title === 'string' ? record.title : '';
    const selectionId = typeof record.selectionId === 'string' ? record.selectionId : undefined;
    const moduleId = typeof record.moduleId === 'string' ? record.moduleId : undefined;
    if ((selectionId || moduleId) && title.toLowerCase().includes(keyword)) {
      matches.push({
        ...(selectionId ? { selectionId } : {}),
        ...(moduleId ? { moduleId } : {}),
        title,
      });
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(value);
  return matches;
}
