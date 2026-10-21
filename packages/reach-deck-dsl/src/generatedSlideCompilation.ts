import {
  compileDeckSlideToNativeV2,
  type CompileNativeV2NarrationInput,
  type CompileNativeV2NarrationSegment,
} from './compileToNativeV2.js';
import { REACH_DECK_NARRATION_ANIMATION_ID_PREFIX } from './nativeNarration.js';
import type {
  ReachDeckNativeSlideBindingV2,
  ReachDeckPublishedPage,
  ReachDeckResourcesV2,
  ReachDeckThemeResourceV2,
} from './document.js';
import type { DeckSlide, DeckTheme } from './types.js';
import type { NativeSlideArtifact } from './generationWorkspace.js';

/** 一页编译产物：绑定 + 该页新增的资源 + 中文诊断。 */
export interface CompiledReachDeckPageV2 {
  binding: ReachDeckNativeSlideBindingV2;
  themes: ReachDeckResourcesV2['themes'];
  media: ReachDeckResourcesV2['media'];
  masters?: ReachDeckResourcesV2['masters'];
  layouts?: ReachDeckResourcesV2['layouts'];
  diagnostics: string[];
}

/** Native generation artifacts are already compiled; share title projection with readers. */
export const projectNativeSlideArtifact = (
  artifact: NativeSlideArtifact,
  title: string,
): CompiledReachDeckPageV2 => ({
  binding: { pageId: artifact.pageId, slide: { ...artifact.nativeSlide, title } },
  themes: artifact.resources.themes,
  media: artifact.resources.media,
  masters: artifact.resources.masters,
  layouts: artifact.resources.layouts,
  diagnostics: [],
});

/** 一页的诊断记录；`failure` 表示编译抛错，该页不能进入 ready 状态。 */
export interface ReachDeckCompileDiagnosticV2 {
  pageId: string;
  messages: string[];
  failure?: string;
}

/**
 * 取整页共享的讲稿音频 objectKey。
 *
 * TTS 链路对一页只合成一条整页音频，再把同一个 `audioObjectKey` 写进该页每条 cue
 * （见 generation-pipeline 的语音合成步骤），因此"整页共享同一个键"是唯一合法形态：
 * v2 的 narration 只有一个页级 `audioResourceId` 槽位，表达不了逐段音频。
 * 键不统一或只有部分 cue 带键时返回 undefined —— 宁可这一页无音频，也不能挑一条
 * 播成整页，那会让学生听到与字幕对不上的内容。
 */
const sharedAudioObjectKey = (slide: DeckSlide): string | undefined => {
  const first = slide.voiceTimeline[0]?.audioObjectKey?.trim();
  if (first === undefined || first.length === 0) return undefined;
  return slide.voiceTimeline.every((cue) => cue.audioObjectKey?.trim() === first)
    ? first
    : undefined;
};

/** 该页存在音频却无法归并成整页一条（部分 cue 带键或键不一致）。 */
const hasUnusableAudio = (slide: DeckSlide): boolean =>
  sharedAudioObjectKey(slide) === undefined &&
  slide.voiceTimeline.some((cue) => (cue.audioObjectKey ?? '').trim().length > 0);

/**
 * 从 v1 讲稿时间轴反推编译器要的 narration。
 *
 * 生成侧把模型的 narration 段落落成了 `voiceTimeline` cue（见 Task 3 决策），
 * 这里做的就是那一步的逆向：cue 顺序即播报顺序，秒数目前是占位窗口，
 * 照传即可——编译器只做合法性校验，真实时间戳由后续 TTS 链路回填。
 *
 * 音频同样要反推：cue 上的 `audioObjectKey` 交给编译器登记成媒体资源并写进
 * `narration.audioResourceId`。漏掉这一步，v2 原生渲染路径就只有字幕没有声音
 * （播放器对原生页提前返回，v1 的逐 cue 音频元素根本不会挂载）。
 */
