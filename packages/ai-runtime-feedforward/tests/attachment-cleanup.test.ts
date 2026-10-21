import { open, readFile, rm } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  createAttachmentIngestionState,
  ingestAttachment,
  type AttachmentIngestionDependencies,
} from '../../ai-runtime-common/src/file-ingestion.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

describe('attachment temporary file cleanup', () => {
  it.each(['text', 'image'] as const)('waits for the %s reader before cleanup', async (kind) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(rm).mockClear();
    let reads = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      // 首次只读打开用于文件头；第二次打开停在正文读取边界。
      if (kind === 'text' && args[1] === 'r' && ++reads === 2) {
        started.resolve();
        await release.promise;
      }
      return actual.open(...args);
    });
    vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
      started.resolve();
      await release.promise;
      return actual.readFile(...args);
    });
    const dependencies: AttachmentIngestionDependencies = {
      extractPdf: vi.fn(),
      transcribeAudio: vi.fn(),
      understandAudio: vi.fn(),
      understandVideo: vi.fn(),
      inspectMedia: vi.fn(),
      normalizeAudio: vi.fn(),
      normalizeVideo: vi.fn(),
      extractVideoAudio: vi.fn(),
    };
    const pending = ingestAttachment({
      attachment: {
        objectKey: `quiz/org/answer.${kind === 'text' ? 'c' : 'png'}`,
        name: kind === 'text' ? 'answer.c' : 'answer.png',
        contentType: kind === 'text' ? 'text/x-c' : 'image/png',
        downloadUrl: 'https://example.test/attachment',
      },
      state: createAttachmentIngestionState(),
      context: { submissionId: 'submission', organizationId: 'org' },
      env: {},
      fetch: vi.fn(async () =>
        kind === 'text'
          ? new Response('int main(void) { return 0; }')
          : new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])),
      ),
      dependencies,
    });
    try {
      await started.promise;
      expect(rm).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      const contents = await pending;
      const directory = vi.mocked(rm).mock.calls[0]?.[0];
      if (directory !== undefined) await actual.rm(directory, { recursive: true, force: true });
      vi.mocked(open).mockImplementation(actual.open);
      vi.mocked(readFile).mockImplementation(actual.readFile);
      expect(rm).toHaveBeenCalledTimes(1);
      expect(contents[0]).toMatchObject({ type: 'text' });
      expect(JSON.parse((contents[0] as { text: string }).text)).toMatchObject({
        status: 'processed',
        kind,
      });
    }
  });
});
