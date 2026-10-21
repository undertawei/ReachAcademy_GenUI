import sharp from 'sharp';

import type { RunRecord } from './contracts.js';
import { domainGet, studentApiUrl } from './domain-client.js';
import { isRuntimeMockMode, type RuntimeEnv } from './env.js';
import type { TutorPageMediaRef } from './tutor-deck-pages.js';
import { optionalRecord } from './tutor-tool-support.js';

/** 单张源图的下载上限、解码像素上限与下载超时。 */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const DOWNLOAD_TIMEOUT_MS = 8_000;
/** 送入模型前统一缩放到长边 1024 像素的 JPEG，控制视觉 token 与请求体积。 */
const MODEL_IMAGE_EDGE = 1024;
const MODEL_IMAGE_QUALITY = 80;

export interface TutorPageImage {
  label: string;
  alt: string;
  data: string;
  mimeType: 'image/jpeg';
}

export interface TutorPageImages {
  images: TutorPageImage[];
  skipped: number;
}

/**
 * 下载当前页图片，供 Tutor 成员提示词图文混排。
 *
 * 数据源：verifiedContext.currentPageMedia（服务端再解析的已发布媒体引用）；
 * student-service `/my/track-modules/{selectionId}/reach-deck-media/presign-download`（以学生身份换签）。
 * 核心逻辑：
 * 1. 只处理学生普通 Reach Deck Run，且媒体引用来自服务端解析的当前页；
 * 2. 逐张以 selection 绑定的发布文档换签，下载并限制字节数与像素数；
 * 3. 统一转为长边 1024 的 JPEG（透明背景铺白）后编码为 base64；
 * 4. 任一张失败只计入 skipped，摘要中的文字占位仍然保留，不影响本次回答。
 */
export async function loadTutorPageImages(
  run: RunRecord,
  verifiedContext: Record<string, unknown>,
  env: RuntimeEnv,
  signal?: AbortSignal,
): Promise<TutorPageImages> {
  const selectionId = run.domainScope.selectionId;
  const refs = mediaRefs(verifiedContext.currentPageMedia);
  if (
    isRuntimeMockMode(env) ||
    !selectionId ||
    run.input.learningContext?.schemaVersion !== 'reach-deck-tutor-context/v1' ||
    refs.length === 0
  ) {
    return { images: [], skipped: 0 };
  }
  const settled = await Promise.allSettled(
    refs.map(async (ref): Promise<TutorPageImage> => {
      const ticket = optionalRecord(
        await domainGet(
          studentApiUrl(
            `/my/track-modules/${encodeURIComponent(selectionId)}/reach-deck-media/presign-download` +
              `?objectKey=${encodeURIComponent(ref.objectKey)}&disposition=inline`,
            env,
          ),
          run,
          { env, ...(signal ? { signal } : {}) },
        ),
      );
      const downloadUrl = ticket?.downloadUrl;
      if (typeof downloadUrl !== 'string' || !/^https?:\/\//.test(downloadUrl)) {
        throw new Error('Reach Deck media download ticket is invalid');
      }
      const source = await downloadImage(downloadUrl, signal);
      const data = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .rotate()
        .resize(MODEL_IMAGE_EDGE, MODEL_IMAGE_EDGE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: MODEL_IMAGE_QUALITY })
        .toBuffer();
      return {
        label: ref.label,
        alt: ref.alt,
        data: data.toString('base64'),
        mimeType: 'image/jpeg',
      };
    }),
  );
  signal?.throwIfAborted();
  const images = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  return { images, skipped: settled.length - images.length };
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Reach Deck media download returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_SOURCE_BYTES) throw new Error('Reach Deck media is too large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Reach Deck media is too large');
  return bytes;
}

function mediaRefs(value: unknown): TutorPageMediaRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const ref = optionalRecord(candidate);
    return typeof ref?.label === 'string' &&
      typeof ref.resourceId === 'string' &&
      typeof ref.objectKey === 'string' &&
      ref.objectKey !== ''
      ? [
          {
            label: ref.label,
            resourceId: ref.resourceId,
            alt: typeof ref.alt === 'string' ? ref.alt : '',
            objectKey: ref.objectKey,
          },
        ]
      : [];
  });
}
