import { describe, expect, it } from 'vitest';
import {
  parseGroupCollaborationPreview,
  parseMarketplaceGroupPreview,
  parseMarketplaceQuizPreview,
  parsePreviewAttachmentUrls,
} from '../src/preview.js';
const group = {
  moduleVersionId: '11111111-1111-4111-8111-111111111111',
  instructions: { type: 'doc', content: [] },
  attachmentNames: ['Worksheet'],
  attachments: [
    {
      assetId: 'asset',
      name: 'Worksheet',
      contentType: 'application/pdf',
      sizeBytes: 42,
      previewUrl: 'https://media.test/preview',
      downloadUrl: 'https://media.test/download',
      previewDisposition: 'inline',
    },
  ],
  mediaUrlsByObjectKey: { image: 'https://media.test/image' },
  minParticipants: 2,
  maxParticipants: 4,
  submissionDeadline: '2026-10-11T00:00:00Z',
  publishedAt: '2026-10-11T00:00:00Z',
};
describe('shared learner preview contract', () => {
  it('accepts valid task-only Group previews and nullable unavailable attachments', () => {
    expect(parseGroupCollaborationPreview(group)).toEqual(group);
    expect(
      parseGroupCollaborationPreview({
        ...group,
        attachments: [
          {
            ...group.attachments[0],
            previewUrl: null,
            downloadUrl: null,
            previewDisposition: null,
          },
        ],
      }),
    ).not.toBeNull();
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,secret',
    '//media.test/asset',
    '/private/file',
    'ftp://media.test/file',
  ])('never exposes %s and degrades only the affected Group item', (url) => {
    const second = { ...group.attachments[0], assetId: 'second', name: 'Rubric' };
    const downloadBroken = parseGroupCollaborationPreview({
      ...group,
      attachments: [{ ...group.attachments[0], downloadUrl: url }, second],
    });
    expect(downloadBroken?.attachments).toEqual([
      { ...group.attachments[0], downloadUrl: null },
      second,
    ]);
    const previewBroken = parseGroupCollaborationPreview({
      ...group,
      attachments: [{ ...group.attachments[0], previewUrl: url }],
    });
    expect(previewBroken?.attachments).toEqual([
      { ...group.attachments[0], previewUrl: null, previewDisposition: null },
    ]);
    const mediaBroken = parseGroupCollaborationPreview({
      ...group,
      mediaUrlsByObjectKey: { ...group.mediaUrlsByObjectKey, broken: url },
    });
    expect(mediaBroken?.mediaUrlsByObjectKey).toEqual(group.mediaUrlsByObjectKey);
    expect(JSON.stringify([downloadBroken, previewBroken, mediaBroken])).not.toContain(url);
  });
  it('drops only structurally malformed attachments and keeps the rest of the task', () => {
    const preview = parseGroupCollaborationPreview({
      ...group,
      attachments: [{}, { ...group.attachments[0], sizeBytes: -1 }, group.attachments[0]],
    });
    expect(preview?.attachments).toEqual(group.attachments);
    expect(preview?.instructions).toEqual(group.instructions);
  });
  it('falls back to download when an attachment presentation mode is unusable', () => {
    const preview = parseGroupCollaborationPreview({
      ...group,
      attachments: [{ ...group.attachments[0], previewDisposition: 'embed' }],
    });
    expect(preview?.attachments).toEqual([
      { ...group.attachments[0], previewUrl: null, previewDisposition: null },
    ]);
  });
  it('keeps the HEAD version contract for in-course previews and UUIDs for the plaza', () => {
    const legacy = { ...group, moduleVersionId: 'legacy-version' };
    expect(parseGroupCollaborationPreview(legacy)?.moduleVersionId).toBe('legacy-version');
    expect(() => parseMarketplaceGroupPreview(legacy)).toThrow();
    expect(parseMarketplaceGroupPreview(group).moduleVersionId).toBe(group.moduleVersionId);
  });
  it('still rejects a Group preview whose task fields are malformed', () => {
    expect(parseGroupCollaborationPreview({ ...group, instructions: 'text' })).toBeNull();
    expect(parseGroupCollaborationPreview({ ...group, attachments: 'none' })).toBeNull();
    expect(parseGroupCollaborationPreview({ ...group, mediaUrlsByObjectKey: null })).toBeNull();
    expect(parseGroupCollaborationPreview({ ...group, minParticipants: 0 })).toBeNull();
  });
  it.each(['answer', 'reference_answer', 'rubric', 'grading'])(
    'rejects private Quiz field %s for both role clients',
    (key) => {
      expect(() =>
        parseMarketplaceQuizPreview({
          moduleVersionId: group.moduleVersionId,
          publishedAt: group.publishedAt,
          expiresInSeconds: 900,
          mediaUrlsByObjectKey: {},
          attachmentUrlsByObjectKey: {},
          paper: {
            schema_version: 1,
            settings: {},
            questions: [
              { id: 'q', question_type: 'short_answer', question: 'Question', [key]: 'private' },
            ],
          },
        }),
      ).toThrow('learner-safe');
    },
  );
  it('rejects executable attachment links', () => {
    expect(() =>
      parsePreviewAttachmentUrls({
        file: {
          previewUrl: 'javascript:alert(1)',
          downloadUrl: 'https://media.test/file',
          previewDisposition: 'inline',
          contentType: 'text/html',
        },
      }),
    ).toThrow();
  });
});
