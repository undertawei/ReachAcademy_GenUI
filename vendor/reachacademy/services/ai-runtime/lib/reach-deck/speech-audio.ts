import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REACH_DECK_SPEECH_MAX_CHUNKS = 256;
export const REACH_DECK_SPEECH_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const REACH_DECK_SPEECH_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const OUTPUT_CONTENT_TYPE = 'audio/mpeg' as const;

export type ReachDeckSpeechChunk =
  | Uint8Array
  | {
      bytes: Uint8Array;
      contentType?: string;
    };

export interface ReachDeckSpeechCommandInvocation {
  command: 'ffprobe' | 'ffmpeg';
  args: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface ReachDeckSpeechCommandResult {
  stdout?: string | Uint8Array;
}

export type ReachDeckSpeechCommandRunner = (
  invocation: ReachDeckSpeechCommandInvocation,
) => Promise<ReachDeckSpeechCommandResult>;

export type ReachDeckSpeechCommandErrorCode = 'timeout' | 'output_limit' | 'failed';

export class ReachDeckSpeechCommandError extends Error {
  constructor(readonly code: ReachDeckSpeechCommandErrorCode) {
    super(`Speech audio command ${code}`);
    this.name = 'ReachDeckSpeechCommandError';
  }
}

export type ReachDeckSpeechAudioErrorCode =
  | 'invalid_input'
  | 'temporary_storage_failed'
  | 'probe_timeout'
  | 'probe_failed'
  | 'invalid_duration'
  | 'concat_timeout'
  | 'concat_failed'
  | 'empty_output'
  | 'output_too_large'
  | 'cleanup_failed';

export class ReachDeckSpeechAudioError extends Error {
  constructor(
    readonly code: ReachDeckSpeechAudioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReachDeckSpeechAudioError';
  }
}

export interface ConcatReachDeckSpeechOptions {
  /** Test seam and worker-specific command adapter. It must honor the supplied bounds. */
  commandRunner?: ReachDeckSpeechCommandRunner;
  commandTimeoutMs?: number;
}

export interface ConcatenatedReachDeckSpeech {
  bytes: Uint8Array;
  contentType: typeof OUTPUT_CONTENT_TYPE;
  durationsSeconds: number[];
}

/** Quote a path according to ffmpeg concat-demuxer token rules, not shell rules. */
export function formatFfmpegConcatEntry(filePath: string): string {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

/**
 * Probe every MP3 chunk, then concatenate them without re-encoding.
 *
 * The function owns all temporary files and removes them before resolving or rejecting. The
 * injected runner sees only fixed commands with parameter arrays; no shell is involved.
 */
export async function concatReachDeckSpeechChunks(
  chunks: readonly ReachDeckSpeechChunk[],
  options: ConcatReachDeckSpeechOptions = {},
): Promise<ConcatenatedReachDeckSpeech> {
  const normalizedChunks = validateChunks(chunks);
  const commandTimeoutMs = validateCommandTimeout(options.commandTimeoutMs);
  const commandRunner = options.commandRunner ?? runBoundedCommand;

  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), 'reachany-deck-speech-'));
  } catch {
    throw new ReachDeckSpeechAudioError(
      'temporary_storage_failed',
      'Could not allocate temporary speech audio storage',
    );
  }

  let result: ConcatenatedReachDeckSpeech | undefined;
  let failure: unknown;
  try {
    const chunkPaths: string[] = [];
    for (let index = 0; index < normalizedChunks.length; index += 1) {
      const chunkPath = join(directory, `chunk-${String(index).padStart(4, '0')}.mp3`);
      await writeFile(chunkPath, normalizedChunks[index]!, { flag: 'wx', mode: 0o600 });
      chunkPaths.push(chunkPath);
    }

    const durationsSeconds: number[] = [];
    for (const chunkPath of chunkPaths) {
      const probe = await runSpeechCommand(
        commandRunner,
        {
          command: 'ffprobe',
          args: [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            chunkPath,
          ],
          timeoutMs: commandTimeoutMs,
          maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES,
          maxStderrBytes: MAX_COMMAND_OUTPUT_BYTES,
        },
        'probe',
      );
      durationsSeconds.push(parseDuration(probe.stdout));
    }

    const manifestPath = join(directory, 'chunks.ffconcat');
    const manifest = ['ffconcat version 1.0', ...chunkPaths.map(formatFfmpegConcatEntry), ''].join(
      '\n',
    );
    await writeFile(manifestPath, manifest, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

    const outputPath = join(directory, 'combined.mp3');
    await runSpeechCommand(
      commandRunner,
      {
        command: 'ffmpeg',
        args: [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          manifestPath,
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
          outputPath,
        ],
        timeoutMs: commandTimeoutMs,
        maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES,
        maxStderrBytes: MAX_COMMAND_OUTPUT_BYTES,
      },
      'concat',
    );

    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size <= 0) {
      throw new ReachDeckSpeechAudioError('empty_output', 'Speech audio concatenation was empty');
    }
    if (outputStat.size > REACH_DECK_SPEECH_MAX_TOTAL_BYTES) {
      throw new ReachDeckSpeechAudioError(
        'output_too_large',
        'Speech audio concatenation exceeded the output size bound',
      );
    }
    const output = await readFile(outputPath);
    if (output.byteLength === 0) {
      throw new ReachDeckSpeechAudioError('empty_output', 'Speech audio concatenation was empty');
    }
    result = {
      bytes: Uint8Array.from(output),
      contentType: OUTPUT_CONTENT_TYPE,
      durationsSeconds,
    };
  } catch (error) {
    failure = normalizeProcessingFailure(error);
  }

  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    if (failure === undefined) {
      failure = new ReachDeckSpeechAudioError(
        'cleanup_failed',
        'Could not clean up temporary speech audio storage',
      );
    }
  }

  if (failure !== undefined) throw failure;
  return result!;
}

