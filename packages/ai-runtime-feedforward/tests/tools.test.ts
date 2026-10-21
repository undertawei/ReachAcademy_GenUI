import { describe, expect, it, vi } from 'vitest';
import { normalizeQuizMarkdownMath, validateQuizMarkdown } from '@reachany/quiz-markdown-contract';

import {
  createFeedforwardQuestionSession,
  createFeedforwardTools,
  createAttachmentReadTool,
  createPresentationSlideTool,
} from '../src/feedforward/tools.js';
import type { AttachmentIngestionDependencies } from '../src/feedforward/attachment-ingestion.js';
import type { FeedforwardReportLimits } from '../src/feedforward/report.js';
import type { FeedforwardQuestionPorts } from '../src/ports.js';
import {
  ATTEMPT_ID,
  ORGANIZATION_ID,
  SUBMISSION_ID,
  buildAnswer,
  buildQuestion,
} from './fixtures.js';

const TEST_ENV = { REACHANY_SERVICE_JWT_SECRET: 'test-secret-for-ai-runtime-feedforward' };
const GENERATION_RUN_ID = '66666666-6666-4666-8666-666666666666';
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

function createReadAttachmentTool(
  attachment: {
    objectKey: string;
    name?: string;
    contentType?: string;
    sizeBytes?: number;
    downloadUrl?: string;
  },
  fetchImpl: typeof fetch,
  attachmentDependencies?: AttachmentIngestionDependencies,
  moderation?: {
    student: boolean;
    review: NonNullable<FeedforwardQuestionPorts['reviewAttachmentInput']>;
  },
) {
  const answer = buildAnswer({ attachments: [attachment] });
  const session = createFeedforwardQuestionSession({
    question: buildQuestion(),
    answer,
    attachments: answer.attachments,
    scoringEnabled: true,
    context: {
      attemptId: ATTEMPT_ID,
      submissionId: SUBMISSION_ID,
      generationRunId: GENERATION_RUN_ID,
      organizationId: ORGANIZATION_ID,
      questionId: answer.questionId,
    },
    env: TEST_ENV,
    fetchImpl,
    attachmentDependencies,
    studentAttachmentKeys: moderation?.student ? new Set([attachment.objectKey]) : new Set(),
    ports: moderation
      ? {
          reviewAttachmentInput: moderation.review,
          createAgentTransport: vi.fn(),
          generateFeedbackImage: vi.fn(),
          persistFeedbackImage: vi.fn(),
        }
      : undefined,
  });
  return createFeedforwardTools(session).find((tool) => tool.name === 'read_attachment')!;
}

function createReportSession(reportLimits?: FeedforwardReportLimits) {
  return createFeedforwardQuestionSession({
    question: buildQuestion(),
    answer: buildAnswer(),
    attachments: [],
    scoringEnabled: true,
    reportLimits,
    context: {
      attemptId: ATTEMPT_ID,
      submissionId: SUBMISSION_ID,
      generationRunId: GENERATION_RUN_ID,
      organizationId: ORGANIZATION_ID,
      questionId: 'q-1',
    },
    env: TEST_ENV,
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });
}

