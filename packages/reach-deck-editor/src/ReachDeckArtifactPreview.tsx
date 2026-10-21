'use client';

import { useMemo } from 'react';
import {
  createBlankReachDeckDocument,
  compileDeckSlideToNativeV2,
  isNativeSlideArtifact,
  mergeCompiledResourcesV2,
  projectNativeSlideArtifact,
  type DeckTheme,
  type GeneratedSceneArtifact,
  type ReachDeckDocument,
  type ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';
import { ReachDeckPlayer } from '@reachany/reach-deck-player';

export interface ReachDeckArtifactPreviewProps {
  artifact: GeneratedSceneArtifact;
  locale?: string;
  title?: string;
  revision?: number;
  theme?: DeckTheme;
  resourceUrlsById?: Readonly<Record<string, string>>;
}

/**
 * Local-only authoring preview for a generated artifact.
 *
 * Player state and interactions remain local to this preview. Event and
 * page-change callbacks are deliberately omitted so previewing cannot persist
 * learner runtime or grading data.
 */
export function ReachDeckArtifactPreview({
  artifact,
  locale = 'en-US',
  title = isNativeSlideArtifact(artifact) ? artifact.nativeSlide.title : artifact.scene.title,
  revision = artifact.requestedRevision,
  theme,
  resourceUrlsById,
}: ReachDeckArtifactPreviewProps) {
  const document = useMemo(
    () => createPreviewDocument(artifact, title, revision, theme),
    [artifact, revision, theme, title],
  );

  return (
    <article aria-label={`${title}页面播放器`} className="reach-deck-generation__artifact-preview">
      <header>
        <strong>页面播放器</strong>
        <span>{artifact.sceneType}</span>
      </header>
      <div className="reach-deck-generation__artifact-player">
        <ReachDeckPlayer
          document={document}
          locale={locale}
          // 教师生成预览：本地判客观题并直接展示参考答案。
          quizGradingMode="trial"
          {...(resourceUrlsById === undefined ? {} : { nativeResourceUrlsById: resourceUrlsById })}
        />
      </div>
      <details className="reach-deck-generation__artifact-accessible">
        <summary>无障碍只读内容详情</summary>
        <pre aria-label={`${title}场景数据`}>
          {JSON.stringify(
            isNativeSlideArtifact(artifact) ? artifact.nativeSlide : artifact.scene,
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}

function createPreviewDocument(
  artifact: GeneratedSceneArtifact,
  title: string,
  revision: number,
  theme?: DeckTheme,
): ReachDeckDocument {
  const id = `preview:${artifact.runId}:${artifact.pageId}:${artifact.attempt}`;
  const scaffold = createBlankReachDeckDocument({ id, title, generatedAt: artifact.generatedAt });
  if (isNativeSlideArtifact(artifact)) {
    const projected = projectNativeSlideArtifact(artifact, title);
    const merged = mergeCompiledResourcesV2(scaffold.resources, scaffold.defaultThemeId, [
      projected,
    ]);
    return {
      ...scaffold,
      resources: merged.resources,
      defaultThemeId: merged.defaultThemeId,
      pages: [toPreviewPage(artifact, title, revision)],
      nativeSlides: [projected.binding],
    };
  }
  const compiled =
    artifact.sceneType === 'slide'
      ? compileDeckSlideToNativeV2({
          slide: artifact.scene,
          theme: theme ?? scaffold.theme,
          duration: artifact.scene.duration,
        })
      : undefined;
  return {
    ...scaffold,
    ...(theme === undefined ? {} : { theme }),
    metadata: {
      ...scaffold.metadata,
      contentDigest: `preview:${artifact.requestedRevision}:${artifact.attempt}`,
    },
    resources:
      compiled === undefined
        ? scaffold.resources
        : {
            ...scaffold.resources,
            media: [...scaffold.resources.media, ...compiled.resources.media],
          },
    pages: [toPreviewPage(artifact, title, revision)],
    nativeSlides:
      compiled === undefined ? [] : [{ pageId: artifact.pageId, slide: compiled.slide }],
  };
}

function toPreviewPage(
  artifact: GeneratedSceneArtifact,
  title: string,
  revision: number,
): ReachDeckPublishedPage {
  const base = { pageId: artifact.pageId, order: 1, revision, title };
  switch (artifact.sceneType) {
    case 'slide':
      return { ...base, sceneType: 'slide' };
    case 'quiz':
      return { ...base, sceneType: 'quiz', scene: artifact.scene };
    case 'interactive':
      return { ...base, sceneType: 'interactive', scene: artifact.scene };
  }
}
