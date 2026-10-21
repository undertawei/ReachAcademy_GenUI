import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { convertPptxToPng, type FontMapping } from 'pptx-glimpse';

import {
  OfficeIngestionError,
  officeKindForMetadata,
  prepareOfficeDocument,
  type PreparedDocx,
  type PreparedOfficeImage,
  type PreparedPptx,
  type PreparedXlsx,
} from './office-ingestion.js';

export interface CommonFileReference {
  objectKey: string;
  name?: string;
  contentType?: string;
  sizeBytes?: number;
  downloadUrl?: string;
}

export type CommonFileEnv = Partial<Record<string, string | undefined>>;

export interface CommonFileExecutionContext {
  readonly attemptId?: string;
  readonly submissionId: string;
  readonly generationRunId?: string;
  readonly organizationId: string;
  readonly questionId?: string;
}

export interface ExtractedDocumentImage {
  data: string;
  mimeType: string;
  pageNumber?: number;
  description?: string;
}

export interface ExtractedDocumentEvidence {
  text: string;
  images: ExtractedDocumentImage[];
}

export type AttachmentToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface MediaMetadata {
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width?: number;
  height?: number;
  format?: string;
  videoCodec?: string;
}

export interface AttachmentIngestionDependencies {
  extractPdf(input: ManagedInput): Promise<ExtractedDocumentEvidence>;
  transcribeAudio(input: ManagedInput): Promise<string>;
  understandAudio(input: MediaUnderstandingInput): Promise<string>;
  understandVideo(input: MediaUnderstandingInput): Promise<string>;
  inspectMedia(path: string): Promise<MediaMetadata>;
  normalizeAudio(path: string, outputPath: string): Promise<number>;
  normalizeVideo(path: string, outputPath: string): Promise<number>;
  extractVideoAudio(path: string, outputPath: string): Promise<boolean>;
  renderPptxSlide?(input: PresentationSlideRenderInput): Promise<RenderedPresentationSlide>;
}

export interface PresentationSlideRenderInput {
  readonly bytes: Uint8Array;
  readonly sourceSlideNumber: number;
  readonly env: CommonFileEnv;
}

export interface RenderedPresentationSlide {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly diagnostics: readonly {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
  }[];
  readonly coverage: {
    skippedElements: number;
    unresolvedElements: number;
    fallbackElements: number;
    warnings: number;
  };
}

interface ManagedInput {
  filePath: string;
  filename: string;
  contentType: string;
  context: CommonFileExecutionContext;
  env: CommonFileEnv;
  fetch: typeof fetch;
}

interface MediaUnderstandingInput extends ManagedInput {
  task: string;
}

export interface AttachmentIngestionState {
  readonly cache: Map<string, Promise<AttachmentToolContent[]>>;
  readonly presentations: Map<string, Promise<PreparedPptx>>;
  readonly renderedPresentationSlides: Map<string, Promise<AttachmentToolContent[]>>;
  downloadedBytes: number;
  emittedTextChars: number;
  emittedImages: number;
  emittedImageBytes: number;
  mediaSeconds: number;
}

export interface AttachmentIngestionOptions {
  attachment: CommonFileReference;
  state: AttachmentIngestionState;
  context: CommonFileExecutionContext;
  env: CommonFileEnv;
  fetch: typeof fetch;
  analysisTask?: string;
  includeTranscript?: boolean;
  dependencies?: AttachmentIngestionDependencies;
}

export interface PresentationSlideIngestionOptions {
  attachment: CommonFileReference;
  slideNumber: number;
  state: AttachmentIngestionState;
  env: CommonFileEnv;
  dependencies?: AttachmentIngestionDependencies;
}

const MIB = 1024 * 1024;
export const ATTACHMENT_MAX_BYTES = 100 * MIB;
export const ATTACHMENT_AGGREGATE_MAX_BYTES = 200 * MIB;
export const ATTACHMENT_TEXT_MAX_CHARS = 12_000;
export const ATTACHMENT_AGGREGATE_TEXT_MAX_CHARS = 40_000;
export const ATTACHMENT_IMAGE_MAX_BYTES = 15 * MIB;
export const ATTACHMENT_AGGREGATE_MAX_IMAGES = 8;
export const ATTACHMENT_AGGREGATE_IMAGE_MAX_BYTES = 40 * MIB;
export const ATTACHMENT_PDF_MAX_BYTES = 50 * MIB;
export const ATTACHMENT_AUDIO_MAX_BYTES = 50 * MIB;
export const ATTACHMENT_NORMALIZED_AUDIO_MAX_BYTES = 20 * MIB;
export const ATTACHMENT_NORMALIZED_VIDEO_MAX_BYTES = 32 * MIB;
export const ATTACHMENT_MEDIA_MAX_SECONDS = 20 * 60;
const VIDEO_MAX_SECONDS = 10 * 60;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROCESS_TIMEOUT_MS = 120_000;
const VIDEO_PROCESS_TIMEOUT_MS = 300_000;
const MAX_PROCESS_OUTPUT_CHARS = 32_000;
const OFFICE_PROCESS_TIMEOUT_MS = 30_000;
const OFFICE_RENDER_TIMEOUT_MS = 45_000;

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.md',
  '.mjs',
  '.php',
  '.pl',
  '.properties',
  '.ps1',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const TEXT_APPLICATION_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/sql',
  'application/toml',
  'application/xml',
  'application/x-httpd-php',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
]);

