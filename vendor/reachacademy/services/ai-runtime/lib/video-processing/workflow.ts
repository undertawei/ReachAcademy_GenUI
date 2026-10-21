import type { MediaMetadata } from '@reachany/ai-runtime-common/file-ingestion';
import { GuardrailError, guardrailCode } from '@reachany/ai-runtime-feedforward';
import { createHash } from 'node:crypto';

/** content-service 处理 bundle 投影（严格对齐 VideoDto.ProcessingBundleResponse）。 */
export interface VideoProcessingBundle {
  organizationId: string;
  moduleId: string;
  draftModuleVersionId: string;
  processingStatus: string;
  videoDownloadUrl: string;
  videoObjectKey?: string;
  expiresInSeconds: number;
  declaredMetadata: VideoDeclaredMetadata | null;
}

export interface VideoDeclaredMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
  sizeBytes: number | null;
}

export interface VideoSubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface VideoProcessingStateRequest {
  status: 'validating' | 'transcode_required' | 'transcribing' | 'ready' | 'failed';
  failureReason?: string;
  probedMetadata?: VideoDeclaredMetadata;
  /** 仅 transcoding → transcribing/ready 换绑转码产物时携带。 */
  videoObjectKey?: string;
  subtitleCues?: VideoSubtitleCue[];
  expectedVideoObjectKey?: string;
}

export interface VideoProcessingPorts {
  content: {
    fetchBundle(): Promise<VideoProcessingBundle>;
    recordState(request: VideoProcessingStateRequest): Promise<void>;
    /** 仅 transcoding 状态可用：登记台账并签发转码产物 PUT URL。 */
    requestTranscodeTarget(sizeBytes: number): Promise<{ objectKey: string; uploadUrl: string }>;
  };
  media: {
    /** Download the signed URL to a temp file, bounded by maxBytes; caller owns cleanup(). */
    download(
      url: string,
      maxBytes: number,
    ): Promise<{ filePath: string; bytes: number; cleanup: () => Promise<void> }>;
    inspect(filePath: string): Promise<MediaMetadata>;
    /** ffmpeg 整片转 H.264/AAC；返回产物字节数。 */
    transcodeToH264(inputPath: string, outputPath: string, timeoutMs: number): Promise<number>;
    /** 转码产物 PUT 回 OSS（content-type video/mp4）。 */
    upload(filePath: string, uploadUrl: string): Promise<void>;
    /** 临时输出文件路径分配；调用方负责清理。 */
    allocateTempFile(suffix: string): Promise<{ filePath: string; cleanup: () => Promise<void> }>;
  };
  asr: {
    submit(input: { mediaUrl: string; clientToken: string }): Promise<{ taskId: string }>;
    query(taskId: string): Promise<{
      status: 'running' | 'completed' | 'failed';
      cues?: VideoSubtitleCue[];
      failureCode?: string;
    }>;
  };
  /** Test seams: injectable clock and sleeper for the polling loop. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface VideoProcessingObserver {
  stateRecorded?(status: string, detail?: Record<string, unknown>): Promise<void> | void;
}

export interface VideoProcessingOptions {
  ports: VideoProcessingPorts;
  observer?: VideoProcessingObserver;
  execution?: { attemptNumber: number; maxAttempts: number };
}

/** VideoModuleVersionDocument.FAILURE_REASONS 的镜像：只回写这些安全码。 */
export const VIDEO_FAILURE_REASONS = new Set([
  'metadata_mismatch',
  'unsupported_container',
  'unsupported_codec',
  'duration_exceeded',
  'no_audio_transcription_failed',
  'probe_failed',
  'transcription_failed',
  'transcode_failed',
  'internal_error',
]);

export const VIDEO_MAX_BYTES = 1_073_741_824; // 1 GiB，与教师上传预签名上限一致
export const VIDEO_MAX_DURATION_SECONDS = 7_200;
export const VIDEO_MAX_SUBTITLE_CUES = 20_000;
export const VIDEO_MAX_CUE_TEXT_LENGTH = 2_000;
const POLL_INITIAL_DELAY_MS = 5_000;
const POLL_MAX_DELAY_MS = 30_000;
const POLL_OVERALL_TIMEOUT_MS = 30 * 60 * 1000;
/** 整片转码超时：veryfast 预设按 ≥0.3× 实时估算，120 分钟上限给足 4 小时。 */
export const TRANSCODE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Terminal domain failure carrying a safe failure code for content-service. */
export class VideoProcessingFailure extends Error {
  constructor(
    readonly failureReason: string,
    message: string,
  ) {
    super(message);
    this.name = 'VideoProcessingFailure';
  }
}

/** Queue-independent terminal error, mirroring FeedforwardUnrecoverableError. */
export class VideoProcessingUnrecoverableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UnrecoverableError';
  }
}

