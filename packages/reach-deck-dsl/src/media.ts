import { buildReachDeckMediaResourceForObjectKey } from './compileToNativeV2.js';
import type { ReachDeckDocument } from './document.js';
import { collectReachDeckNativeSlideResourceIds } from './nativeSlideResources.js';
import {
  collectQuizQuestionAttachmentReferences,
  collectQuizQuestionInlineImageObjectKeys,
  type QuizAttachmentReference,
} from './quizQuestion.js';

/** Keep a large imported Deck from turning one page load into an unbounded presign burst. */
export const REACH_DECK_MEDIA_RESOLVE_CONCURRENCY = 8;

/** 收集稳定的 Reach Deck 图片和语音对象引用，不暴露临时签名地址。 */
export function collectReachDeckMediaObjectKeys(document: ReachDeckDocument): string[] {
  if (!hasPageArray(document)) return [];
  const keys: string[] = [];
  const resourceIds = new Set(
    document.nativeSlides.flatMap(({ slide }) => collectReachDeckNativeSlideResourceIds(slide)),
  );
  for (const page of document.pages) {
    if (page.sceneType === 'interactive' && page.scene.narration?.audioResourceId) {
      resourceIds.add(page.scene.narration.audioResourceId);
    }
  }
  for (const resource of document.resources.media) {
    if (resourceIds.has(resource.id) && !keys.includes(resource.objectKey)) {
      keys.push(resource.objectKey);
    }
  }
  return keys;
}

/** Native documents carry only stable resource references; there are no volatile URLs to strip. */
export function stripVolatileReachDeckMediaUrls(document: ReachDeckDocument): ReachDeckDocument {
  if (!hasPageArray(document)) return document;
  return document;
}

/**
 * Resolve v2 native media resources (`resources.media`) into the volatile
 * `resourceId → display URL` map consumed by the native slide renderer.
 * Native elements reference media by resource id, so URLs never enter the
 * document itself — nothing to strip before persistence.
 */
export async function resolveReachDeckNativeMediaUrls(
  document: ReachDeckDocument,
  resolveUrl: (objectKey: string) => Promise<string>,
): Promise<Record<string, string>> {
  if (document.schemaVersion !== 'reach-deck-document/v2') return {};
  const urls: Record<string, string> = {};
  const resources = document.resources.media;
  let nextIndex = 0;
  const resolveNext = async () => {
    while (true) {
      const index = nextIndex++;
      const resource = resources[index];
      if (resource === undefined) return;
      try {
        urls[resource.id] = await resolveUrl(resource.objectKey);
      } catch (error) {
        // 保持 id 缺失让渲染器走显式诊断，但必须留下告警：讲稿音频没有图片那样的
        // 画布诊断路径，换签 404 若全静默会表现成"点播放没声音"且无从排查。
        console.warn(
          `[reach-deck] media presign failed for resource ${resource.id} (${resource.objectKey})`,
          error,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REACH_DECK_MEDIA_RESOLVE_CONCURRENCY, resources.length) }, () =>
      resolveNext(),
    ),
  );
  return urls;
}

/**
 * 把 `resourceId → 展示 URL` 翻成 `objectKey → 展示 URL`。
 *
 * 富文本里的图片节点只存稳定的 objectKey（易失 URL 一旦进文档就会打乱 revision token），
 * 渲染时需要按 objectKey 反查。空 URL 直接跳过，让渲染器走既有的 alt 占位分支。
 */
export function reachDeckMediaUrlsByObjectKey(
  document: ReachDeckDocument,
  urlsByResourceId: Readonly<Record<string, string>>,
): Record<string, string> {
  if (document.schemaVersion !== 'reach-deck-document/v2') return {};
  const urls: Record<string, string> = {};
  for (const resource of document.resources.media) {
    const url = (urlsByResourceId[resource.id] ?? '').trim();
    if (url.length === 0) continue;
    urls[resource.objectKey] = url;
  }
  return urls;
}

/**
 * 把测验富文本引用到的 objectKey 登记成文档级媒体资源。
 *
 * `resources.media` 是学生端换签鉴权唯一认的清单
 * （java/.../ReachDeckLearnerMediaService.containsMediaReference），也是
 * `resolveReachDeckNativeMediaUrls` 与教师端 NativeMediaUrlCoordinator 的解析输入，
 * 因此行内图片只有登记后才看得见。资源身份走 `buildReachDeckMediaResourceForObjectKey`，
 * 让编辑器、编译器与 Decksmith 对同一个 key 派生出逐字节一致的条目。
 *
 * 行内资源仍按增量方式登记。附件专属条目使用独立 id 前缀，删除附件时可以回收条目，
 * 不影响幻灯片或旁白资源。
 * 函数必须幂等：对已登记文档重复调用不得新增条目或改变文档；对象键顺序必须稳定，
 * 保留既有资源顺序，并按题目遍历顺序追加缺失引用，避免保存回灌时产生无意义差异。
 */
export function ensureReachDeckRichTextMediaResources(
  document: ReachDeckDocument,
): ReachDeckDocument {
  if (document.schemaVersion !== 'reach-deck-document/v2' || !hasPageArray(document)) {
    return document;
  }
  const objectKeys: string[] = [];
  const attachments = new Map<string, QuizAttachmentReference>();
  for (const page of document.pages) {
    if (page.sceneType !== 'quiz') continue;
    for (const question of page.scene.content.questions) {
      for (const objectKey of collectQuizQuestionInlineImageObjectKeys(question)) {
        if (!objectKeys.includes(objectKey)) objectKeys.push(objectKey);
      }
      for (const attachment of collectQuizQuestionAttachmentReferences(question)) {
        if (!attachments.has(attachment.objectKey))
          attachments.set(attachment.objectKey, attachment);
      }
    }
  }
  const otherReferencedKeys = new Set([
    ...collectReachDeckMediaObjectKeys(document),
    ...objectKeys,
  ]);
  const retained = document.resources.media.filter(
    (resource) =>
      !resource.id.startsWith('attachment-media-') ||
      attachments.has(resource.objectKey) ||
      otherReferencedKeys.has(resource.objectKey),
  );

  // 同一 objectKey 允许被多条资源引用（文档只约束 id 唯一），因此按 objectKey 判重；
  // 再用 id 判重兜住"派生 id 已被幻灯片资源占用"的极端情况。
  const registeredKeys = new Set(retained.map((resource) => resource.objectKey));
  const registeredIds = new Set(retained.map((resource) => resource.id));
  const added = [];
  for (const attachment of attachments.values()) {
    if (registeredKeys.has(attachment.objectKey)) continue;
    const base = buildReachDeckMediaResourceForObjectKey(attachment.objectKey);
    const resource = { ...base, id: `attachment-${base.id}`, contentType: attachment.contentType };
    if (registeredIds.has(resource.id)) continue;
    registeredKeys.add(resource.objectKey);
    registeredIds.add(resource.id);
    added.push(resource);
  }
  for (const objectKey of objectKeys) {
    if (registeredKeys.has(objectKey)) continue;
    const resource = buildReachDeckMediaResourceForObjectKey(objectKey);
    if (registeredIds.has(resource.id)) continue;
    registeredKeys.add(objectKey);
    registeredIds.add(resource.id);
    added.push(resource);
  }
  if (added.length === 0 && retained.length === document.resources.media.length) return document;
  return {
    ...document,
    resources: { ...document.resources, media: [...retained, ...added] },
  };
}

function hasPageArray(document: ReachDeckDocument): boolean {
  return Array.isArray((document as unknown as { pages?: unknown }).pages);
}