export function createAttachmentIngestionState(): AttachmentIngestionState {
  return {
    cache: new Map(),
    presentations: new Map(),
    renderedPresentationSlides: new Map(),
    downloadedBytes: 0,
    emittedTextChars: 0,
    emittedImages: 0,
    emittedImageBytes: 0,
    mediaSeconds: 0,
  };
}

export function disposeAttachmentIngestionState(state: AttachmentIngestionState): void {
  state.cache.clear();
  state.presentations.clear();
  state.renderedPresentationSlides.clear();
}

export function ingestAttachment(
  options: AttachmentIngestionOptions,
): Promise<AttachmentToolContent[]> {
  const taskKey = options.analysisTask?.trim() ?? '';
  const cacheKey = [
    options.attachment.objectKey,
    taskKey,
    options.includeTranscript === true ? 'with-transcript' : 'without-transcript',
  ].join('\u0000');
  const cached = options.state.cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = ingestUncached(options).catch((error: unknown) => [
    limitation(options.attachment, classifyFailure(error), safeErrorMessage(error)),
  ]);
  options.state.cache.set(cacheKey, pending);
  return pending;
}

async function ingestUncached(
  options: AttachmentIngestionOptions,
): Promise<AttachmentToolContent[]> {
  const { attachment, state } = options;
  if (attachment.downloadUrl === undefined) {
    return [limitation(attachment, 'download_unavailable', 'content-service 未提供临时下载地址')];
  }
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes > ATTACHMENT_MAX_BYTES) {
    return [limitation(attachment, 'file_too_large', '文件超过 100 MiB 上传处理上限')];
  }
  if (
    attachment.sizeBytes !== undefined &&
    state.downloadedBytes + attachment.sizeBytes > ATTACHMENT_AGGREGATE_MAX_BYTES
  ) {
    return [limitation(attachment, 'aggregate_budget_exceeded', '本次反馈的附件总字节预算已用尽')];
  }

  const directory = join(
    tmpdir(),
    'reachany-ai-runtime-files',
    `${Date.now()}-${globalThis.crypto.randomUUID()}`,
  );
  const filename = safeFilename(attachment.name ?? basename(attachment.objectKey) ?? 'attachment');
  const filePath = join(directory, filename);
  try {
    const downloaded = await downloadToFile(options, directory, filePath);
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== downloaded.bytes) {
      return [
        limitation(attachment, 'metadata_mismatch', '下载文件大小与已核验的附件元数据不一致'),
      ];
    }
    const declaredType = normalizeContentType(
      attachment.contentType ?? downloaded.contentType ?? 'application/octet-stream',
    );
    const prefix = await readPrefix(filePath, 16);
    const kind = detectKind(declaredType, filename, prefix);
    const dependencies = options.dependencies;
    if (dependencies === undefined) {
      throw new IngestionError(
        'capability_unavailable',
        '公共文件能力缺少调用方提供的文档与媒体处理适配器',
      );
    }

    // 等待读取结束再进入 finally，避免清理线程提前删除仍在使用的文件。
    if (kind === 'text') return await processText(options, filePath, downloaded.bytes);
    if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
      const bytes = await readFile(filePath);
      const pending = withTimeout(
        prepareOfficeDocument(bytes, kind),
        OFFICE_PROCESS_TIMEOUT_MS,
        'Office 文档解析超过 30 秒上限',
      );
      const prepared = await pending;
      if (prepared.kind === 'docx')
        return docxEvidenceContents(options, prepared, downloaded.bytes);
      if (prepared.kind === 'xlsx')
        return xlsxEvidenceContents(options, prepared, downloaded.bytes);
      options.state.presentations.set(attachment.objectKey, Promise.resolve(prepared));
      return pptxIndexContents(options, prepared, downloaded.bytes);
    }
    if (kind === 'pdf') {
      if (downloaded.bytes > ATTACHMENT_PDF_MAX_BYTES) {
        return [limitation(attachment, 'processing_budget_exceeded', 'PDF 解析上限为 50 MiB')];
      }
      const extracted = await dependencies.extractPdf({
        filePath,
        filename,
        contentType: 'application/pdf',
        context: options.context,
        env: options.env,
        fetch: options.fetch,
      });
      return pdfEvidenceContents(options, extracted, downloaded.bytes);
    }
    if (kind === 'image') return await processImage(options, filePath, downloaded.bytes, prefix);
    if (kind === 'audio') {
      if (downloaded.bytes > ATTACHMENT_AUDIO_MAX_BYTES) {
        return [limitation(attachment, 'processing_budget_exceeded', '音频转写上限为 50 MiB')];
      }
      const metadata = await dependencies.inspectMedia(filePath);
      validateMediaBudget(options, metadata, false);
      const task = requireMediaUnderstandingTask(options);
      const normalizedPath = join(directory, 'audio-understanding.mp3');
      const normalizedBytes = await dependencies.normalizeAudio(filePath, normalizedPath);
      validateNormalizedMediaSize(
        normalizedBytes,
        ATTACHMENT_NORMALIZED_AUDIO_MAX_BYTES,
        '音频受控副本超过 20 MiB 处理上限',
      );
      const input = {
        filePath: normalizedPath,
        filename: filename.replace(/\.[^.]+$/, '') + '-normalized.mp3',
        contentType: 'audio/mpeg',
        context: options.context,
        env: options.env,
        fetch: options.fetch,
        task,
      };
      const understanding = await dependencies.understandAudio(input);
      const contents = [evidenceText(options, 'audio_understanding', understanding, metadata)];
      if (options.includeTranscript === true) {
        try {
          const transcript = await dependencies.transcribeAudio(input);
          contents.push(evidenceText(options, 'audio_transcript', transcript, metadata));
        } catch {
          contents.push(
            limitation(attachment, 'transcription_failed', '音频理解已完成，但可选逐字稿生成失败'),
          );
        }
      }
      return contents;
    }
    if (kind === 'video') {
      const metadata = await dependencies.inspectMedia(filePath);
      validateMediaBudget(options, metadata, true);
      const task = requireMediaUnderstandingTask(options);
      const normalizedPath = join(directory, 'video-understanding.mp4');
      const normalizedBytes = await dependencies.normalizeVideo(filePath, normalizedPath);
      validateNormalizedMediaSize(
        normalizedBytes,
        ATTACHMENT_NORMALIZED_VIDEO_MAX_BYTES,
        '视频受控副本超过 32 MiB 处理上限',
      );
      const understanding = await dependencies.understandVideo({
        filePath: normalizedPath,
        filename: filename.replace(/\.[^.]+$/, '') + '-normalized.mp4',
        contentType: 'video/mp4',
        context: options.context,
        env: options.env,
        fetch: options.fetch,
        task,
      });
      const contents: AttachmentToolContent[] = [
        evidenceText(options, 'video_understanding', understanding, metadata),
      ];
      if (metadata.hasAudio && options.includeTranscript === true) {
        const audioPath = join(directory, 'audio.mp3');
        if (await dependencies.extractVideoAudio(normalizedPath, audioPath)) {
          try {
            const audioBytes = (await stat(audioPath)).size;
            validateNormalizedMediaSize(
              audioBytes,
              ATTACHMENT_NORMALIZED_AUDIO_MAX_BYTES,
              '视频音轨受控副本超过 20 MiB ASR 上限',
            );
            const transcript = await dependencies.transcribeAudio({
              filePath: audioPath,
              filename: filename.replace(/\.[^.]+$/, '') + '-audio.mp3',
              contentType: 'audio/mpeg',
              context: options.context,
              env: options.env,
              fetch: options.fetch,
            });
            contents.push(evidenceText(options, 'video_audio_transcript', transcript, metadata));
          } catch {
            contents.push(
              limitation(
                attachment,
                'transcription_failed',
                '视频理解已完成，但可选音轨逐字稿生成失败',
              ),
            );
          }
        } else {
          contents.push(
            limitation(attachment, 'transcription_failed', '视频理解已完成，但可选音轨预处理失败'),
          );
        }
      }
      return contents;
    }
    return [
      limitation(attachment, 'unsupported_type', `不支持的附件类型 ${declaredType || '(未知)'}`),
    ];
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function renderPresentationSlide(
  options: PresentationSlideIngestionOptions,
): Promise<AttachmentToolContent[]> {
  if (!options.state.presentations.has(options.attachment.objectKey)) {
    return Promise.resolve([
      limitation(
        options.attachment,
        'presentation_not_prepared',
        '请先调用 read_attachment 获取 PPTX 逐页文字索引，再按需渲染页面',
      ),
    ]);
  }
  const cacheKey = `${options.attachment.objectKey}\u0000${options.slideNumber}`;
  const cached = options.state.renderedPresentationSlides.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = renderPresentationSlideUncached(options).catch((error: unknown) => [
    limitation(options.attachment, classifyFailure(error), safeErrorMessage(error)),
  ]);
  options.state.renderedPresentationSlides.set(cacheKey, pending);
  return pending;
}