function isRetryable(error: unknown): boolean {
  if (guardrailCode(error)) return false;
  if (typeof error !== 'object' || error === null || !('retryable' in error)) return false;
  return (error as { retryable?: unknown }).retryable === true;
}

/**
 * 视频处理工作流：bundle → validating → 本地 ffprobe 校验 → transcribing → ASR 轮询 → ready。
 * 全部状态回写幂等（content-service 乐观状态 CAS），崩溃后可安全重跑：
 * 从 bundle 的当前状态推进，已经越过的转移不再重复提交。
 */
export async function processVideoJob(
  payload: { draftModuleVersionId: string; clientToken: string },
  options: VideoProcessingOptions,
): Promise<{ status: 'ready'; cueCount: number }> {
  const { ports } = options;
  try {
    const bundle = await ports.content.fetchBundle();
    if (bundle.processingStatus === 'ready') {
      // 之前的尝试已经完成：幂等短路。
      return { status: 'ready', cueCount: 0 };
    }
    if (bundle.processingStatus === 'failed') {
      throw new VideoProcessingUnrecoverableError(
        'video draft is already marked failed; teacher retry re-enqueues a new run',
      );
    }
    if (bundle.processingStatus === 'transcode_required') {
      // 等待教师决策（系统转码或自行转换重传）：run 幂等结束，批准端点会重新触发。
      throw new VideoProcessingUnrecoverableError(
        'video draft is waiting for the teacher transcode decision',
      );
    }
    if (
      typeof bundle.videoDownloadUrl !== 'string' ||
      !/^https?:\/\//i.test(bundle.videoDownloadUrl)
    ) {
      throw new VideoProcessingFailure(
        'internal_error',
        'processing bundle has no usable signed URL',
      );
    }

    // validating ← {uploaded, validating}；transcribing 之后不允许回退，跳过重复提交。
    if (bundle.processingStatus === 'uploaded' || bundle.processingStatus === 'validating') {
      await ports.content.recordState({ status: 'validating' });
      await options.observer?.stateRecorded?.('validating');
    }

    let transcodedObjectKey: string | undefined;
    let probed: MediaMetadata;
    if (bundle.processingStatus === 'transcoding') {
      // 教师批准系统转码：本地转 H.264 → PUT 回 OSS → 后续状态回写换绑产物。
      const outcome = await transcodeMedia(bundle, ports);
      transcodedObjectKey = outcome.objectKey;
      probed = outcome.probed;
      await options.observer?.stateRecorded?.('transcoded', { objectKey: outcome.objectKey });
    } else {
      const validated = await validateMedia(bundle, ports);
      if (validated.kind === 'transcode-required') {
        await ports.content.recordState({
          status: 'transcode_required',
          probedMetadata: toDeclaredShape(validated.probed),
        });
        await options.observer?.stateRecorded?.('transcode_required', {
          codec: validated.probed.videoCodec ?? 'unknown',
        });
        // 决策权移交教师；批准后新的 run 从 transcoding 恢复。
        throw new VideoProcessingUnrecoverableError(
          'video codec requires transcoding; waiting for the teacher decision',
        );
      }
      probed = validated.probed;
    }
    if (!probed.hasAudio) {
      // 无音轨：按计划跳过 ASR，直接 ready（空 cues）。
      await ports.content.recordState({
        status: 'ready',
        probedMetadata: toDeclaredShape(probed),
        subtitleCues: [],
        ...(transcodedObjectKey === undefined ? {} : { videoObjectKey: transcodedObjectKey }),
      });
      await options.observer?.stateRecorded?.('ready', { cueCount: 0, noAudio: true });
      return { status: 'ready', cueCount: 0 };
    }

    await ports.content.recordState({
      status: 'transcribing',
      probedMetadata: toDeclaredShape(probed),
      ...(transcodedObjectKey === undefined ? {} : { videoObjectKey: transcodedObjectKey }),
    });
    await options.observer?.stateRecorded?.('transcribing');

    // 换绑转码产物后需要新的签名 URL 提交 ASR（原 URL 指向旧对象）。
    const asrBundle =
      transcodedObjectKey === undefined ? bundle : await ports.content.fetchBundle();
    // The authoritative asset, rather than the draft/run, identifies the ASR source.
    // This also handles a delayed old Run that first loads a newly replaced video.
    const assetName = asrBundle.videoObjectKey?.split('/').at(-1);
    const clientToken = assetName
      ? createHash('sha256')
          .update(`video-processing:${payload.draftModuleVersionId}:${assetName}`)
          .digest('hex')
      : payload.clientToken;
    const cues = await transcribe(asrBundle.videoDownloadUrl, clientToken, ports);
    await ports.content.recordState({
      status: 'ready',
      probedMetadata: toDeclaredShape(probed),
      subtitleCues: cues,
    });
    await options.observer?.stateRecorded?.('ready', { cueCount: cues.length });
    return { status: 'ready', cueCount: cues.length };
  } catch (error) {
    return await failOrRetry(error, options);
  }
}

