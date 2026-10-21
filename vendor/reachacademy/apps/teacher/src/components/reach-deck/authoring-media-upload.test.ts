import { describe, expect, it, vi } from 'vitest';

import {
  buildReachDeckAuthoringMediaPath,
  uploadReachDeckAuthoringMedia,
} from './authoring-media-upload';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};

describe('Reach Deck Teacher authoring media upload', () => {
  it.each([
    ['image', 'diagram.png', 'image/png'],
    ['audio', 'sample.mp3', 'audio/mpeg'],
    ['video', 'clip.mp4', 'video/mp4'],
    ['attachment', 'notes.pdf', 'application/pdf'],
  ] as const)('uploads %s through the same-origin route', async (kind, name, contentType) => {
    const file = new File(['media'], name, { type: contentType });
    const objectKey = `uploads/reach-deck/${kind}/${name}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          assetId: '66666666-6666-4666-8666-666666666666',
          kind,
          objectKey,
          contentType,
          downloadUrl: 'https://oss.example/download-token',
        }),
      );
    const signal = new AbortController().signal;

    const result = await uploadReachDeckAuthoringMedia({ context, file, kind, signal, fetchImpl });

    expect(result).toEqual({
      assetId: '66666666-6666-4666-8666-666666666666',
      objectKey,
      contentType,
      digest: `objectkey:${objectKey}`,
      downloadUrl: 'https://oss.example/download-token',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, buildReachDeckAuthoringMediaPath(context), {
      cache: 'no-store',
      method: 'GET',
      signal,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      buildReachDeckAuthoringMediaPath(context),
      expect.objectContaining({
        body: file,
        headers: {
          'content-type': contentType,
          'x-reach-deck-file-name': encodeURIComponent(name),
          'x-reach-deck-file-size': String(file.size),
          'x-reach-deck-media-kind': kind,
        },
        method: 'POST',
        signal,
      }),
    );
  });

  it('does not accept a mismatched media identity from the server', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          assetId: '66666666-6666-4666-8666-666666666666',
          kind: 'audio',
          objectKey: 'uploads/reach-deck/audio/sample.mp3',
          contentType: 'audio/mpeg',
          downloadUrl: 'https://oss.example/download-token',
        }),
      );

    await expect(
      uploadReachDeckAuthoringMedia({
        context,
        file: new File(['image'], 'diagram.png', { type: 'image/png' }),
        kind: 'image',
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow('kind did not match');
  });

  it('stops when the same-origin upload fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(
      uploadReachDeckAuthoringMedia({
        context,
        file: new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' }),
        kind: 'audio',
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow('upload failed with HTTP 502');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not post media when the session probe fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      uploadReachDeckAuthoringMedia({
        context,
        file: new File(['image'], 'diagram.png', { type: 'image/png' }),
        kind: 'image',
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow('session failed with HTTP 401');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