async function renderPresentationSlideUncached(
  options: PresentationSlideIngestionOptions,
): Promise<AttachmentToolContent[]> {
  if (!Number.isSafeInteger(options.slideNumber) || options.slideNumber < 1) {
    throw new IngestionError('invalid_slide_number', '幻灯片页码必须是从 1 开始的整数');
  }
  const preparedPending = options.state.presentations.get(options.attachment.objectKey);
  if (preparedPending === undefined) {
    throw new IngestionError(
      'presentation_not_prepared',
      '请先调用 read_attachment 获取 PPTX 逐页文字索引，再按需渲染页面',
    );
  }
  const prepared = await preparedPending;
  const slide = prepared.slides[options.slideNumber - 1];
  if (slide === undefined) {
    throw new IngestionError(
      'invalid_slide_number',
      `可见幻灯片页码超出范围；有效范围为 1-${prepared.slides.length}`,
    );
  }
  if (options.state.emittedImages >= ATTACHMENT_AGGREGATE_MAX_IMAGES) {
    throw new IngestionError('aggregate_budget_exceeded', '本次反馈的图片数量预算已用尽');
  }
  const renderer = options.dependencies?.renderPptxSlide ?? renderPptxSlide;
  const rendered = await withTimeout(
    renderer({
      bytes: prepared.bytes,
      sourceSlideNumber: slide.sourceSlideNumber,
      env: options.env,
    }),
    OFFICE_RENDER_TIMEOUT_MS,
    'PPTX 单页渲染超过 45 秒上限',
  );
  if (rendered.png.byteLength === 0 || rendered.png.byteLength > ATTACHMENT_IMAGE_MAX_BYTES) {
    throw new IngestionError('processing_budget_exceeded', 'PPTX 单页 PNG 超过 15 MiB 图片上限');
  }
  if (
    options.state.emittedImageBytes + rendered.png.byteLength >
    ATTACHMENT_AGGREGATE_IMAGE_MAX_BYTES
  ) {
    throw new IngestionError('aggregate_budget_exceeded', '本次反馈的图片字节预算已用尽');
  }
  options.state.emittedImages += 1;
  options.state.emittedImageBytes += rendered.png.byteLength;
  const diagnostics = rendered.diagnostics
    .filter((diagnostic) => diagnostic.severity !== 'info')
    .slice(0, 20);
  const contents: AttachmentToolContent[] = [
    evidenceText(options, 'pptx_slide', slide.text, {
      slideNumber: slide.slideNumber,
      sourceSlideNumber: slide.sourceSlideNumber,
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.png.byteLength,
      previewOnly: true,
      diagnostics,
      supportCoverage: rendered.coverage,
    }),
    { type: 'image', data: Buffer.from(rendered.png).toString('base64'), mimeType: 'image/png' },
  ];
  if (
    diagnostics.length > 0 ||
    rendered.coverage.skippedElements > 0 ||
    rendered.coverage.unresolvedElements > 0 ||
    rendered.coverage.fallbackElements > 0
  ) {
    contents.push(
      limitation(
        options.attachment,
        'presentation_render_degraded',
        '该页是高质量预览而非 PowerPoint 像素权威输出；部分元素使用降级、跳过或缺字回退，请结合当页文字判断',
      ),
    );
  }
  return contents;
}

