import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';

import {
  buildDecksmithDocumentHash,
  buildStagedGenerationRequestHash,
} from '../../../lib/reach-deck/job-identity.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './resource-scope.js';

export const VISUAL_ORG = TEST_REACH_DECK_RESOURCE_SCOPE.organizationId;

export function imageObjectKey(index: number): string {
  return `uploads/${VISUAL_ORG}/reach-deck/picture-${index}.png`;
}

/** 来源页上有 count 张图片（image-1…image-N，各自绑定独立媒体资源）的 v2 文档。 */
export function documentWithImages(count: number) {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title: '能量转化',
      generatedAt: '2026-10-08T00:00:00.000Z',
    }),
  );
  const page = normalized.pages[0]!;
  const media = Array.from({ length: count }, (_, index) => ({
    id: `media-${index + 1}`,
    objectKey: imageObjectKey(index + 1),
    contentType: 'image/png',
    digest: `sha256:${String(index + 1)
      .repeat(64)
      .slice(0, 64)}`,
  }));
  const elements = Array.from({ length: count }, (_, index) => ({
    id: `image-${index + 1}`,
    type: 'image',
    transform: { x: 40 + index * 200, y: 80, width: 180, height: 120 },
    zIndex: index + 1,
    resourceId: `media-${index + 1}`,
    alt: `示意图 ${index + 1}`,
    fit: 'contain',
  }));
  const document = parseReachDeckDocument({
    ...normalized,
    resources: { ...normalized.resources, media },
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${page.pageId}:native`,
          title: page.title,
          background: { kind: 'none' },
          elements,
          animations: [],
        },
      },
    ],
  }) as ReachDeckDocumentV2;
  return { document, pageId: page.pageId };
}

/** 与 validateContextRefs 一致的 native-element 引用。 */
export function imageContextRef(document: ReachDeckDocumentV2, pageId: string, elementId: string) {
  const page = document.pages.find((candidate) => candidate.pageId === pageId)!;
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)!.slide;
  const component = slide.elements.find((element) => element.id === elementId)!;
  return {
    schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
    kind: 'native-element' as const,
    pageId,
    pageLabel: page.title,
    pageOrder: document.pages.findIndex((candidate) => candidate.pageId === pageId) + 1,
    pageRevision: page.revision,
    sceneId: pageId,
    sceneType: 'slide' as const,
    componentId: elementId,
    componentType: 'image',
    display: { label: elementId },
    baseline: {
      documentId: document.id,
      documentHash: buildDecksmithDocumentHash(document),
      pageRevision: page.revision,
      componentHash: buildStagedGenerationRequestHash(component),
    },
  };
}

export function checksumFor(objectKey: string): string {
  return buildStagedGenerationRequestHash({ objectKey }).slice(0, 64);
}

/** content-service 授权应答（签名地址只在执行期短暂存在）。 */
export function authorizedReference(objectKey: string) {
  return {
    objectKey,
    downloadUrl: `https://oss.example/signed/${encodeURIComponent(objectKey)}?Expires=120`,
    expiresInSeconds: 120,
    contentType: 'image/png',
    sizeBytes: 2048,
    checksumSha256: checksumFor(objectKey),
    source: 'document' as const,
  };
}
