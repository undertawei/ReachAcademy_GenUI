import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHs256Token, verifyHs256Token } from '@reachany/auth';
import { reachDeckNarrationSpeechContentDigestInput } from '@reachany/reach-deck-dsl';
import {
  authorizeCourseAgentPreviewRoute,
  authorizeCourseAgentPreviewSelection,
  createSpeechPreviewModelToken,
} from '../../lib/reach-deck/speech-preview-context.js';

const scope = {
  kind: 'course-agent' as const,
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  configurationId: '33333333-3333-4333-8333-333333333333',
};
const scoped = {
  actorId: '44444444-4444-4444-8444-444444444444',
  actorOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  roleGrantId: '55555555-5555-4555-8555-555555555555',
  billingGroupId: null,
  resourceScope: scope,
};
const secret = 'course-preview-test-secret-at-least-32-bytes';
const env = {
  NODE_ENV: 'test',
  REACHANY_SERVICE_JWT_SECRET: secret,
  REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
  REACHANY_SERVICE_JWT_ISSUER: 'course-preview-test',
};

describe('course agent speech preview authorization', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  async function request(extra = {}) {
    const token = await createHs256Token({
      secret,
      subject: scoped.actorId,
      actorId: scoped.actorId,
      orgId: scoped.actorOrganizationId,
      audience: 'reachany-services',
      issuer: env.REACHANY_SERVICE_JWT_ISSUER,
      roles: ['teacher'],
      extraClaims: {
        preview_scope: 'course-agent',
        organization_id: scope.organizationId,
        course_id: scope.courseId,
        course_workspace_type: 'draft',
        configuration_id: scope.configurationId,
        role_grant_id: scoped.roleGrantId,
        billing_group_id: null,
        ...extra,
      },
    });
    return new Request('http://runtime/api/course-agents/speech-preview', {
      headers: { authorization: `Bearer ${token}` },
    });
  }
  it('binds course/configuration and grant without any module identity', async () => {
    await expect(authorizeCourseAgentPreviewRoute(await request(), scope)).resolves.toEqual(scoped);
    await expect(
      authorizeCourseAgentPreviewRoute(await request(), {
        ...scope,
        configurationId: scoped.actorId,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorizeCourseAgentPreviewRoute(await request({ preview_scope: 'deck' }), scope),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('mints a course-only TTS identity using the resource organization for cross-organization managers', async () => {
    const token = await createSpeechPreviewModelToken(env, {
      ...scoped,
      jobId: 'preview-job',
      runId: 'preview-run',
    });
    const claims = await verifyHs256Token(token, { secret, audience: 'reachany-services' });
    expect(claims.orgId).toBe(scope.organizationId);
    expect(claims.extra).toMatchObject({
      preview_scope: 'course-agent',
      configuration_id: scope.configurationId,
      course_id: scope.courseId,
      role_grant_id: scoped.roleGrantId,
      scene_id: 'teacher.deck',
    });
    expect(claims.extra).not.toHaveProperty('module_id');
    expect(claims.extra).not.toHaveProperty('module_version_id');
    expect(claims.extra).not.toHaveProperty('course_node_id');
  });
  it('does not manufacture a clone grant and fences changed synthesis revision', async () => {
    const cloneId = '66666666-6666-4666-8666-666666666666';
    let revision = 3;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        organizationId: scope.organizationId,
        courseId: scope.courseId,
        configurationId: scope.configurationId,
        languageCode: 'en-US',
        voice: { kind: 'clone', cloneId },
      });
      return Response.json({
        ...scope,
        actorAccountId: scoped.actorId,
        roleGrantId: scoped.roleGrantId,
        lockVersion: 0,
        languageCode: 'en-US',
        voiceSelection: {
          kind: 'clone',
          cloneId,
          synthesisRevision: revision,
          ownerAccountId: scoped.actorId,
          courseId: scope.courseId,
          agentRole: 'teacher',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const selection = { languageCode: 'en-US', voice: { kind: 'clone' as const, cloneId } };
    const first = await authorizeCourseAgentPreviewSelection(scoped, selection);
    expect(first.voiceSelection).not.toHaveProperty('grantId');
    revision++;
    await expect(
      authorizeCourseAgentPreviewSelection(scoped, selection, first.voiceSelection),
    ).rejects.toMatchObject({ status: 409 });
  });
});

const deps = vi.hoisted(() => ({ submit: vi.fn(), synthesize: vi.fn() }));
vi.mock('../../lib/reach-deck/model-service-tools.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/model-service-tools.js')>()),
  synthesizeReachDeckSpeech: deps.synthesize,
}));
vi.mock('../../lib/reach-deck/speech-preview-jobs.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/speech-preview-jobs.js')>()),
  submitReachDeckSpeechPreviewTask: deps.submit,
}));
vi.mock('../../lib/reach-deck/speech-tool-admission.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/speech-tool-admission.js')>()),
  acquireReachDeckSpeechToolAdmission: vi.fn(),
}));
import { submitCourseAgentSpeechPreview } from '../../lib/reach-deck/course-agent-speech-preview.js';
import { executeReachDeckSpeechPreviewAttempt } from '../../lib/reach-deck/speech-markup-tools.js';