async function renderPptxSlide(
  input: PresentationSlideRenderInput,
): Promise<RenderedPresentationSlide> {
  const configuredFontDir = input.env.AI_RUNTIME_OFFICE_FONT_DIR?.trim();
  const fontDirs = configuredFontDir
    ? configuredFontDir
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [AI_RUNTIME_OFFICE_FONT_DIR_DEFAULT];
  const report = await convertPptxToPng(input.bytes, {
    slides: [input.sourceSlideNumber],
    width: 1280,
    logLevel: 'off',
    fontDirs,
    skipSystemFonts: true,
    fontMapping: AI_RUNTIME_OFFICE_FONT_MAPPING,
  });
  const slide = report.slides[0];
  if (slide === undefined) {
    throw new IngestionError('presentation_render_failed', 'PPTX 指定页面未生成 PNG');
  }
  const coverage = report.supportCoverage.slides.find(
    (entry) => entry.slideNumber === input.sourceSlideNumber,
  );
  return {
    png: slide.png,
    width: slide.width,
    height: slide.height,
    diagnostics: report.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
    })),
    coverage: {
      skippedElements: coverage?.skippedElements ?? 0,
      unresolvedElements: coverage?.unresolvedElements ?? 0,
      fallbackElements: coverage?.fallbackElements ?? 0,
      warnings: coverage?.warnings ?? 0,
    },
  };
}

export const AI_RUNTIME_OFFICE_FONT_DIR_DEFAULT =
  '/usr/share/fonts/reachany/reach-fonts-2026-08-04';

