import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  buildReachDeckMediaResourceForObjectKey,
  type ReachDeckTransformV2,
} from '@reachany/reach-deck-dsl';
import { Type } from 'typebox';

import { ReachDeckModelToolError } from '../model-service-tools.js';
import {
  DecksmithSessionError,
  findDecksmithNativeElement,
  type DecksmithDocumentSession,
} from './session.js';

const TRANSIENT_IMAGE_RETRY_DELAY_MS = 1500;

/**
 * 图片上游（RouterLink）偶发连接失败会瞬间报错，而几秒后的下一次调用通常就成功
 * （测试环境 2026-10-02 同一页 4 次失败均如此）。不重试时 Decksmith 只能告诉教师"失败了"
 * 或改做别的编辑，所以对可重试错误在工具内部再试一次；仍失败才交还给模型。
 */
export async function retryTransientImageFailure<T>(
  run: () => Promise<T>,
  options: { signal?: AbortSignal; delayMs?: number } = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      !(error instanceof ReachDeckModelToolError) ||
      !error.retryable ||
      options.signal?.aborted === true
    ) {
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, options.delayMs ?? TRANSIENT_IMAGE_RETRY_DELAY_MS);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? error);
        },
        { once: true },
      );
    });
    return run();
  }
}

export interface DecksmithMediaAsset {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  cached?: boolean;
}

export interface DecksmithMediaToolDependencies {
  generateImage(input: {
    toolCallId: string;
    pageId: string;
    targetId: string;
    prompt: string;
    size?: '1024x1024' | '1536x1024' | '1024x1536';
  }): Promise<DecksmithMediaAsset>;
  /**
   * 以元素当前图片为参考做编辑。source 来自会话当前文档（含本轮早先生成的资源），
   * 依赖方负责取图授权、下载校验、调用编辑模型并把结果存为新的生成媒体。
   */
  editImage(input: {
    toolCallId: string;
    pageId: string;
    targetId: string;
    instruction: string;
    source: DecksmithImageEditSource;
  }): Promise<DecksmithMediaAsset>;
}

export interface DecksmithImageEditSource {
  resourceId: string;
  objectKey: string;
  contentType: string;
}

export function createDecksmithMediaTools(
  session: DecksmithDocumentSession,
  dependencies: DecksmithMediaToolDependencies,
): AgentTool[] {
  return [createImageTool(session, dependencies), createImageEditTool(session, dependencies)];
}

/**
 * edit_native_image：以选中图片元素的当前图片为参考，按教师指令编辑。
 *
 * 数据源：会话当前文档（nativeSlides 中的 image 元素与 resources.media 资源）；取图、编辑、
 * 存储均经依赖注入（content-service 授权 + model-service `/v1/images/edits`）。
 * 核心逻辑：
 * 1. 只接受已存在的 image 元素，并解析它当前绑定的 media 资源（不接受模型给的 URL/key）；
 * 2. 交给依赖方编辑并存为新的生成媒体；
 * 3. 结果注册为新资源并重新绑定同一元素：transform / zIndex / fit 保持不变，alt 仅在给出时更新，
 *    旧 objectKey 不被覆盖（拒绝或历史审阅仍可回到旧图）；
 * 4. 回执说明结果"沿用原构图但非像素级一致"。
 */
function createImageEditTool(
  session: DecksmithDocumentSession,
  dependencies: DecksmithMediaToolDependencies,
): AgentTool {
  return {
    name: 'edit_native_image',
    label: '参考原图编辑图片',
    description: [
      'Edit the picture currently shown by one existing native image element, using that picture as',
      'the reference: replace, add, or remove objects, change label wording, colors, or style inside it.',
      'For geometric changes (arrow direction, positions, counts) name the exact element and change.',
      'The server reads the current image itself; write only the change in instruction (what to change',
      'and what to keep). The result keeps the overall composition but is not pixel-identical. It is stored as',
      'a new media resource and rebound to the same element; position, size, layer, and fit stay the same.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      elementId: Type.String(),
      instruction: Type.String({ maxLength: 2000 }),
      alt: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => {
      const input = params as ImageEditToolInput;
      const pageId = nonblank(input.pageId, 'pageId');
      const elementId = nonblank(input.elementId, 'elementId');
      const instruction = nonblank(input.instruction, 'instruction');
      const slide = session.readNativeSlide(pageId);
      const element = findDecksmithNativeElement(slide.elements, elementId);
      if (element === undefined) {
        throw new DecksmithSessionError(`Element ${elementId} does not exist on page ${pageId}.`);
      }
      if (element.type !== 'image') {
        throw new DecksmithSessionError(
          `Element ${elementId} is a ${element.type}, not an image; edit_native_image only edits pictures.`,
        );
      }
      const current = session.document.resources.media.find(
        (resource) => resource.id === element.resourceId,
      );
      if (current === undefined) {
        throw new DecksmithSessionError(
          `Image ${elementId} has no media resource to edit; generate or upload a picture instead.`,
        );
      }
      // 文档 digest 不一定是存储字节的哈希（PPTX 导入记录的是源部件 digest，转码后不同；
      // 教师上传是 objectkey: 身份），因此不作为期望校验和上送；完整性以 content-service
      // 授权返回的权威 checksum 为准，并在下载时逐字节核对。
      const asset = await dependencies.editImage({
        toolCallId,
        pageId,
        targetId: elementId,
        instruction,
        source: {
          resourceId: current.id,
          objectKey: current.objectKey,
          contentType: current.contentType,
        },
      });
      const resource = mediaResource(asset);
      if (resource.objectKey === current.objectKey) {
        throw new DecksmithSessionError('Image edit must produce a new media resource.');
      }
      const updated = session.bindImage({
        pageId,
        elementId,
        resource,
        ...(input.alt === undefined || input.alt.trim().length === 0 ? {} : { alt: input.alt }),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              kind: 'image-edit',
              pageId,
              slideId: updated.id,
              targetId: elementId,
              previousResourceId: current.id,
              resourceId: resource.id,
              objectKey: asset.objectKey,
              contentType: asset.contentType,
              sizeBytes: asset.sizeBytes,
              checksumSha256: asset.checksumSha256,
              geometryPreserved: true,
              note: 'Edited from the current picture; overall composition kept, details may differ.',
            }),
          },
        ],
        details: undefined,
      };
    },
  };
}