type ValidateOutcome =
  | { kind: 'ok'; probed: MediaMetadata }
  | { kind: 'transcode-required'; probed: MediaMetadata };

async function validateMedia(
  bundle: VideoProcessingBundle,
  ports: VideoProcessingPorts,
): Promise<ValidateOutcome> {
  const declared = bundle.declaredMetadata;
  const maxBytes = Math.min(
    VIDEO_MAX_BYTES,
    declared?.sizeBytes != null && declared.sizeBytes > 0 ? declared.sizeBytes : VIDEO_MAX_BYTES,
  );
  let downloaded: Awaited<ReturnType<VideoProcessingPorts['media']['download']>>;
  try {
    downloaded = await ports.media.download(bundle.videoDownloadUrl, maxBytes);
  } catch (error) {
    if (error instanceof VideoProcessingFailure) throw error;
    if (typeof error === 'object' && error !== null && 'sizeBoundExceeded' in error) {
      throw new VideoProcessingFailure(
        'metadata_mismatch',
        'downloaded bytes exceed the declared/hard size bound',
      );
    }
    // 下载基础设施错误（网络/超时/5xx）按可重试处理，交给 BullMQ。
    throw Object.assign(
      new Error(`video download failed: ${error instanceof Error ? error.message : String(error)}`),
      { retryable: true },
    );
  }
  try {
    if (declared?.sizeBytes != null && downloaded.bytes !== declared.sizeBytes) {
      throw new VideoProcessingFailure(
        'metadata_mismatch',
        'downloaded size differs from the declared upload size',
      );
    }
    let probed: MediaMetadata;
    try {
      probed = await ports.media.inspect(downloaded.filePath);
    } catch {
      throw new VideoProcessingFailure('probe_failed', 'ffprobe could not read the media');
    }
    if (!Number.isFinite(probed.durationSeconds) || probed.durationSeconds <= 0) {
      throw new VideoProcessingFailure('probe_failed', 'probed duration is unusable');
    }
    if (typeof probed.format !== 'string' || !probed.format.split(',').includes('mp4')) {
      throw new VideoProcessingFailure('unsupported_container', 'container is not mp4');
    }
    if (!probed.hasVideo) {
      throw new VideoProcessingFailure('unsupported_codec', 'media has no video stream');
    }
    if (probed.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
      throw new VideoProcessingFailure('duration_exceeded', 'video exceeds the 7200s limit');
    }
    if (declared?.durationSeconds != null) {
      const tolerance = Math.max(2, declared.durationSeconds * 0.01);
      if (Math.abs(probed.durationSeconds - declared.durationSeconds) > tolerance) {
        throw new VideoProcessingFailure(
          'metadata_mismatch',
          'probed duration differs from the declared duration',
        );
      }
    }
    if (probed.videoCodec !== 'h264') {
      // 非 H.264：不 fail，交给教师决策（transcode_required）。
      return { kind: 'transcode-required', probed };
    }
    return { kind: 'ok', probed };
  } finally {
    await downloaded.cleanup().catch(() => {});
  }
}

/**
 * 教师批准后的系统转码：下载源（HEVC 等）→ ffmpeg 转 H.264/AAC → ffprobe 复检
 * → 申请转码产物上传目标 → PUT 回 OSS。产物仍受 1 GiB / 120 分钟约束。
 */
async function transcodeMedia(
  bundle: VideoProcessingBundle,
  ports: VideoProcessingPorts,
): Promise<{ objectKey: string; probed: MediaMetadata }> {
  let downloaded: Awaited<ReturnType<VideoProcessingPorts['media']['download']>>;
  try {
    downloaded = await ports.media.download(bundle.videoDownloadUrl, VIDEO_MAX_BYTES);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'sizeBoundExceeded' in error) {
      throw new VideoProcessingFailure('metadata_mismatch', 'source exceeds the hard size bound');
    }
    throw Object.assign(
      new Error(
        `transcode source download failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { retryable: true },
    );
  }
  const output = await ports.media.allocateTempFile('.mp4');
  try {
    let transcodedBytes: number;
    try {
      transcodedBytes = await ports.media.transcodeToH264(
        downloaded.filePath,
        output.filePath,
        TRANSCODE_TIMEOUT_MS,
      );
    } catch {
      throw new VideoProcessingFailure('transcode_failed', 'ffmpeg could not transcode to h264');
    }
    if (transcodedBytes > VIDEO_MAX_BYTES) {
      throw new VideoProcessingFailure(
        'transcode_failed',
        'transcoded output exceeds the 1 GiB bound',
      );
    }
    let probed: MediaMetadata;
    try {
      probed = await ports.media.inspect(output.filePath);
    } catch {
      throw new VideoProcessingFailure('transcode_failed', 'transcoded output is not probeable');
    }
    if (!probed.hasVideo || probed.videoCodec !== 'h264') {
      throw new VideoProcessingFailure('transcode_failed', 'transcoded output is not h264');
    }
    if (probed.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
      throw new VideoProcessingFailure('duration_exceeded', 'video exceeds the 7200s limit');
    }
    const target = await ports.content.requestTranscodeTarget(transcodedBytes);
    try {
      await ports.media.upload(output.filePath, target.uploadUrl);
    } catch (error) {
      throw Object.assign(
        new Error(
          `transcoded upload failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { retryable: true },
      );
    }
    return { objectKey: target.objectKey, probed };
  } finally {
    await output.cleanup().catch(() => {});
    await downloaded.cleanup().catch(() => {});
  }
}