export const AI_RUNTIME_OFFICE_FONT_MAPPING: FontMapping = {
  'Microsoft YaHei': 'Source Han Sans VF',
  'Microsoft YaHei UI': 'Source Han Sans VF',
  SimHei: 'Source Han Sans VF',
  DengXian: 'Alibaba PuHuiTi 3.0',
  'PingFang SC': 'Source Han Sans VF',
  'Heiti SC': 'Source Han Sans VF',
  Meiryo: 'Source Han Sans VF',
  'Yu Gothic': 'Source Han Sans VF',
  'Malgun Gothic': 'Source Han Sans VF',
  SimSun: 'Source Han Serif SC',
  NSimSun: 'Source Han Serif SC',
  'Songti SC': 'Source Han Serif SC',
  FangSong: 'Zhuque Fangsong (technical preview)',
  KaiTi: 'LXGW WenKai',
  Arial: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  Calibri: 'Carlito',
  'Calibri Light': 'Carlito',
  'Cambria Math': 'STIX Two Math',
  ISOCP: 'osifont',
  ISOCPEUR: 'osifont',
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new IngestionError('timeout', message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function downloadToFile(
  options: AttachmentIngestionOptions,
  directory: string,
  filePath: string,
): Promise<{ bytes: number; contentType?: string }> {
  await mkdir(directory, { recursive: true });
  const response = await options.fetch(options.attachment.downloadUrl!, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new IngestionError('download_failed', `下载返回 HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > ATTACHMENT_MAX_BYTES) {
    throw new IngestionError('file_too_large', '文件超过 100 MiB 上传处理上限');
  }
  if (response.body === null) throw new IngestionError('download_failed', '下载响应没有内容');

  const handle = await open(filePath, 'wx');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > ATTACHMENT_MAX_BYTES) {
        await reader.cancel();
        throw new IngestionError('file_too_large', '文件超过 100 MiB 上传处理上限');
      }
      if (options.state.downloadedBytes + value.byteLength > ATTACHMENT_AGGREGATE_MAX_BYTES) {
        await reader.cancel();
        throw new IngestionError('aggregate_budget_exceeded', '本次反馈的附件总字节预算已用尽');
      }
      await handle.write(value);
      bytes += value.byteLength;
      options.state.downloadedBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  return { bytes, contentType: response.headers.get('content-type') ?? undefined };
}

async function processText(
  options: AttachmentIngestionOptions,
  filePath: string,
  bytes: number,
): Promise<AttachmentToolContent[]> {
  const remaining = ATTACHMENT_AGGREGATE_TEXT_MAX_CHARS - options.state.emittedTextChars;
  if (remaining <= 0) {
    return [
      limitation(options.attachment, 'aggregate_budget_exceeded', '本次反馈的文本预算已用尽'),
    ];
  }
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(bytes, 256 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      return [limitation(options.attachment, 'corrupt_or_binary', '文本附件包含二进制空字节')];
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    return [evidenceText(options, 'text', decoded, { bytes })];
  } finally {
    await handle.close();
  }
}

async function processImage(
  options: AttachmentIngestionOptions,
  filePath: string,
  bytes: number,
  prefix: Uint8Array,
): Promise<AttachmentToolContent[]> {
  if (bytes > ATTACHMENT_IMAGE_MAX_BYTES) {
    return [limitation(options.attachment, 'processing_budget_exceeded', '图片理解上限为 15 MiB')];
  }
  if (options.state.emittedImages >= ATTACHMENT_AGGREGATE_MAX_IMAGES) {
    return [
      limitation(options.attachment, 'aggregate_budget_exceeded', '本次反馈的图片预算已用尽'),
    ];
  }
  if (options.state.emittedImageBytes + bytes > ATTACHMENT_AGGREGATE_IMAGE_MAX_BYTES) {
    return [
      limitation(options.attachment, 'aggregate_budget_exceeded', '本次反馈的图片字节预算已用尽'),
    ];
  }
  const mimeType = sniffImageType(prefix);
  const data = await readFile(filePath);
  options.state.emittedImages += 1;
  options.state.emittedImageBytes += data.byteLength;
  return [
    evidenceText(options, 'image', '', { bytes, mimeType }),
    { type: 'image', data: data.toString('base64'), mimeType },
  ];
}

function docxEvidenceContents(
  options: AttachmentIngestionOptions,
  prepared: PreparedDocx,
  bytes: number,
): AttachmentToolContent[] {
  const text = prepared.blocks
    .map((block) => (block.type === 'text' ? block.text : `[${block.image.description}]`))
    .join('\n');
  const images = prepared.blocks
    .filter(
      (block): block is Extract<PreparedDocx['blocks'][number], { type: 'image' }> =>
        block.type === 'image',
    )
    .map((block) => block.image);
  const contents: AttachmentToolContent[] = [
    evidenceText(options, 'docx_body', text, {
      bytes,
      embeddedImageCount: images.length,
      warnings: prepared.warnings,
    }),
  ];
  appendOfficeImages(options, contents, images, 'DOCX');
  if (prepared.warnings.some((warning) => warning !== 'image_mime_corrected')) {
    contents.push(
      limitation(
        options.attachment,
        'office_content_partially_unsupported',
        'DOCX 含未完整支持的内容；已保留可读取正文和受支持图片',
      ),
    );
  }
  return contents;
}

function xlsxEvidenceContents(
  options: AttachmentIngestionOptions,
  prepared: PreparedXlsx,
  bytes: number,
): AttachmentToolContent[] {
  return [
    evidenceText(options, 'xlsx_visible_cells', prepared.text, {
      bytes,
      visibleSheetCount: prepared.visibleSheetCount,
      cellCount: prepared.cellCount,
      formulasExecuted: false,
    }),
  ];
}

function pptxIndexContents(
  options: AttachmentIngestionOptions,
  prepared: PreparedPptx,
  bytes: number,
): AttachmentToolContent[] {
  const text = prepared.slides
    .map((slide) => `[幻灯片 ${slide.slideNumber}]\n${slide.text || '(无可提取文字)'}`)
    .join('\n\n');
  return [
    evidenceText(options, 'pptx_slide_text_index', text, {
      bytes,
      visibleSlideCount: prepared.slides.length,
      hiddenSlideCount: prepared.hiddenSlideCount,
      pagesRendered: 0,
      renderTool: 'render_presentation_slide',
      previewOnlyWhenRendered: true,
    }),
  ];
}

function appendOfficeImages(
  options: AttachmentIngestionOptions,
  contents: AttachmentToolContent[],
  images: readonly PreparedOfficeImage[],
  label: string,
): void {
  for (const [index, image] of images.entries()) {
    if (options.state.emittedImages >= ATTACHMENT_AGGREGATE_MAX_IMAGES) {
      contents.push(
        limitation(options.attachment, 'aggregate_budget_exceeded', `${label} 图片证据预算已用尽`),
      );
      return;
    }
    const data = Buffer.from(image.data, 'base64');
    if (options.state.emittedImageBytes + data.byteLength > ATTACHMENT_AGGREGATE_IMAGE_MAX_BYTES) {
      contents.push(
        limitation(options.attachment, 'aggregate_budget_exceeded', `${label} 图片字节预算已用尽`),
      );
      return;
    }
    options.state.emittedImages += 1;
    options.state.emittedImageBytes += data.byteLength;
    contents.push(
      evidenceText(options, 'docx_image', image.description, {
        index,
        bytes: data.byteLength,
        mimeType: image.mimeType,
      }),
      { type: 'image', data: image.data, mimeType: image.mimeType },
    );
  }
}

function pdfEvidenceContents(
  options: AttachmentIngestionOptions,
  extracted: ExtractedDocumentEvidence,
  bytes: number,
): AttachmentToolContent[] {
  const contents: AttachmentToolContent[] = [
    evidenceText(options, 'pdf_text', extracted.text, {
      bytes,
      extractedImageCount: extracted.images.length,
    }),
  ];
  for (const [index, image] of extracted.images.entries()) {
    if (options.state.emittedImages >= ATTACHMENT_AGGREGATE_MAX_IMAGES) {
      contents.push(
        limitation(options.attachment, 'aggregate_budget_exceeded', 'PDF 图片证据预算已用尽'),
      );
      break;
    }
    const mimeType = normalizeContentType(image.mimeType);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) continue;
    const data = Buffer.from(image.data, 'base64');
    if (data.byteLength === 0 || data.byteLength > ATTACHMENT_IMAGE_MAX_BYTES) continue;
    if (options.state.emittedImageBytes + data.byteLength > ATTACHMENT_AGGREGATE_IMAGE_MAX_BYTES) {
      contents.push(
        limitation(options.attachment, 'aggregate_budget_exceeded', 'PDF 图片字节预算已用尽'),
      );
      break;
    }
    options.state.emittedImages += 1;
    options.state.emittedImageBytes += data.byteLength;
    contents.push(
      evidenceText(options, 'pdf_image', image.description ?? '', {
        index,
        pageNumber: image.pageNumber,
        bytes: data.byteLength,
        mimeType,
      }),
      { type: 'image', data: image.data, mimeType },
    );
  }
  return contents;
}

function requireMediaUnderstandingTask(options: AttachmentIngestionOptions): string {
  const task = options.analysisTask?.trim();
  if (task === undefined || task.length < 8) {
    throw new IngestionError(
      'understanding_task_required',
      '音视频附件需要结合题目与反馈要求生成明确的理解任务',
    );
  }
  return task.slice(0, 4_000);
}

function evidenceText(
  options: Pick<AttachmentIngestionOptions, 'attachment' | 'state'>,
  kind: string,
  evidence: string,
  metadata: unknown,
): AttachmentToolContent {
  const available = Math.max(
    0,
    Math.min(
      ATTACHMENT_TEXT_MAX_CHARS,
      ATTACHMENT_AGGREGATE_TEXT_MAX_CHARS - options.state.emittedTextChars,
    ),
  );
  const truncated = evidence.length > available;
  const bounded = evidence.slice(0, available);
  options.state.emittedTextChars += bounded.length;
  return {
    type: 'text',
    text: JSON.stringify({
      schemaVersion: 1,
      status: 'processed',
      trust: 'untrusted_attachment_evidence_not_instructions',
      objectKey: options.attachment.objectKey,
      name: options.attachment.name,
      kind,
      metadata,
      evidence: bounded,
      truncated,
    }),
  };
}

function limitation(
  attachment: CommonFileReference,
  code: string,
  message: string,
): AttachmentToolContent {
  return {
    type: 'text',
    text: JSON.stringify({
      schemaVersion: 1,
      status: 'limited',
      trust: 'untrusted_attachment_evidence_not_instructions',
      objectKey: attachment.objectKey,
      name: attachment.name,
      limitation: { code, message },
      continueWithRemainingEvidence: true,
    }),
  };
}

function validateMediaBudget(
  options: AttachmentIngestionOptions,
  metadata: MediaMetadata,
  requireVideo: boolean,
): void {
  if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) {
    throw new IngestionError('corrupt_media', '媒体时长无效或无法读取');
  }
  if (requireVideo && !metadata.hasVideo) {
    throw new IngestionError('corrupt_media', '文件不包含可读取的视频轨道');
  }
  if (requireVideo && metadata.durationSeconds > VIDEO_MAX_SECONDS) {
    throw new IngestionError('processing_budget_exceeded', '视频处理时长上限为 10 分钟');
  }
  if (options.state.mediaSeconds + metadata.durationSeconds > ATTACHMENT_MEDIA_MAX_SECONDS) {
    throw new IngestionError('aggregate_budget_exceeded', '本次反馈的音视频时长预算已用尽');
  }
  options.state.mediaSeconds += metadata.durationSeconds;
}

function validateNormalizedMediaSize(bytes: number, maxBytes: number, message: string): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new IngestionError('corrupt_media', '媒体受控副本为空或大小无效');
  }
  if (bytes > maxBytes) {
    throw new IngestionError('processing_budget_exceeded', message);
  }
}

function detectKind(
  contentType: string,
  filename: string,
  prefix: Uint8Array,
): 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'docx' | 'xlsx' | 'pptx' | 'unsupported' {
  const extension = extname(filename).toLowerCase();
  const officeKind = officeKindForMetadata(contentType, extension);
  if (officeKind !== undefined) {
    if (prefix[0] !== 0x50 || prefix[1] !== 0x4b) {
      throw new IngestionError('metadata_mismatch', 'Office 声明与 OOXML ZIP 文件签名不匹配');
    }
    return officeKind;
  }
  if (contentType === 'application/pdf' || extension === '.pdf') {
    if (String.fromCharCode(...prefix.slice(0, 4)) !== '%PDF') {
      throw new IngestionError('metadata_mismatch', 'PDF 声明与文件签名不匹配');
    }
    return 'pdf';
  }
  if (contentType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    sniffImageType(prefix);
    return 'image';
  }
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/') || extension === '.mp4' || extension === '.webm')
    return 'video';
  if (
    contentType.startsWith('text/') ||
    TEXT_APPLICATION_MIME_TYPES.has(contentType) ||
    ((contentType === '' || contentType === 'application/octet-stream') &&
      TEXT_EXTENSIONS.has(extension))
  ) {
    return 'text';
  }
  return 'unsupported';
}

function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  throw new IngestionError('metadata_mismatch', '图片声明与 PNG/JPEG/WebP 文件签名不匹配');
}

async function readPrefix(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function safeFilename(value: string): string {
  const safe = basename(value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 160);
  return safe.length > 0 && safe !== '.' && safe !== '..' ? safe : 'attachment.bin';
}

class IngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function classifyFailure(error: unknown): string {
  if (error instanceof IngestionError) return error.code;
  if (error instanceof OfficeIngestionError) return error.code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'processing_failed';
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof IngestionError) return error.message;
  if (error instanceof OfficeIngestionError) return error.message;
  return '附件预处理失败；已跳过该文件并继续处理其余证据';
}

export function createAttachmentIngestionDependencies(
  remote: Pick<
    AttachmentIngestionDependencies,
    'extractPdf' | 'transcribeAudio' | 'understandAudio' | 'understandVideo'
  >,
): AttachmentIngestionDependencies {
  return {
    ...remote,
    inspectMedia,
    normalizeAudio,
    normalizeVideo,
    extractVideoAudio,
    renderPptxSlide,
  };
}

async function inspectMedia(path: string): Promise<MediaMetadata> {
  const output = await runProcess('ffprobe', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-show_entries',
    'format=duration,format_name:stream=codec_type,codec_name,width,height',
    '-of',
    'json',
    path,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IngestionError('corrupt_media', 'ffprobe 未返回有效媒体信息');
  }
  const record = asRecord(parsed);
  const format = asRecord(record?.format);
  const streams = Array.isArray(record?.streams) ? record.streams.map(asRecord) : [];
  const durationSeconds = Number(format?.duration);
  const video = streams.find((stream) => stream?.codec_type === 'video');
  return {
    durationSeconds,
    hasAudio: streams.some((stream) => stream?.codec_type === 'audio'),
    hasVideo: video !== undefined,
    width: typeof video?.width === 'number' ? video.width : undefined,
    height: typeof video?.height === 'number' ? video.height : undefined,
    format: typeof format?.format_name === 'string' ? format.format_name : undefined,
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : undefined,
  };
}

/** 供视频处理场景直接复用的 ffprobe 探测入口（与附件摄取共用同一实现）。 */
export const inspectMediaFile: (path: string) => Promise<MediaMetadata> = inspectMedia;

/** 视频片段受控副本的字节上限（与整段视频 normalize 上限一致）。 */
export const EXTRACTED_CLIP_MAX_BYTES = ATTACHMENT_NORMALIZED_VIDEO_MAX_BYTES;
const CLIP_PROCESS_TIMEOUT_MS = 100_000;

/**
 * 按窗口裁剪远端签名 URL 视频为受控低码率副本（镜像 normalizeVideo 的编码参数）。
 * <p>
 * 数据源：无 PG/Mongo 读写；输入为对象存储短时效签名 GET URL，输出写调用方 temp 目录。
 * <p>
 * 核心逻辑：
 * 1. `-ss` 置于 `-i` 之前做输入侧快速定位（HTTP Range），`-t` 限定片段时长；
 * 2. 复用 normalizeVideo 的缩放/帧率/码率参数，产出 ≤32 MiB 的 mp4 受控副本；
 * 3. 超过字节上限或 ffmpeg 失败/超时抛 IngestionError 安全原因码（不含原始 URL/stderr 全文）。
 */
export async function extractVideoClip(
  sourceUrl: string,
  startSeconds: number,
  endSeconds: number,
  outputPath: string,
  timeoutMs = CLIP_PROCESS_TIMEOUT_MS,
): Promise<number> {
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    throw new IngestionError('processing_budget_exceeded', '视频片段窗口无效');
  }
  try {
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe,http,https,tcp,tls',
        '-ss',
        String(startSeconds),
        '-t',
        String(endSeconds - startSeconds),
        '-i',
        sourceUrl,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-sn',
        '-vf',
        "scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=10",
        '-codec:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '30',
        '-maxrate',
        '320k',
        '-bufsize',
        '640k',
        '-pix_fmt',
        'yuv420p',
        '-codec:a',
        'aac',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '48k',
        '-map_metadata',
        '-1',
        '-movflags',
        '+faststart',
        '-threads',
        '2',
        '-y',
        outputPath,
      ],
      timeoutMs,
    );
  } catch (error) {
    // stderr 可能包含签名 URL；对外只保留安全原因码与固定文案。
    const code = error instanceof IngestionError ? error.code : 'processing_failed';
    throw new IngestionError(code === 'corrupt_media' ? 'corrupt_media' : code, '视频片段裁剪失败');
  }
  const bytes = (await stat(outputPath)).size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new IngestionError('corrupt_media', '视频片段受控副本为空或大小无效');
  }
  if (bytes > EXTRACTED_CLIP_MAX_BYTES) {
    throw new IngestionError('processing_budget_exceeded', '视频片段受控副本超过 32 MiB 上限');
  }
  return bytes;
}

/**
 * 课程视频整片转码为 H.264/AAC mp4（issue #104 转码扩展）。
 *
 * 核心逻辑：
 * 1. 输入是 worker 已下载到本地的完整源文件（HEVC/VP9 等非 h264 编码）；
 * 2. libx264 veryfast + CRF 23 保原分辨率帧率，音轨转 AAC，faststart 便于流式播放；
 * 3. 失败/超时抛 IngestionError 安全原因码（不含源路径/stderr 全文）；产物大小由调用方复检。
 */
export async function transcodeVideoToH264(
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<number> {
  try {
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-sn',
        '-codec:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-codec:a',
        'aac',
        '-b:a',
        '128k',
        '-map_metadata',
        '-1',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ],
      timeoutMs,
    );
  } catch (error) {
    const code = error instanceof IngestionError ? error.code : 'processing_failed';
    throw new IngestionError(code === 'timeout' ? 'timeout' : 'corrupt_media', '课程视频转码失败');
  }
  const bytes = (await stat(outputPath)).size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new IngestionError('corrupt_media', '课程视频转码产物为空或大小无效');
  }
  return bytes;
}

async function extractVideoAudio(path: string, outputPath: string): Promise<boolean> {
  try {
    await runProcess('ffmpeg', [
      '-v',
      'error',
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      '-y',
      outputPath,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function normalizeAudio(path: string, outputPath: string): Promise<number> {
  await runProcess('ffmpeg', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '64k',
    '-map_metadata',
    '-1',
    '-y',
    outputPath,
  ]);
  return (await stat(outputPath)).size;
}

async function normalizeVideo(path: string, outputPath: string): Promise<number> {
  await runProcess(
    'ffmpeg',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-sn',
      '-vf',
      "scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=10",
      '-codec:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-maxrate',
      '320k',
      '-bufsize',
      '640k',
      '-pix_fmt',
      'yuv420p',
      '-codec:a',
      'aac',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      '-map_metadata',
      '-1',
      '-movflags',
      '+faststart',
      '-threads',
      '2',
      '-y',
      outputPath,
    ],
    VIDEO_PROCESS_TIMEOUT_MS,
  );
  return (await stat(outputPath)).size;
}

function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new IngestionError('timeout', `${command} 处理超时`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_PROCESS_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_PROCESS_OUTPUT_CHARS);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new IngestionError('processor_unavailable', `${command} 无法启动：${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(new IngestionError('corrupt_media', `${command} 处理失败：${stderr.slice(-500)}`));
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