export const narrationFromVoiceTimeline = (
  slide: DeckSlide,
): CompileNativeV2NarrationInput | undefined => {
  if (slide.voiceTimeline.length === 0) {
    return slide.narrationMarkdown === undefined
      ? undefined
      : { markdown: slide.narrationMarkdown, segments: [] };
  }
  const segments = slide.voiceTimeline.map((cue) => {
    const segment: CompileNativeV2NarrationSegment = { text: cue.text };
    // 占位窗口也是合法时间轴：编译器据此产入场动画，Task 8 换真时间戳后无需改这里。
    segment.start = cue.start;
    segment.end = cue.end;
    // 词级时间戳（真实 TTS 对齐才有）随段透传，进入 v2 narration segment 持久化。
    if (cue.words !== undefined && cue.words.length > 0) segment.words = cue.words;
    return segment;
  });
  const audioObjectKey = sharedAudioObjectKey(slide);
  const reveals = slide.animations.flatMap((animation) => {
    if (!animation.id.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX)) return [];
    const revealEffect: 'appear' | 'fade' | 'zoom' | 'rise' =
      animation.type === 'stepReveal'
        ? 'appear'
        : animation.type === 'fade'
          ? 'fade'
          : animation.from?.width !== undefined || animation.from?.height !== undefined
            ? 'zoom'
            : 'rise';
    return [
      {
        start: animation.start,
        revealElementIds: [animation.targetId],
        revealEffect,
      },
    ];
  });
  return {
    segments,
    ...(reveals.length === 0 ? {} : { reveals }),
    ...(slide.narrationMarkdown === undefined ? {} : { markdown: slide.narrationMarkdown }),
    ...(audioObjectKey === undefined ? {} : { audioObjectKey }),
  };
};

/**
 * 编译一页 slide 为 v2 原生幻灯片。
 *
 * 编译器本身是纯函数且不设计成抛错，这里仍做防御性包裹。调用方必须把 failure
 * 作为页生成失败处理，不能物化一个缺少 native binding 的 ready slide。
 */