async function transcribe(
  mediaUrl: string,
  clientToken: string,
  ports: VideoProcessingPorts,
): Promise<VideoSubtitleCue[]> {
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = ports.now ?? Date.now;
  const { taskId } = await ports.asr.submit({ mediaUrl, clientToken });
  const deadline = now() + POLL_OVERALL_TIMEOUT_MS;
  let delay = POLL_INITIAL_DELAY_MS;
  for (;;) {
    if (now() >= deadline) {
      // 轮询超时按可重试处理：clientToken 幂等，重试会命中同一上游任务。
      throw Object.assign(new Error('subtitle task polling timed out'), { retryable: true });
    }
    await sleep(Math.min(delay, Math.max(0, deadline - now())));
    delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    const result = await ports.asr.query(taskId);
    if (result.status === 'completed') return sanitizeCues(result.cues ?? []);
    if (result.status === 'failed') {
      throw new VideoProcessingFailure(
        'transcription_failed',
        `subtitle task failed: ${result.failureCode ?? 'unknown'}`,
      );
    }
  }
}

/** model-service 已净化 cues；Runtime 侧再执行一次上限约束（条数/文本长度/时间边界）。 */
export function sanitizeCues(cues: readonly VideoSubtitleCue[]): VideoSubtitleCue[] {
  return cues
    .filter(
      (cue) =>
        Number.isSafeInteger(cue.startMs) &&
        Number.isSafeInteger(cue.endMs) &&
        cue.startMs >= 0 &&
        cue.endMs >= cue.startMs &&
        typeof cue.text === 'string',
    )
    .slice(0, VIDEO_MAX_SUBTITLE_CUES)
    .map((cue, index) => ({
      index,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text.slice(0, VIDEO_MAX_CUE_TEXT_LENGTH),
    }));
}

async function failOrRetry(error: unknown, options: VideoProcessingOptions): Promise<never> {
  const code = guardrailCode(error);
  if (code) {
    await recordFailureBestEffort('internal_error', options, code);
    throw new GuardrailError(code);
  }
  if (error instanceof VideoProcessingUnrecoverableError) throw error;
  const finalAttempt =
    options.execution !== undefined &&
    options.execution.attemptNumber >= options.execution.maxAttempts;
  if (error instanceof VideoProcessingFailure) {
    await recordFailureBestEffort(error.failureReason, options);
    throw new VideoProcessingUnrecoverableError(`${error.failureReason}: ${error.message}`, {
      cause: error,
    });
  }
  if (isRetryable(error) && !finalAttempt) throw error;
  // 非域内失败在最终尝试落为 internal_error，让教师可以从 failed 重试。
  await recordFailureBestEffort('internal_error', options);
  throw new VideoProcessingUnrecoverableError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

/** 失败回写尽力而为：回写本身失败只记日志，不吞掉原始错误。 */
async function recordFailureBestEffort(
  failureReason: string,
  options: VideoProcessingOptions,
  errorCode?: string,
): Promise<void> {
  const reason = VIDEO_FAILURE_REASONS.has(failureReason) ? failureReason : 'internal_error';
  try {
    await options.ports.content.recordState({ status: 'failed', failureReason: reason });
    await options.observer?.stateRecorded?.('failed', {
      failureReason: reason,
      ...(errorCode ? { errorCode } : {}),
    });
  } catch (callbackError) {
    console.error('video processing failure 回写失败', { failureReason: reason, callbackError });
  }
}

function toDeclaredShape(probed: MediaMetadata): VideoDeclaredMetadata {
  return {
    durationSeconds: Math.round(probed.durationSeconds),
    width: probed.width ?? null,
    height: probed.height ?? null,
    codec: probed.videoCodec ?? null,
    container: 'mp4',
    sizeBytes: null,
  };
}