function validateChunks(chunks: readonly ReachDeckSpeechChunk[]): Uint8Array[] {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new ReachDeckSpeechAudioError('invalid_input', 'At least one MP3 chunk is required');
  }
  if (chunks.length > REACH_DECK_SPEECH_MAX_CHUNKS) {
    throw new ReachDeckSpeechAudioError('invalid_input', 'Too many speech audio chunks');
  }

  let totalBytes = 0;
  return chunks.map((chunk) => {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk?.bytes;
    const contentType = chunk instanceof Uint8Array ? undefined : chunk?.contentType;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new ReachDeckSpeechAudioError(
        'invalid_input',
        'Every speech audio chunk must be non-empty',
      );
    }
    if (bytes.byteLength > REACH_DECK_SPEECH_MAX_CHUNK_BYTES) {
      throw new ReachDeckSpeechAudioError(
        'invalid_input',
        'A speech audio chunk exceeded its size bound',
      );
    }
    totalBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > REACH_DECK_SPEECH_MAX_TOTAL_BYTES) {
      throw new ReachDeckSpeechAudioError(
        'invalid_input',
        'Speech audio chunks exceeded the total size bound',
      );
    }
    if (
      contentType !== undefined &&
      (typeof contentType !== 'string' || !isMp3ContentType(contentType))
    ) {
      throw new ReachDeckSpeechAudioError(
        'invalid_input',
        'Speech audio chunks must use an MP3 content type',
      );
    }
    if (!hasMp3Signature(bytes)) {
      throw new ReachDeckSpeechAudioError(
        'invalid_input',
        'Speech audio chunk does not have an MP3 signature',
      );
    }
    return bytes;
  });
}

function validateCommandTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 100 || value > MAX_COMMAND_TIMEOUT_MS) {
    throw new ReachDeckSpeechAudioError(
      'invalid_input',
      'Speech audio command timeout is out of bounds',
    );
  }
  return value;
}

function isMp3ContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return normalized === 'audio/mpeg' || normalized === 'audio/mp3';
}

function hasMp3Signature(bytes: Uint8Array): boolean {
  if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

function parseDuration(stdout: string | Uint8Array | undefined): number {
  const value = Number(decodeCommandOutput(stdout).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new ReachDeckSpeechAudioError(
      'invalid_duration',
      'ffprobe returned an invalid speech audio duration',
    );
  }
  return value;
}

function decodeCommandOutput(output: string | Uint8Array | undefined): string {
  if (typeof output === 'string') return output;
  if (output instanceof Uint8Array) return Buffer.from(output).toString('utf8');
  return '';
}

async function runSpeechCommand(
  runner: ReachDeckSpeechCommandRunner,
  invocation: ReachDeckSpeechCommandInvocation,
  stage: 'probe' | 'concat',
): Promise<ReachDeckSpeechCommandResult> {
  try {
    return await runner(invocation);
  } catch (error) {
    if (error instanceof ReachDeckSpeechCommandError && error.code === 'timeout') {
      throw new ReachDeckSpeechAudioError(
        stage === 'probe' ? 'probe_timeout' : 'concat_timeout',
        stage === 'probe' ? 'Speech audio probe timed out' : 'Speech audio concatenation timed out',
      );
    }
    throw new ReachDeckSpeechAudioError(
      stage === 'probe' ? 'probe_failed' : 'concat_failed',
      stage === 'probe' ? 'Could not probe speech audio' : 'Could not concatenate speech audio',
    );
  }
}

function normalizeProcessingFailure(error: unknown): ReachDeckSpeechAudioError {
  if (error instanceof ReachDeckSpeechAudioError) return error;
  return new ReachDeckSpeechAudioError('concat_failed', 'Could not process speech audio chunks');
}

function runBoundedCommand(
  invocation: ReachDeckSpeechCommandInvocation,
): Promise<ReachDeckSpeechCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finishWithError = (code: ReachDeckSpeechCommandErrorCode) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      child.kill('SIGKILL');
      reject(new ReachDeckSpeechCommandError(code));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > invocation.maxStdoutBytes) {
        finishWithError('output_limit');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > invocation.maxStderrBytes) finishWithError('output_limit');
    });
    child.once('error', () => finishWithError('failed'));
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (code !== 0) {
        reject(new ReachDeckSpeechCommandError('failed'));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks, stdoutBytes) });
    });
    timeout = setTimeout(() => finishWithError('timeout'), invocation.timeoutMs);
    timeout.unref();
  });
}