export const compileReachDeckPageToNativeV2 = (
  page: ReachDeckPublishedPage,
  theme: DeckTheme,
): CompiledReachDeckPageV2 | { failure: string } => {
  if (page.sceneType !== 'slide') return { failure: '非 slide 页不参与 v2 编译' };
  const legacyScene = (page as ReachDeckPublishedPage & { scene?: DeckSlide }).scene;
  if (legacyScene === undefined) {
    return { failure: 'v2 原生幻灯片编译不接受缺少源内容的 slide 页。' };
  }
  try {
    const narration = narrationFromVoiceTimeline(legacyScene);
    const result = compileDeckSlideToNativeV2({
      slide: legacyScene,
      theme,
      ...(narration === undefined ? {} : { narration }),
      duration: legacyScene.duration,
    });
    const diagnostics = [...result.diagnostics];
    if (hasUnusableAudio(legacyScene)) {
      diagnostics.push(
        '讲稿音频未归并成整页一条（部分 cue 缺 audioObjectKey 或键不一致），本页无音频。',
      );
    }
    return {
      binding: { pageId: page.pageId, slide: result.slide },
      themes: result.resources.themes,
      media: result.resources.media,
      diagnostics,
    };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
};

/** 资源合并结果：合并后的资源 + 文档应指向的默认主题 id。 */
export interface MergedCompiledResourcesV2 {
  resources: ReachDeckResourcesV2;
  defaultThemeId: string;
}

/** 两条主题资源是否表达同一套主题（忽略 id：id 由内容派生，但历史资源可能用别的 id）。 */
export const reachDeckThemeResourceContentEqual = (
  left: ReachDeckThemeResourceV2,
  right: ReachDeckThemeResourceV2,
): boolean => {
  const leftColors = Object.keys(left.colors).sort();
  const rightColors = Object.keys(right.colors).sort();
  return (
    left.name === right.name &&
    left.fonts.display === right.fonts.display &&
    left.fonts.body === right.fonts.body &&
    leftColors.length === rightColors.length &&
    leftColors.every((slot, index) => slot === rightColors[index]) &&
    leftColors.every((slot) => left.colors[slot] === right.colors[slot])
  );
};

/**
 * 把若干页的编译产物合并进文档级资源，并定出文档应指向的默认主题。
 *
 * 主题必须与 `defaultThemeId` 一起收敛：渲染器只按 `defaultThemeId` 解析
 * `{kind:'theme'}` 引用，只把编译主题追加进 `themes` 而不改指向，会让它变成永不
 * 被读取的死资源——教师换主题重物化后仍按旧主题着色。因此：
 * - 编译主题与当前默认主题**内容等价** → 复用原资源、不追加重复条目；
 * - 否则追加编译主题并把 `defaultThemeId` 改指向它。
 * 媒体资源的 id 由内容派生，按 id 去重即可；已存在的同 id 资源保持原样，不覆盖。
 */
export const mergeCompiledResourcesV2 = (
  base: ReachDeckResourcesV2,
  defaultThemeId: string,
  compiled: readonly CompiledReachDeckPageV2[],
): MergedCompiledResourcesV2 => {
  const themes = [...base.themes];
  const media = [...base.media];
  const masters = [...base.masters];
  const layouts = [...base.layouts];
  let nextDefaultThemeId = defaultThemeId;
  const current = base.themes.find((theme) => theme.id === defaultThemeId);
  for (const page of compiled) {
    for (const theme of page.themes) {
      const sameId = themes.find((existing) => existing.id === theme.id);
      if (sameId !== undefined && !reachDeckThemeResourceContentEqual(sameId, theme)) {
        throw new Error(`Conflicting Reach Deck theme resource ${theme.id}.`);
      }
      // 与当前默认主题内容一致：沿用既有资源，避免每轮生成堆一条同色主题。
      if (current !== undefined && reachDeckThemeResourceContentEqual(current, theme)) {
        if (sameId === undefined && page.masters?.some((master) => master.themeId === theme.id))
          themes.push(theme);
        continue;
      }
      if (!themes.some((existing) => existing.id === theme.id)) themes.push(theme);
      nextDefaultThemeId = theme.id;
    }
    for (const resource of page.media) {
      const existing = media.find((candidate) => candidate.id === resource.id);
      if (
        existing !== undefined &&
        (existing.objectKey !== resource.objectKey ||
          existing.digest !== resource.digest ||
          existing.contentType !== resource.contentType)
      ) {
        throw new Error(`Conflicting Reach Deck media resource ${resource.id}.`);
      }
      if (!media.some((existing) => existing.id === resource.id)) media.push(resource);
    }
    for (const resource of page.masters ?? []) {
      const existing = masters.find((candidate) => candidate.id === resource.id);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(resource)) {
        throw new Error(`Conflicting Reach Deck master resource ${resource.id}.`);
      }
      if (existing === undefined) masters.push(resource);
    }
    for (const resource of page.layouts ?? []) {
      const existing = layouts.find((candidate) => candidate.id === resource.id);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(resource)) {
        throw new Error(`Conflicting Reach Deck layout resource ${resource.id}.`);
      }
      if (existing === undefined) layouts.push(resource);
    }
  }
  const sameThemes =
    themes.length === base.themes.length && themes.every((item, i) => item === base.themes[i]);
  const sameMedia =
    media.length === base.media.length && media.every((item, i) => item === base.media[i]);
  return {
    resources:
      sameThemes &&
      sameMedia &&
      masters.length === base.masters.length &&
      layouts.length === base.layouts.length
        ? base
        : { ...base, themes, media, masters, layouts },
    defaultThemeId: nextDefaultThemeId,
  };
};