interface ImageEditToolInput {
  pageId: string;
  elementId: string;
  instruction: string;
  alt?: string;
}

function createImageTool(
  session: DecksmithDocumentSession,
  dependencies: DecksmithMediaToolDependencies,
): AgentTool {
  return {
    name: 'generate_native_image',
    label: '生成并绑定原生图片',
    description: [
      'Generate an image, register its stable objectKey as a document/v2 media resource,',
      'derive the resource id on the server, and bind it to one authoritative native image element.',
      'transform and alt are required for a new image. Never invent URLs, base64, or object keys.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      elementId: Type.String(),
      prompt: Type.String(),
      alt: Type.Optional(Type.String()),
      fit: Type.Optional(
        Type.Union([Type.Literal('cover'), Type.Literal('contain'), Type.Literal('stretch')]),
      ),
      transform: Type.Optional(
        Type.Object({
          x: Type.Number({ minimum: 0 }),
          y: Type.Number({ minimum: 0 }),
          width: Type.Number({ exclusiveMinimum: 0 }),
          height: Type.Number({ exclusiveMinimum: 0 }),
          rotation: Type.Optional(Type.Number()),
          flipHorizontal: Type.Optional(Type.Boolean()),
          flipVertical: Type.Optional(Type.Boolean()),
        }),
      ),
      zIndex: Type.Optional(Type.Integer()),
      size: Type.Optional(
        Type.Union([
          Type.Literal('1024x1024'),
          Type.Literal('1536x1024'),
          Type.Literal('1024x1536'),
        ]),
      ),
    }),
    execute: async (toolCallId, params) => {
      const input = params as ImageToolInput;
      session.readNativeSlide(nonblank(input.pageId, 'pageId'));
      const asset = await dependencies.generateImage({
        toolCallId,
        pageId: input.pageId,
        targetId: nonblank(input.elementId, 'elementId'),
        prompt: nonblank(input.prompt, 'prompt'),
        ...(input.size === undefined ? {} : { size: input.size }),
      });
      const resource = mediaResource(asset);
      const slide = session.bindImage({
        pageId: input.pageId,
        elementId: input.elementId,
        resource,
        ...(input.transform === undefined ? {} : { transform: input.transform }),
        ...(input.zIndex === undefined ? {} : { zIndex: input.zIndex }),
        ...(input.alt === undefined ? {} : { alt: input.alt }),
        ...(input.fit === undefined ? {} : { fit: input.fit }),
      });
      return stableMediaResult({
        kind: 'image',
        pageId: input.pageId,
        targetId: input.elementId,
        resourceId: resource.id,
        slideId: slide.id,
        asset,
      });
    },
  };
}

interface ImageToolInput {
  pageId: string;
  elementId: string;
  prompt: string;
  alt?: string;
  fit?: 'cover' | 'contain' | 'stretch';
  transform?: ReachDeckTransformV2;
  zIndex?: number;
  size?: '1024x1024' | '1536x1024' | '1024x1536';
}

function mediaResource(asset: DecksmithMediaAsset) {
  const derived = buildReachDeckMediaResourceForObjectKey(nonblank(asset.objectKey, 'objectKey'));
  return {
    ...derived,
    contentType: nonblank(asset.contentType, 'contentType'),
    digest: `sha256:${asset.checksumSha256}`,
  };
}

function nonblank(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new DecksmithSessionError(`${field} is required.`);
  }
  return value.trim();
}

function stableMediaResult(input: {
  kind: 'image';
  pageId: string;
  targetId: string;
  resourceId: string;
  slideId: string;
  asset: DecksmithMediaAsset;
}) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          kind: input.kind,
          pageId: input.pageId,
          slideId: input.slideId,
          targetId: input.targetId,
          resourceId: input.resourceId,
          objectKey: input.asset.objectKey,
          contentType: input.asset.contentType,
          sizeBytes: input.asset.sizeBytes,
          checksumSha256: input.asset.checksumSha256,
        }),
      },
    ],
    details: undefined,
  };
}