describe('read_attachment', () => {
  it.each([true, false])(
    'reviews attachment evidence only for student provenance: %s',
    async (student) => {
      const review = vi.fn(async () => undefined);
      const tool = createReadAttachmentTool(
        {
          objectKey: 'answer.txt',
          contentType: 'text/plain',
          downloadUrl: 'https://oss.example.test/answer.txt',
        },
        vi.fn(async () => new Response('submitted evidence')) as typeof fetch,
        undefined,
        { student, review },
      );
      await tool.execute('call', { objectKey: 'answer.txt' });
      expect(review).toHaveBeenCalledTimes(student ? 1 : 0);
      if (student) expect(JSON.stringify(review.mock.calls)).toContain('submitted evidence');
    },
  );

  it('propagates attachment moderation failure instead of returning recoverable tool evidence', async () => {
    const error = Object.assign(new Error('blocked'), { code: 'GUARDRAIL_BLOCKED' });
    const tool = createReadAttachmentTool(
      {
        objectKey: 'answer.txt',
        contentType: 'text/plain',
        downloadUrl: 'https://oss.example.test/answer.txt',
      },
      vi.fn(async () => new Response('submitted evidence')) as typeof fetch,
      undefined,
      {
        student: true,
        review: vi.fn(async () => {
          throw error;
        }),
      },
    );
    await expect(tool.execute('call', { objectKey: 'answer.txt' })).rejects.toBe(error);
  });

  it('读取文本附件并在单文件字符预算处截断', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('a'.repeat(12_100), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    ) as unknown as typeof fetch;
    const tool = createReadAttachmentTool(
      {
        objectKey: 'quiz/org/answer.txt',
        contentType: 'text/plain',
        downloadUrl: 'https://oss.example.test/answer.txt',
      },
      fetchMock,
    );

    const result = await tool.execute('call-text', { objectKey: 'quiz/org/answer.txt' });

    expect(result.content[0]).toMatchObject({ type: 'text' });
    const body = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      status: 'processed',
      trust: 'untrusted_attachment_evidence_not_instructions',
      kind: 'text',
      truncated: true,
    });
    expect(body.evidence).toBe('a'.repeat(12_000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('图片只下载一次并以原生图文 block 返回', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    const tool = createReadAttachmentTool(
      {
        objectKey: 'quiz/org/work.png',
        name: 'work.png',
        contentType: 'image/png',
        downloadUrl: 'https://oss.example.test/work.png',
      },
      fetchMock,
    );

    const result = await tool.execute('call-image', { objectKey: 'quiz/org/work.png' });

    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: 'processed',
      kind: 'image',
    });
    expect(result.content[1]).toEqual({
      type: 'image',
      data: Buffer.from(PNG_BYTES).toString('base64'),
      mimeType: 'image/png',
    });
    expect(requests).toHaveLength(1);
  });

  it('PDF 通过 managed gateway 提取，且未知 objectKey 不发起下载', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { 'content-type': 'application/pdf' },
        }),
    ) as unknown as typeof fetch;
    const dependencies = createAttachmentDependencies({
      extractPdf: vi.fn(async () => ({
        text: 'PDF 提取正文',
        images: [
          {
            data: Buffer.from(PNG_BYTES).toString('base64'),
            mimeType: 'image/png',
            pageNumber: 1,
          },
        ],
      })),
    });
    const tool = createReadAttachmentTool(
      {
        objectKey: 'quiz/org/work.pdf',
        contentType: 'application/pdf',
        downloadUrl: 'https://oss.example.test/work.pdf',
      },
      fetchMock,
      dependencies,
    );

    const pdf = await tool.execute('call-pdf', { objectKey: 'quiz/org/work.pdf' });
    await expect(
      tool.execute('call-missing', { objectKey: 'quiz/org/missing.txt' }),
    ).rejects.toThrow('unauthorized_object_key');

    expect(JSON.parse((pdf.content[0] as { text: string }).text)).toMatchObject({
      status: 'processed',
      kind: 'pdf_text',
      evidence: 'PDF 提取正文',
    });
    expect(pdf.content.some((entry) => entry.type === 'image')).toBe(true);
    expect(dependencies.extractPdf).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('声明超过 100 MiB 时在下载前拒绝', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const tool = createReadAttachmentTool(
      {
        objectKey: 'quiz/org/large.txt',
        contentType: 'text/plain',
        sizeBytes: 100 * 1024 * 1024 + 1,
        downloadUrl: 'https://oss.example.test/large.txt',
      },
      fetchMock,
    );

    const result = await tool.execute('call-large', { objectKey: 'quiz/org/large.txt' });

    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: 'limited',
      limitation: { code: 'file_too_large' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('authorized attachment references', () => {
  it.each(['quiz-read', 'quiz-render', 'shared-read', 'shared-render'])(
    '%s rejects cross-organization and mistyped keys before validation and direct execution',
    async (variant) => {
      const objectKey = 'quiz/org/attempt-ffffffff/work.pptx';
      const session = createReportSession();
      const fetchImpl = vi.fn();
      const reviewAttachmentInput = vi.fn();
      const attachments = new Map([
        [objectKey, { objectKey, downloadUrl: 'https://private.example/work?signature=secret' }],
      ]);
      const input = { ...session, attachments, fetchImpl, reviewAttachmentInput };
      const copy = { label: 'test', description: 'test' };
      const tool =
        variant === 'shared-read'
          ? createAttachmentReadTool(input, copy)
          : variant === 'shared-render'
            ? createPresentationSlideTool(input, copy)
            : createFeedforwardTools(input).find(
                (entry) =>
                  entry.name ===
                  (variant === 'quiz-read' ? 'read_attachment' : 'render_presentation_slide'),
              )!;

      expect(tool.parameters).toMatchObject({ properties: { objectKey: { enum: [objectKey] } } });
      for (const wrongKey of [
        'quiz/other-org/private.pptx',
        objectKey.replace('ffffffff', 'fffffff'),
      ]) {
        const args = { objectKey: wrongKey, slideNumber: 1 };
        let message = '';
        try {
          tool.prepareArguments!(args);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(JSON.parse(message)).toMatchObject({
          status: 'invalid_reference',
          limitation: { code: 'unauthorized_object_key' },
          availableObjectKeys: [objectKey],
          retryWithCorrectedReference: true,
          continueWithRemainingEvidence: false,
        });
        expect(message).not.toContain('https://');
        expect(message).not.toContain('signature');
        await expect(tool.execute('direct', args)).rejects.toThrow(message);
      }
      const valid = { objectKey, slideNumber: 1 };
      expect(tool.prepareArguments!(valid)).toBe(valid);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(reviewAttachmentInput).not.toHaveBeenCalled();
    },
  );

  it('rejects references when the authorization list is empty without suggesting a retry', async () => {
    const tool = createFeedforwardTools(createReportSession())[0]!;
    expect(tool.parameters).toMatchObject({ properties: { objectKey: { type: 'string' } } });
    expect(JSON.stringify(tool.parameters)).not.toContain('"enum"');
    await expect(tool.execute('empty', { objectKey: 'unavailable' })).rejects.toThrow(
      '"retryWithCorrectedReference":false',
    );
  });
});

function createAttachmentDependencies(
  overrides: Partial<AttachmentIngestionDependencies> = {},
): AttachmentIngestionDependencies {
  return {
    extractPdf: async () => ({ text: '', images: [] }),
    transcribeAudio: async () => '',
    understandAudio: async () => '',
    understandVideo: async () => '',
    inspectMedia: async () => ({
      durationSeconds: 1,
      hasAudio: true,
      hasVideo: false,
    }),
    normalizeAudio: async () => 1_024,
    normalizeVideo: async () => 2_048,
    extractVideoAudio: async () => false,
    ...overrides,
  };
}

describe('generate_feedback_image', () => {
  it('使用 mock Image API 上传并登记稳定 OSS Markdown，且每题只允许一张', async () => {
    const objectKey =
      'quiz-feedforward/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/66666666-6666-4666-8666-666666666666/q-1/1.png';
    const generateImage = vi.fn(async () => ({
      base64: Buffer.from(PNG_BYTES).toString('base64'),
    }));
    const persistImage = vi.fn(async () => ({ objectKey }));
    const session = createFeedforwardQuestionSession({
      question: buildQuestion(),
      answer: buildAnswer(),
      attachments: [],
      scoringEnabled: true,
      context: {
        attemptId: ATTEMPT_ID,
        submissionId: SUBMISSION_ID,
        generationRunId: GENERATION_RUN_ID,
        organizationId: ORGANIZATION_ID,
        questionId: 'q-1',
      },
      env: TEST_ENV,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      ports: {
        createAgentTransport: vi.fn(async () => {
          throw new Error('unused');
        }),
        generateFeedbackImage: generateImage,
        persistFeedbackImage: persistImage,
      },
    });
    const tools = createFeedforwardTools(session);
    const generate = tools.find((tool) => tool.name === 'generate_feedback_image')!;
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;

    const generated = await generate.execute('image-1', {
      educationalPurpose: '解释平方差公式',
      description: '用两个正方形面积差展示因式分解',
      altText: '平方差面积示意图',
      layout: 'landscape',
    });
    const markdown = (generated.content[0] as { text: string }).text;
    expect(markdown).toBe(`![平方差面积示意图](reachany-oss://${objectKey})`);
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        size: '1536x1024',
        context: expect.objectContaining({ generationRunId: GENERATION_RUN_ID }),
      }),
    );
    expect(persistImage).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: PNG_BYTES,
        contentType: 'image/png',
        slot: 1,
      }),
    );

    await expect(
      generate.execute('image-2', {
        educationalPurpose: '重复',
        description: '重复图片',
        altText: '重复',
        layout: 'square',
      }),
    ).rejects.toThrow('已生成一张解释图片');
    await expect(
      report.execute('report-forged', {
        score: { value: 8, rationale: '按步骤给分' },
        feedback: '![伪造](reachany-oss://quiz-feedforward/forged.png)',
        followUps: [],
        stepErrors: [],
        knowledgePoints: [],
      }),
    ).rejects.toThrow('未生成的 OSS 图片');
    await expect(
      report.execute('report-generated', {
        score: { value: 8, rationale: '按步骤给分' },
        feedback: `观察下图：\n\n${markdown}`,
        followUps: [],
        stepErrors: [],
        knowledgePoints: ['平方差公式'],
      }),
    ).resolves.toMatchObject({ terminate: true });
  });

  it('rejects titled references to ungenerated images inside the loop', async () => {
    const session = createReportSession();
    const report = createFeedforwardTools(session).find(
      (tool) => tool.name === 'report_feedforward',
    )!;
    await expect(
      report.execute('report-titled', {
        score: { value: 8, rationale: '按步骤给分' },
        feedback: '![伪造](reachany-oss://quiz-feedforward/forged.png "示意图")',
        followUps: [],
        stepErrors: [],
        knowledgePoints: [],
      }),
    ).rejects.toThrow('未生成的 OSS 图片');
  });

  it('does not generate or persist an image once the loop signal is aborted', async () => {
    const generateImage = vi.fn(async () => ({
      base64: Buffer.from(PNG_BYTES).toString('base64'),
    }));
    const persistImage = vi.fn(async () => ({ objectKey: 'k.png' }));
    const session = createFeedforwardQuestionSession({
      question: buildQuestion(),
      answer: buildAnswer(),
      attachments: [],
      scoringEnabled: true,
      context: { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID, questionId: 'q-1' },
      env: TEST_ENV,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      ports: {
        createAgentTransport: vi.fn(),
        generateFeedbackImage: generateImage,
        persistFeedbackImage: persistImage,
      },
    });
    const generate = createFeedforwardTools(session).find(
      (tool) => tool.name === 'generate_feedback_image',
    )!;
    const params = {
      educationalPurpose: '解释',
      description: '示意',
      altText: '示意',
      layout: 'square',
    };
    const aborted = new AbortController();
    aborted.abort();
    await expect(generate.execute('image-aborted', params, aborted.signal)).rejects.toThrow(
      '已终止',
    );
    expect(generateImage).not.toHaveBeenCalled();

    // 生成期间被中止：不再上传。
    const midway = new AbortController();
    generateImage.mockImplementationOnce(async () => {
      midway.abort();
      return { base64: Buffer.from(PNG_BYTES).toString('base64') };
    });
    await expect(generate.execute('image-midway', params, midway.signal)).rejects.toThrow('已终止');
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ signal: midway.signal }));
    expect(persistImage).not.toHaveBeenCalled();
  });
});

