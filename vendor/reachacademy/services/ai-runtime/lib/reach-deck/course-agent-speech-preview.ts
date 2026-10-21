import { reachDeckNarrationFormulaRanges } from '@reachany/reach-deck-dsl';
import {
  authorizeCourseAgentPreviewRoute,
  authorizeCourseAgentPreviewSelection,
  type CourseAgentPreviewVoice,
} from './speech-preview-context.js';
import {
  parseReachDeckSpeechPreviewRequest,
  planSpeechPreviewSynthesis,
  ReachDeckSpeechToolRequestError,
  readReachDeckSpeechToolBody,
  reachDeckSpeechToolErrorResponse,
} from './speech-markup-tools.js';
import {
  acquireReachDeckSpeechToolAdmission,
  ReachDeckSpeechToolAdmissionError,
} from './speech-tool-admission.js';
import {
  submitReachDeckSpeechPreviewTask,
  readReachDeckSpeechPreviewTask,
  cancelReachDeckSpeechPreviewTask,
  parseReachDeckSpeechPreviewTaskId,
  ReachDeckSpeechPreviewCancellationError,
  ReachDeckSpeechPreviewTaskConflictError,
} from './speech-preview-jobs.js';
import { workspaceRouteError } from './workspace-route.js';
import { reachDeckVoiceSupportsSpeechMarkup } from './voice-selection.js';

function previewVoice(value: unknown): CourseAgentPreviewVoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ReachDeckSpeechToolRequestError('Course preview voice is invalid');
  const voice = value as Record<string, unknown>;
  if (
    voice.kind === 'official' &&
    Object.keys(voice).length === 2 &&
    typeof voice.voiceId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(voice.voiceId)
  )
    return { kind: 'official', voiceId: voice.voiceId };
  if (
    voice.kind === 'clone' &&
    Object.keys(voice).length === 2 &&
    typeof voice.cloneId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(voice.cloneId)
  )
    return { kind: 'clone', cloneId: voice.cloneId.toLowerCase() };
  throw new ReachDeckSpeechToolRequestError('Course preview voice is invalid');
}
export async function submitCourseAgentSpeechPreview(request: Request): Promise<Response> {
  try {
    const body = await readReachDeckSpeechToolBody(
      request,
      [
        'courseId',
        'configurationId',
        'languageCode',
        'voice',
        'markdown',
        'selection',
        'narrationDigest',
        'requestIdentity',
      ],
      ['speechMarkup'],
    );
    const scoped = await authorizeCourseAgentPreviewRoute(request, {
      courseId: body.courseId,
      configurationId: body.configurationId,
    });
    if (
      typeof body.languageCode !== 'string' ||
      body.languageCode.length > 35 ||
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(body.languageCode)
    )
      throw new ReachDeckSpeechToolRequestError('Course preview language is invalid');
    const selection = { languageCode: body.languageCode, voice: previewVoice(body.voice) };
    const authorized = await authorizeCourseAgentPreviewSelection(
      scoped,
      selection,
      undefined,
      request.signal,
    );
    const input = parseReachDeckSpeechPreviewRequest(
      {
        ...body,
        pageId: scoped.resourceScope.configurationId,
        pageRevision: authorized.lockVersion,
      },
      { allowInitialRevision: true },
    );
    if (input.requestIdentity !== request.headers.get('idempotency-key')?.trim())
      throw new ReachDeckSpeechToolRequestError('requestIdentity must match Idempotency-Key');
    if (reachDeckNarrationFormulaRanges(input.markdown).length > 0)
      throw new ReachDeckSpeechToolRequestError(
        'Course voice preview supports spoken text without formulas',
      );
    const supportsMarks =
      selection.languageCode === 'zh-CN' &&
      (selection.voice.kind === 'clone' || selection.voice.voiceId.endsWith('_uranus_bigtts'));
    if (
      !reachDeckVoiceSupportsSpeechMarkup(authorized.voiceSelection.kind, input.speechMarkup) ||
      (!supportsMarks && input.speechMarkup !== undefined)
    )
      throw new ReachDeckSpeechToolRequestError(
        'Selected voice does not support these speech marks',
      );
    const planned = planSpeechPreviewSynthesis(input, []);
    // A plain selection should not require Chinese SSML support just because it is a substring.
    if (input.speechMarkup === undefined) {
      planned.inputType = 'plain';
      planned.synthesisInput = planned.alignmentTranscript;
    }
    const task = await submitReachDeckSpeechPreviewTask({
      scoped,
      modelContext: {
        actorId: scoped.actorId,
        actorOrganizationId: scoped.actorOrganizationId,
        roleGrantId: scoped.roleGrantId,
        billingGroupId: scoped.billingGroupId,
        resourceScope: scoped.resourceScope,
        jobId: `course-agent-preview-${input.requestIdentity}`,
        runId: `course-agent-preview-${input.requestIdentity}`,
      },
      prepared: {
        input,
        voiceSelection: authorized.voiceSelection,
        courseAgentSelection: { ...selection, expectedLockVersion: authorized.lockVersion },
        ...planned,
        reusableFullPreview: false,
      },
      acquireAdmission: async () =>
        (
          await acquireReachDeckSpeechToolAdmission({
            operation: 'preview',
            actorId: scoped.actorId,
            pageId: input.pageId,
            resourceScope: scoped.resourceScope,
          })
        ).descriptor,
    });
    return Response.json(task, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return courseAgentSpeechPreviewError(error);
  }
}
export async function courseAgentSpeechPreviewTask(
  request: Request,
  taskId: string,
): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const scoped = await authorizeCourseAgentPreviewRoute(request, {
      courseId: params.get('courseId'),
      configurationId: params.get('configurationId'),
    });
    const id = parseReachDeckSpeechPreviewTaskId(taskId);
    const task =
      request.method === 'DELETE'
        ? await cancelReachDeckSpeechPreviewTask(scoped, id)
        : await readReachDeckSpeechPreviewTask(scoped, id);
    if (task === null)
      return request.method === 'DELETE'
        ? Response.json(
            {
              schemaVersion: 'reach-deck-speech-preview-task/v1',
              taskId: id,
              requestIdentity: id,
              status: 'cancelled',
              pollAfterMillis: 0,
            },
            { status: 202, headers: { 'Cache-Control': 'no-store' } },
          )
        : Response.json({ error: 'Speech preview task not found' }, { status: 404 });
    return Response.json(task, {
      status: request.method === 'DELETE' && task.status === 'draining' ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return courseAgentSpeechPreviewError(error);
  }
}
export function courseAgentSpeechPreviewError(error: unknown): Response {
  if (
    error instanceof ReachDeckSpeechToolAdmissionError ||
    error instanceof ReachDeckSpeechPreviewCancellationError
  )
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (error instanceof ReachDeckSpeechPreviewTaskConflictError)
    return Response.json(
      { error: error.message, code: 'SPEECH_TOOL_INVALID_REQUEST' },
      { status: 409 },
    );
  return reachDeckSpeechToolErrorResponse(error) ?? workspaceRouteError(error);
}
