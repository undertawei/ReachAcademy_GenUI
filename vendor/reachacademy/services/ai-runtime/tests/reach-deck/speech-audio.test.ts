import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  concatReachDeckSpeechChunks,
  formatFfmpegConcatEntry,
  ReachDeckSpeechAudioError,
  ReachDeckSpeechCommandError,
  REACH_DECK_SPEECH_MAX_CHUNKS,
  REACH_DECK_SPEECH_MAX_CHUNK_BYTES,
  REACH_DECK_SPEECH_MAX_TOTAL_BYTES,
  type ReachDeckSpeechCommandInvocation,
  type ReachDeckSpeechCommandRunner,
} from '../../lib/reach-deck/speech-audio.js';

const mp3 = (...payload: number[]) => Uint8Array.from([0x49, 0x44, 0x33, ...payload]);

function successfulRunner(durations: readonly number[], output = mp3(9, 8, 7)) {
  const invocations: ReachDeckSpeechCommandInvocation[] = [];
  let probeIndex = 0;
  let manifest: string | undefined;
  let directory: string | undefined;
  const runner: ReachDeckSpeechCommandRunner = vi.fn(async (invocation) => {
    invocations.push(invocation);
    if (invocation.command === 'ffprobe') {
      directory ??= dirname(invocation.args.at(-1)!);
      return { stdout: `${durations[probeIndex++]!}\n` };
    }
    const manifestPath = invocation.args[invocation.args.indexOf('-i') + 1]!;
    manifest = await readFile(manifestPath, 'utf8');
    await writeFile(invocation.args.at(-1)!, output);
    return { stdout: '' };
  });
  return {
    runner,
    invocations,
    getManifest: () => manifest,
    getDirectory: () => directory,
  };
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

describe('concatReachDeckSpeechChunks', () => {
  it('probes chunks in order and invokes ffmpeg with a bounded concat-demuxer parameter array', async () => {
    const mock = successfulRunner([0.25, 1.75]);

    const result = await concatReachDeckSpeechChunks(
      [mp3(1), { bytes: mp3(2), contentType: 'audio/mpeg; charset=binary' }],
      { commandRunner: mock.runner, commandTimeoutMs: 1_234 },
    );

    expect(result).toEqual({
      bytes: mp3(9, 8, 7),
      contentType: 'audio/mpeg',
      durationsSeconds: [0.25, 1.75],
    });
    expect(mock.invocations.map(({ command }) => command)).toEqual([
      'ffprobe',
      'ffprobe',
      'ffmpeg',
    ]);
    expect(mock.invocations[0]!.args.slice(0, -1)).toEqual([
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
    ]);
    const ffmpeg = mock.invocations[2]!;
    expect(ffmpeg.args).toEqual([
      '-v',
      'error',
      '-nostdin',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      expect.stringMatching(/chunks\.ffconcat$/),
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-write_xing',
      '0',
      '-y',
      expect.stringMatching(/combined\.mp3$/),
    ]);
    expect(ffmpeg.timeoutMs).toBe(1_234);
    expect(ffmpeg.maxStdoutBytes).toBeGreaterThan(0);
    expect(ffmpeg.maxStderrBytes).toBeGreaterThan(0);
    expect(mock.getManifest()).toMatch(
      /^ffconcat version 1\.0\nfile '.*chunk-0000\.mp3'\nfile '.*chunk-0001\.mp3'\n$/,
    );
    expect(await pathExists(mock.getDirectory()!)).toBe(false);
  });

  it('escapes apostrophes in concat manifest paths without shell interpolation', () => {
    expect(formatFfmpegConcatEntry("/tmp/teacher's voice/chunk.mp3")).toBe(
      "file '/tmp/teacher'\\''s voice/chunk.mp3'",
    );
  });

  it('still probes and produces a new output for a single chunk', async () => {
    const mock = successfulRunner([2.5], mp3(4));

    const result = await concatReachDeckSpeechChunks([mp3(3)], { commandRunner: mock.runner });

    expect(result.durationsSeconds).toEqual([2.5]);
    expect(result.bytes).toEqual(mp3(4));
    expect(mock.invocations.map(({ command }) => command)).toEqual(['ffprobe', 'ffmpeg']);
  });

  it.each(['', '0', '-1', 'Infinity', 'NaN'])(
    'rejects invalid probe duration %j',
    async (duration) => {
      let temporaryDirectory: string | undefined;
      const runner: ReachDeckSpeechCommandRunner = async (invocation) => {
        temporaryDirectory = dirname(invocation.args.at(-1)!);
        return { stdout: duration };
      };

      await expect(
        concatReachDeckSpeechChunks([mp3(1)], { commandRunner: runner }),
      ).rejects.toMatchObject({ code: 'invalid_duration' });
      expect(await pathExists(temporaryDirectory!)).toBe(false);
    },
  );

  it('maps command timeout to a stable stage error and cleans temporary files', async () => {
    let temporaryDirectory: string | undefined;
    const runner: ReachDeckSpeechCommandRunner = async (invocation) => {
      temporaryDirectory = dirname(invocation.args.at(-1)!);
      throw new ReachDeckSpeechCommandError('timeout');
    };

    await expect(
      concatReachDeckSpeechChunks([mp3(1)], { commandRunner: runner }),
    ).rejects.toMatchObject({ code: 'probe_timeout' });
    expect(await pathExists(temporaryDirectory!)).toBe(false);
  });

  it('maps concat timeout separately after all durations were accepted', async () => {
    let temporaryDirectory: string | undefined;
    const runner: ReachDeckSpeechCommandRunner = async (invocation) => {
      temporaryDirectory ??= dirname(invocation.args.at(-1)!);
      if (invocation.command === 'ffprobe') return { stdout: '0.5' };
      throw new ReachDeckSpeechCommandError('timeout');
    };

    await expect(
      concatReachDeckSpeechChunks([mp3(1)], { commandRunner: runner }),
    ).rejects.toMatchObject({ code: 'concat_timeout' });
    expect(await pathExists(temporaryDirectory!)).toBe(false);
  });

  it('maps command failure without exposing command stderr and cleans temporary files', async () => {
    let temporaryDirectory: string | undefined;
    const runner: ReachDeckSpeechCommandRunner = async (invocation) => {
      temporaryDirectory = dirname(invocation.args.at(-1)!);
      throw new Error('stderr containing private provider material');
    };

    const promise = concatReachDeckSpeechChunks([mp3(1)], { commandRunner: runner });
    await expect(promise).rejects.toMatchObject({ code: 'probe_failed' });
    await expect(promise).rejects.not.toThrow(/private provider material/);
    expect(await pathExists(temporaryDirectory!)).toBe(false);
  });

  it('rejects an empty ffmpeg output and removes it', async () => {
    const mock = successfulRunner([0.5], new Uint8Array());

    await expect(
      concatReachDeckSpeechChunks([mp3(1)], { commandRunner: mock.runner }),
    ).rejects.toMatchObject({ code: 'empty_output' });
    expect(await pathExists(mock.getDirectory()!)).toBe(false);
  });

  it('rejects invalid chunk count, per-chunk size, total size, type, and signature before running commands', async () => {
    const runner = vi.fn<ReachDeckSpeechCommandRunner>();
    const oversized = new Uint8Array(REACH_DECK_SPEECH_MAX_CHUNK_BYTES + 1);
    oversized.set(mp3());
    const maximum = new Uint8Array(REACH_DECK_SPEECH_MAX_CHUNK_BYTES);
    maximum.set(mp3());
    const totalOverflow = Array.from(
      { length: Math.floor(REACH_DECK_SPEECH_MAX_TOTAL_BYTES / maximum.byteLength) + 1 },
      () => maximum,
    );

    const invalidInputs: readonly (readonly (
      | Uint8Array
      | { bytes: Uint8Array; contentType?: string }
    )[])[] = [
      [],
      Array.from({ length: REACH_DECK_SPEECH_MAX_CHUNKS + 1 }, () => mp3()),
      [new Uint8Array()],
      [oversized],
      totalOverflow,
      [{ bytes: mp3(), contentType: 'audio/wav' }],
      [Uint8Array.from([1, 2, 3])],
    ];

    for (const chunks of invalidInputs) {
      await expect(
        concatReachDeckSpeechChunks(chunks, { commandRunner: runner }),
      ).rejects.toBeInstanceOf(ReachDeckSpeechAudioError);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects an out-of-bounds timeout before allocating command work', async () => {
    const runner = vi.fn<ReachDeckSpeechCommandRunner>();
    await expect(
      concatReachDeckSpeechChunks([mp3(1)], { commandRunner: runner, commandTimeoutMs: Infinity }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('accepts frame-sync MP3 chunks as well as ID3-tagged chunks', async () => {
    const mock = successfulRunner([0.1]);
    const result = await concatReachDeckSpeechChunks([Uint8Array.from([0xff, 0xfb, 0x90, 0x64])], {
      commandRunner: mock.runner,
    });
    expect(result.durationsSeconds).toEqual([0.1]);
  });
});