describe('Markdown report patch flow', () => {
  const pendingReport = {
    score: { value: 6, rationale: '原评分依据' },
    feedback: '这是 **重点',
    followUps: ['原追问'],
    stepErrors: [{ step: '原步骤', error: '原错误' }],
    knowledgePoints: ['原知识点'],
  };

  it('先归一化完整公式，再修复其他定界符，生成端和读取端第二次处理一致', async () => {
    const session = createReportSession();
    const tools = createFeedforwardTools(session);
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;
    const patch = tools.find((tool) => tool.name === 'patch_feedforward_markdown')!;
    const feedback =
      String.raw`\\[P_{\text{二手}}=P_{\text{新}}\cdot\lambda - R\\]` + '\n这是 **重点';
    await report.execute('report-1', { ...pendingReport, feedback });
    expect(session.pendingReport?.feedback).toBe(normalizeQuizMarkdownMath(feedback));
    const completed = await patch.execute('patch-1', {
      operations: [{ oldText: '**重点', newText: '**重点**' }],
    });
    expect(completed.terminate).toBe(true);
    expect(session.report?.feedback).toBe(
      normalizeQuizMarkdownMath(feedback).replace('**重点', '**重点**'),
    );
    expect(normalizeQuizMarkdownMath(session.report!.feedback)).toBe(session.report?.feedback);
  });

  it('无法修复的公式用代码定界符安全降级，读取时不会重新激活', async () => {
    const session = createReportSession();
    const tools = createFeedforwardTools(session);
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;
    const patch = tools.find((tool) => tool.name === 'patch_feedforward_markdown')!;
    await report.execute('report-1', { ...pendingReport, feedback: String.raw`\[x=1` });
    for (const round of [1, 2]) {
      await patch.execute(`patch-${round}`, { operations: [{ oldText: '不存在', newText: '' }] });
    }
    expect(session.report?.feedback).toBe('`\\[`x=1');
    expect(normalizeQuizMarkdownMath(session.report!.feedback)).toBe(session.report?.feedback);
    expect(validateQuizMarkdown(session.report!.feedback).ok).toBe(true);
  });

  it('安全降级也必须满足最终报告字节上限', async () => {
    const session = createReportSession({ maxFeedbackBytes: 5 });
    const tools = createFeedforwardTools(session);
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;
    const patch = tools.find((tool) => tool.name === 'patch_feedforward_markdown')!;
    await report.execute('report-1', { ...pendingReport, feedback: String.raw`\[x=1` });
    for (const round of [1, 2]) {
      await patch.execute(`patch-${round}`, { operations: [{ oldText: '不存在', newText: '' }] });
    }
    expect(session.report).toBeNull();
    expect(session.markdownRepairs.at(-1)?.result).toBe('failed');
    expect(session.markdownRepairs.at(-1)?.reason).toContain('/feedback:');
  });

  it('暂存首次报告并用精确模型 patch 定稿，结构化字段不变', async () => {
    const session = createReportSession();
    const tools = createFeedforwardTools(session);
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;
    const patch = tools.find((tool) => tool.name === 'patch_feedforward_markdown')!;

    const pending = await report.execute('report-1', pendingReport);
    expect((pending.content[0] as { text: string }).text).toContain('awaiting_markdown_patch');
    expect(session.report).toBeNull();
    expect(session.pendingReport?.score).toEqual(pendingReport.score);

    const completed = await patch.execute('patch-1', {
      operations: [{ oldText: '**重点', newText: '**重点**' }],
    });
    expect(completed.terminate).toBe(true);
    expect(session.report).toEqual({ ...pendingReport, feedback: '这是 **重点**' });
    expect(session.markdownRepairs).toMatchObject([
      { round: 1, diagnosticsBefore: ['unclosed-strong'], diagnosticsAfter: [], result: 'applied' },
    ]);
  });

  it('拒绝语义改写，第二轮仍失败时只转义未配对定界符', async () => {
    const session = createReportSession();
    const tools = createFeedforwardTools(session);
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;
    const patch = tools.find((tool) => tool.name === 'patch_feedforward_markdown')!;
    await report.execute('report-1', pendingReport);

    const first = await patch.execute('patch-1', {
      operations: [{ oldText: '重点', newText: '关键' }],
    });
    expect((first.content[0] as { text: string }).text).toContain('awaiting_markdown_patch');
    expect(session.pendingReport?.feedback).toBe('这是 **重点');

    const second = await patch.execute('patch-2', {
      operations: [{ oldText: '不存在的 anchor', newText: '**' }],
    });
    expect(second.terminate).toBe(true);
    expect(session.report?.feedback).toBe('这是 \\*\\*重点');
    expect(session.report?.score).toEqual(pendingReport.score);
    expect(session.markdownRepairs.map((entry) => entry.result)).toEqual(['rejected', 'fallback']);

    await expect(
      patch.execute('patch-3', {
        operations: [{ oldText: '重点', newText: '**重点**' }],
      }),
    ).rejects.toThrow('第三轮');
  });

  it('模型两轮 patch 未完成时只把定界符说明降级为行内代码', async () => {
    const session = createReportSession();
    const tools = createFeedforwardTools(session);
    const report = tools.find((tool) => tool.name === 'report_feedforward')!;
    const patch = tools.find((tool) => tool.name === 'patch_feedforward_markdown')!;
    await report.execute('report-1', {
      ...pendingReport,
      feedback: '说明 \\( 和 \\) 与 \\( ... \\) 都是定界符示例',
    });

    await patch.execute('patch-1', {
      operations: [{ oldText: '定界符示例', newText: '公式语法' }],
    });
    const completed = await patch.execute('patch-2', {
      operations: [{ oldText: '不存在的 anchor', newText: '`' }],
    });

    expect(completed.terminate).toBe(true);
    expect(session.report?.feedback).toBe('说明 `\\(` 和 `\\)` 与 `\\(` ... `\\)` 都是定界符示例');
    expect(session.report?.score).toEqual(pendingReport.score);
    expect(session.markdownRepairs.map((entry) => entry.result)).toEqual(['rejected', 'fallback']);
  });

  it('awaiting 状态禁止重新提交全文', async () => {
    const session = createReportSession();
    const report = createFeedforwardTools(session).find(
      (tool) => tool.name === 'report_feedforward',
    )!;
    await report.execute('report-1', pendingReport);
    await expect(
      report.execute('report-2', { ...pendingReport, feedback: '这是 **重点**' }),
    ).rejects.toThrow('awaiting_markdown_patch');
  });
});