describe('course preview preparation', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    deps.submit.mockReset().mockResolvedValue({ status: 'queued' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...scope,
          actorAccountId: scoped.actorId,
          roleGrantId: scoped.roleGrantId,
          lockVersion: 0,
          languageCode: 'en-US',
          voiceSelection: { kind: 'default', voice: 'en_female_test' },
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function submit(markdown: string, extra = {}) {
    const token = await createHs256Token({
      secret,
      subject: scoped.actorId,
      actorId: scoped.actorId,
      orgId: scoped.actorOrganizationId,
      audience: 'reachany-services',
      issuer: env.REACHANY_SERVICE_JWT_ISSUER,
      roles: ['teacher'],
      extraClaims: {
        preview_scope: 'course-agent',
        organization_id: scope.organizationId,
        course_id: scope.courseId,
        course_workspace_type: 'draft',
        configuration_id: scope.configurationId,
        role_grant_id: scoped.roleGrantId,
        billing_group_id: null,
      },
    });
    return submitCourseAgentSpeechPreview(
      new Request('http://runtime/api/course-agents/speech-preview', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': 'preview-1',
        },
        body: JSON.stringify({
          courseId: scope.courseId,
          configurationId: scope.configurationId,
          languageCode: 'en-US',
          voice: { kind: 'official', voiceId: 'en_female_test' },
          markdown,
          selection: { from: 0, to: markdown.length - 1 },
          narrationDigest: createHash('sha256')
            .update(reachDeckNarrationSpeechContentDigestInput(markdown))
            .digest('hex'),
          requestIdentity: 'preview-1',
          ...extra,
        }),
      }),
    );
  }
  it('submits an unsaved English voice and partial text as plain speech at initial version zero', async () => {
    expect((await submit('Hello world.')).status).toBe(202);
    expect(deps.submit.mock.calls[0][0].prepared).toMatchObject({
      input: { pageId: scope.configurationId, pageRevision: 0 },
      inputType: 'plain',
      synthesisInput: 'Hello world',
      reusableFullPreview: false,
      courseAgentSelection: { expectedLockVersion: 0 },
    });
    expect(deps.submit.mock.calls[0][0].scoped.resourceScope).not.toHaveProperty('moduleId');
  });
  it('rejects formula input and forged voice capability fields before task registration', async () => {
    expect((await submit('Read \\(x\\) now.')).status).toBe(400);
    expect(
      (
        await submit('Hello world.', {
          voice: { kind: 'official', voiceId: 'en_female_test', capability: 'forged' },
        })
      ).status,
    ).toBe(400);
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('reauthorizes an unsaved clone and exchanges a fresh capability only at execution', async () => {
    const cloneId = '66666666-6666-4666-8666-666666666666';
    const voiceSelection = {
      kind: 'clone' as const,
      cloneId,
      synthesisRevision: 3,
      ownerAccountId: scoped.actorId,
      courseId: scope.courseId,
      agentRole: 'teacher' as const,
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        const body = JSON.parse(init.body);
        expect(body.voiceSelection).toEqual(voiceSelection);
        expect(body.voiceSelection).not.toHaveProperty('grantId');
        return path.endsWith('/capability')
          ? Response.json({ capability: 'execution-only-capability' })
          : Response.json({
              ...scope,
              actorAccountId: scoped.actorId,
              roleGrantId: scoped.roleGrantId,
              lockVersion: 0,
              languageCode: 'en-US',
              voiceSelection,
            });
      }),
    );
    deps.synthesize.mockResolvedValueOnce({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    const publish = vi.fn();
    const preview = await executeReachDeckSpeechPreviewAttempt(
      {
        input: {
          pageId: scope.configurationId,
          markdown: 'Hello.',
          selection: { from: 0, to: 6 },
          pageRevision: 0,
          narrationDigest: 'a'.repeat(64),
          requestIdentity: 'preview-clone',
        },
        voiceSelection,
        courseAgentSelection: {
          languageCode: 'en-US',
          voice: { kind: 'clone', cloneId },
          expectedLockVersion: 0,
        },
        synthesisInput: 'Hello.',
        alignmentTranscript: 'Hello.',
        inputType: 'plain',
        reusableFullPreview: true,
      },
      {
        scoped,
        modelContext: { ...scoped, jobId: 'preview-job', runId: 'preview-run' },
        signal: new AbortController().signal,
        assertCanPublish: publish,
      },
    );
    expect(calls.map((path) => path.split('/').at(-1))).toEqual(['authorize', 'capability']);
    expect(deps.synthesize.mock.calls[0][1]).toMatchObject({
      voiceCloneCapability: 'execution-only-capability',
    });
    expect(deps.synthesize.mock.calls[0][1]).not.toHaveProperty('withTimestamps');
    expect(preview.audioBase64).toBe('AQID');
    expect(JSON.stringify(preview)).not.toContain('capability');
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
