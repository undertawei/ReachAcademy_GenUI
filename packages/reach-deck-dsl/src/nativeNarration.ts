/**
 * v2 原生页（native slide）的讲稿工具集：PPTX 导入等"无生成状态机"的 deck
 * 走 native 通道生成讲稿时，序列化输入、内容一致性剥离与产物写回的唯一落点。
 *
 * 三件事各司其职：
 * 1. `summarizeNativeSlideElementsForNarration`：native slide → 讲稿阶段元素清单
 *    （与 v1 `summarizeDeckSlideElementsForNarration` 输出同构）；
 * 2. `stripReachDeckNativeSlideNarration`：剥离讲稿阶段会改写的字段
 *    （narration / animations / duration），得到"版面内容"的稳定形态——
 *    digest 计算在服务端（node:crypto），本包保持浏览器可用；
 * 3. `applyReachDeckNarrationToNativeSlide`：讲稿产物（真实秒 + reveal 锚点）
 *    写回 native slide：narration + 按具名预设重编入场动画 + duration。
 */

import {
  DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE,
  ENTRANCE_ANIMATION_PRESETS,
  isEntranceAnimationPresetName,
  type EntranceAnimationPresetName,
} from './entranceAnimationPresets.js';
import type {
  ReachDeckAnimationV2,
  ReachDeckNativeElementV2,
  ReachDeckNativeSlideV2,
  ReachDeckScientificAnchorBindingV1,
} from './nativeV2.js';
import type { NarrationSlideElementSummary } from './narrationElements.js';
import { normalizeReachDeckNarrationMarkdown } from './narrationMarkdown.js';
import { collectReachDeckNativeElementIds } from './nativeOrphanAnimations.js';
import { plainTextFromMarkup, richTextToPlainText } from './richText.js';
import type { ReachDeckMediaResourceV2 } from './document.js';
import { parseReachDeckMediaOrigin } from './mediaOrigin.js';
import { parseReachDeckSpeechMarkupV1, type ReachDeckSpeechMarkupV1 } from './speechMarkup.js';

/**
 * 讲稿驱动的入场动画 id 前缀（区分策略：可识别标记）。
 *
 * `applyReachDeckNarrationToNativeSlide` 生成的动画一律用该前缀命名，重生成时按
 * 前缀整批替换、其余动画（教师自建 / PPTX 导入的原生动画）原样保留。选前缀标记而非
 * "reveal 目标 + start 与讲稿段对齐"的启发式识别：v2 动画没有 metadata 槽位，id 是
 * 唯一能携带出处的稳定字段，前缀判定确定性最高、不会把教师恰好对齐讲稿节奏的动画误删。
 */
export const REACH_DECK_NARRATION_ANIMATION_ID_PREFIX = 'narration-entrance:';

/** 该动画是否由讲稿写回生成（按 id 前缀识别）。 */
export const isReachDeckNarrationDrivenAnimation = (animation: ReachDeckAnimationV2): boolean =>
  animation.id.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX);

/**
 * 把另一份幻灯片（通常是服务端最新版本）的讲稿动画嫁接到 `slide` 上时可保留的那部分。
 *
 * 只取讲稿动画，并丢掉目标元素已不在 `slide`（含 group 子元素）里的：教师在本地删掉元素后，
 * 服务端旧版本里指向它的讲稿入场动画不应被带回草稿，否则会凭空多出一条孤儿动画。
 */
export const reachDeckNarrationAnimationsForSlide = (
  animations: readonly ReachDeckAnimationV2[],
  slide: Pick<ReachDeckNativeSlideV2, 'elements'>,
): ReachDeckAnimationV2[] => {
  const elementIds = collectReachDeckNativeElementIds(slide.elements);
  return animations.filter(
    (animation) =>
      isReachDeckNarrationDrivenAnimation(animation) && elementIds.has(animation.targetId),
  );
};

/**
 * 把 v2 native slide 的元素序列化成讲稿阶段的元素清单（native 通道输入）。
 *
 * 数据源：`ReachDeckNativeSlideV2.elements`（仅顶层，不递归 group——group 整体
 * reveal 语义与成员逐个 reveal 无法区分，宁可少给模型一个锚点也不给歧义锚点）。
 * 核心逻辑：
 * 1. textFrame → type 'text'，取富文本纯文本；
 * 2. 带非空文本的 shape → 同样映射为 'text'（PPTX 的标题/要点常落在形状里）；
 * 3. image → alt，video → title；
 * 4. 纯文本为空白的条目跳过（模型无从讲述、锚定也无意义），hidden 元素跳过。
 * 输出与 v1 serializer 同构（`NarrationSlideElementSummary`），确定性且无 I/O。
 */
export const summarizeNativeSlideElementsForNarration = (
  slide: ReachDeckNativeSlideV2,
  mediaResources: readonly ReachDeckMediaResourceV2[] = [],
): NarrationSlideElementSummary[] => {
  const summaries: NarrationSlideElementSummary[] = [];
  const resources = new Map(mediaResources.map((resource) => [resource.id, resource]));
  for (const element of slide.elements) {
    if (element.hidden === true) continue;
    const summary = summarizeNativeElement(element);
    const resourceId =
      element.type === 'image'
        ? element.resourceId
        : element.type === 'shape' && element.style.fill?.kind === 'image'
          ? element.style.fill.resourceId
          : undefined;
    const suppliedOrigin = resourceId === undefined ? undefined : resources.get(resourceId)?.origin;
    if (summary !== undefined && suppliedOrigin !== undefined) {
      const origin = parseReachDeckMediaOrigin(suppliedOrigin);
      summary.origin = {
        route: origin.route,
        ...(origin.title === undefined
          ? {}
          : { title: plainTextFromMarkup(origin.title).slice(0, 500) }),
        ...(origin.description === undefined
          ? {}
          : { description: plainTextFromMarkup(origin.description).slice(0, 1000) }),
        ...(origin.sourceUrl === undefined ? {} : { sourceUrl: origin.sourceUrl }),
      };
    }
    if (summary !== undefined && summary.text.trim().length > 0) {
      const revealGroupId = element.name?.match(/^reveal-group:(.+)$/u)?.[1]?.trim();
      summaries.push({
        ...summary,
        ...(revealGroupId ? { revealGroupId } : {}),
        ...(element.ariaLabel === 'decorative' ? { decorative: true } : {}),
      });
    }
  }
  return summaries;
};

const summarizeNativeElement = (
  element: ReachDeckNativeElementV2,
): NarrationSlideElementSummary | undefined => {
  switch (element.type) {
    case 'textFrame':
      return { id: element.id, type: 'text', text: richTextToPlainText(element.text.doc) };
    case 'shape':
      if (element.style.fill?.kind === 'image') {
        // 图片填充形状（如 MAIC 椭圆裁剪图）缺描述时与 alt 为空的 image 同等处理：
        // 无可讲内容就不进清单，不让整页讲稿失败。
        const text = element.text === undefined ? '' : richTextToPlainText(element.text.doc);
        return {
          id: element.id,
          type: 'image',
          text: [element.ariaLabel, text].filter(Boolean).join('\n'),
        };
      }
      // 形状本体（无文字）对讲稿没有可讲述内容，只收带文字的形状。
      return element.text === undefined
        ? element.ariaLabel === 'decorative'
          ? { id: element.id, type: 'shape', text: 'decorative' }
          : undefined
        : { id: element.id, type: 'text', text: richTextToPlainText(element.text.doc) };
    case 'image':
      return { id: element.id, type: 'image', text: element.alt };
    case 'video':
      return { id: element.id, type: 'video', text: element.title };
    case 'scientificVisual':
      return {
        id: element.id,
        type: 'scientificVisual',
        text: element.manifest.textAlternative,
        scientificAnchors: element.manifest.anchors.map((anchor) => ({ ...anchor })),
      };
    case 'table': {
      const grid: string[][] = element.rowHeights.map(() =>
        element.columnWidths.map(() => '[blank]'),
      );
      element.rows.forEach((row, rowIndex) => {
        let column = 0;
        for (const cell of row.cells) {
          while (column < element.columnWidths.length && grid[rowIndex]?.[column] !== '[blank]')
            column += 1;
          if (column >= element.columnWidths.length || grid[rowIndex] === undefined) {
            throw new Error(
              `NARRATION_TABLE_GRID_INVALID: element ${element.id}, row ${rowIndex + 1}.`,
            );
          }
          const origin = `row ${rowIndex + 1}, column ${column + 1}`;
          for (let r = rowIndex; r < rowIndex + cell.rowSpan; r += 1) {
            for (let c = column; c < column + cell.columnSpan; c += 1) {
              if (grid[r]?.[c] === undefined || grid[r]![c] !== '[blank]') {
                throw new Error(`NARRATION_TABLE_GRID_INVALID: element ${element.id}, ${origin}.`);
              }
              grid[r]![c] = `[covered by ${origin}]`;
            }
          }
          grid[rowIndex]![column] =
            `${cell.header ? 'header' : 'cell'} (${origin}; rowSpan ${cell.rowSpan}, columnSpan ${cell.columnSpan}): ${JSON.stringify(richTextToPlainText(cell.text.doc))}`;
          column += cell.columnSpan;
        }
      });
      return {
        id: element.id,
        type: 'table',
        text: grid.map((row, index) => `Row ${index + 1}: ${row.join(' | ')}`).join('\n'),
      };
    }
    default:
      return undefined;
  }
};

/** Exact canonical projection avoids digest collisions and stays browser-compatible. */
export const nativeSlideNarrationContentBaseline = (slide: ReachDeckNativeSlideV2): string =>
  JSON.stringify(
    slide.elements.flatMap((element) => {
      if (element.hidden === true) return [];
      const summary = summarizeNativeElement(element);
      return summary === undefined || summary.text.trim().length === 0 ? [] : [summary];
    }),
  );

export const isNativeSlideNarrationContentStale = (slide: ReachDeckNativeSlideV2): boolean =>
  slide.narration?.contentBaseline !== undefined &&
  slide.narration.contentBaseline !== nativeSlideNarrationContentBaseline(slide);

export const preserveNativeSlideNarrationContentBaseline = (
  previous: ReachDeckNativeSlideV2,
  next: ReachDeckNativeSlideV2,
): ReachDeckNativeSlideV2 => {
  if (
    next.narration === undefined ||
    previous.narration === undefined ||
    next.narration.contentBaseline !== undefined
  )
    return next;
  const baseline =
    previous.narration.contentBaseline ?? nativeSlideNarrationContentBaseline(previous);
  if (baseline === nativeSlideNarrationContentBaseline(next)) return next;
  return { ...next, narration: { ...next.narration, contentBaseline: baseline } };
};

/**
 * 剥离讲稿阶段会写回的字段，得到 native slide 的"版面内容"稳定形态（设计定案：
 * 讲稿/动画/duration 剥离后做 digest）。
 *
 * 全部 animations 一并剥离（含教师自建动画），原因有二：
 * 1. 讲稿落地会改写动画，若留在 digest 里，落地本身就会改变 digest、让同一产物的
 *    重放校验永不通过；
 * 2. 动画不参与讲稿输入（元素清单不含动画），教师调整自建动画不该作废在途讲稿任务。
 * digest 计算留在服务端（node:crypto），本函数保持纯剥离、浏览器可用。
 */
export const stripReachDeckNativeSlideNarration = (
  slide: ReachDeckNativeSlideV2,
): Omit<ReachDeckNativeSlideV2, 'narration' | 'animations' | 'duration'> => {
  const { narration: _narration, animations: _animations, duration: _duration, ...rest } = slide;
  return rest;
};

/** 一段已回填真实秒数的讲稿（native 写回输入）。 */
export interface ReachDeckNativeNarrationSegmentInput {
  text: string;
  /** 音频内秒偏移；TTS 时间戳缺失（降级）时可整段缺省，写回后播放按无时间戳处理。 */
  start?: number;
  end?: number;
  /** @deprecated Compatibility-only input; new generation uses input.reveals. */
  revealElementIds?: readonly string[];
  /** @deprecated Compatibility-only input; new generation uses input.reveals. */
  revealEffect?: EntranceAnimationPresetName;
  /** TTS 真实对齐产出的词级时间戳（秒）；降级路径缺省。 */
  words?: ReadonlyArray<{ text: string; start: number; end: number }>;
}

/** Temporary inner segments are compiled to these animation-only anchors before persistence. */
export interface ReachDeckNativeNarrationRevealInput {
  start: number;
  revealElementIds: readonly string[];
  revealEffect?: EntranceAnimationPresetName;
}

export interface ApplyReachDeckNarrationToNativeSlideInput {
  /** skip produces audio only and clears all animations after complete audio succeeds. */
  animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
  /** 权威整页讲稿；缺省时保留 slide 上已有的 markdown，以兼容旧生成调用方。 */
  markdown?: string;
  /** Provider-neutral speech semantics for the authoritative markdown. */
  speechMarkup?: ReachDeckSpeechMarkupV1;
  segments: readonly ReachDeckNativeNarrationSegmentInput[];
  reveals?: readonly ReachDeckNativeNarrationRevealInput[];
  /** Explicit preserve-mode visibility decisions; remove only narration-driven entrances. */
  persistentElementIds?: readonly string[];
  /** 整页讲稿音频的 v2 媒体资源 id；音频合成失败（降级）时缺省。 */
  audioResourceId?: string;
  /** Narration-owned timing projection for declared scientific visual anchors. */
  scientificAnchorBindings?: readonly ReachDeckScientificAnchorBindingV1[];
  /** 页时长（秒）：讲稿音频时长 + 收尾余量，由调用方按时间轴推导。 */
  duration: number;
}

export interface ApplyReachDeckNarrationToNativeSlideResult {
  slide: ReachDeckNativeSlideV2;
  /** 中文诊断：被跳过的 reveal 锚点等，调用方记日志即可，不阻断写回。 */
  diagnostics: string[];
}

/**
 * 讲稿产物写回 v2 native slide（纯函数）。
 *
 * 数据源：讲稿阶段产物（真实秒段落 + reveal 锚点 + 整页音频资源 id）。核心逻辑：
 * 1. narration 覆写为 `{ audioResourceId?, segments(text+start/end) }`；
 * 2. 入场动画重编：剔除既有**讲稿驱动**动画（id 前缀识别，见
 *    `REACH_DECK_NARRATION_ANIMATION_ID_PREFIX`），保留教师自建/导入动画；
 *    对每段带时间戳且有 reveal 锚点的段落，按 `revealEffect` 具名预设（缺省按
 *    元素类型回落）生成 `on-enter` 动画，秒数取该段 start；每个元素至多一条入场
 *    动画（与编译层同规），目标不存在或已有教师入场动画时跳过并记诊断；
 * 3. duration 覆写为调用方推导的页时长。
 * 产物应由调用方再过 `parseReachDeckNativeSlideV2` 严格校验后落库。
 */
export const applyReachDeckNarrationToNativeSlide = (
  slide: ReachDeckNativeSlideV2,
  input: ApplyReachDeckNarrationToNativeSlideInput,
): ApplyReachDeckNarrationToNativeSlideResult => {
  const diagnostics: string[] = [];
  const segments = input.segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => ({
      text: segment.text,
      ...(segment.start !== undefined && segment.end !== undefined
        ? { start: segment.start, end: segment.end }
        : {}),
      // 词级只在段级窗口有效时保留（无窗口的段词级无从锚定），与编译层同规。
      ...(segment.start !== undefined &&
      segment.end !== undefined &&
      segment.words !== undefined &&
      segment.words.length > 0
        ? { words: segment.words.map((word) => ({ ...word })) }
        : {}),
    }));

  const elementTypeById = collectAnimatableElementTypes(slide.elements);
  // 教师自建动画保留；其入场目标同样占用"每元素一条入场动画"的名额，避免同一元素
  // 讲稿动画与教师动画叠加导致二次入场闪烁。
  const keptAnimations = slide.animations.filter(
    (animation) => !isReachDeckNarrationDrivenAnimation(animation),
  );
  const animated = new Set(keptAnimations.map((animation) => animation.targetId));
  const narrationAnimations: ReachDeckAnimationV2[] = [];
  // A container shared by several reveal groups enters with the earliest one, so reveals claim
  // their targets in time order (stable for equal starts).
  const reveals = [
    ...(input.reveals ??
      input.segments.flatMap((segment) =>
        segment.start === undefined || (segment.revealElementIds ?? []).length === 0
          ? []
          : [
              {
                start: segment.start,
                revealElementIds: segment.revealElementIds!,
                ...(segment.revealEffect === undefined
                  ? {}
                  : { revealEffect: segment.revealEffect }),
              },
            ],
      )),
  ].sort((left, right) => revealSortKey(left.start) - revealSortKey(right.start));
  (input.animationMode === 'skip' ? [] : reveals).forEach((reveal, index) => {
    const targets = reveal.revealElementIds;
    if (targets.length === 0) return;
    if (!Number.isFinite(reveal.start) || reveal.start < 0) {
      diagnostics.push(`讲稿分段 ${index} 的入场起点无效，已跳过。`);
      return;
    }
    for (const targetId of targets) {
      const elementType = elementTypeById.get(targetId);
      if (elementType === undefined) {
        diagnostics.push(`讲稿分段 ${index} 的 reveal 目标 ${targetId} 不存在，已跳过。`);
        continue;
      }
      if (animated.has(targetId)) {
        diagnostics.push(`元素 ${targetId} 已有入场动画，讲稿分段 ${index} 的动画已跳过。`);
        continue;
      }
      animated.add(targetId);
      const presetName = isEntranceAnimationPresetName(reveal.revealEffect)
        ? reveal.revealEffect
        : defaultPresetForNativeElement(elementType);
      const preset = ENTRANCE_ANIMATION_PRESETS[presetName];
      narrationAnimations.push({
        id: `${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX}${targetId}`,
        targetId,
        trigger: 'on-enter',
        effect: preset.effect,
        start: reveal.start,
        duration: preset.duration,
        easing: preset.easing,
        // appear 预设无补间：不落空的 from/to，播放运行时到点即完全可见。
        ...(Object.keys(preset.from).length === 0 ? {} : { from: { ...preset.from } }),
        ...(Object.keys(preset.to).length === 0 ? {} : { to: { ...preset.to } }),
      });
    }
  });

  if (input.animationMode === 'animations') {
    return {
      slide: { ...slide, animations: [...keptAnimations, ...narrationAnimations] },
      diagnostics,
    };
  }

  // 讲稿是整体覆写语义：产物没有有效段落时旧 narration 一并移除，不能残留半套。
  const { narration: _previousNarration, ...base } = slide;
  const markdown =
    input.markdown === undefined
      ? slide.narration?.markdown
      : normalizeReachDeckNarrationMarkdown(input.markdown);
  const speechMarkup =
    input.speechMarkup === undefined
      ? input.markdown === undefined
        ? cloneSpeechMarkup(slide.narration?.speechMarkup)
        : undefined
      : cloneSpeechMarkup(parseReachDeckSpeechMarkupV1(input.speechMarkup, markdown!));
  const hasCompleteAuthoritativeResult =
    markdown === undefined ||
    (input.audioResourceId !== undefined &&
      segments.length > 0 &&
      segments.every((segment) => segment.start !== undefined && segment.end !== undefined));
  const hasAuthoritativeScientificTiming =
    input.audioResourceId !== undefined &&
    segments.length > 0 &&
    segments.every((segment) => segment.start !== undefined && segment.end !== undefined);
  if (!hasCompleteAuthoritativeResult) {
    return {
      slide: {
        ...base,
        animations:
          input.animationMode === 'skip' || input.animationMode === 'preserve'
            ? slide.animations
            : keptAnimations,
        narration: {
          markdown: markdown!,
          ...(slide.narration?.contentBaseline === undefined
            ? {}
            : { contentBaseline: slide.narration.contentBaseline }),
          ...(speechMarkup === undefined ? {} : { speechMarkup }),
        },
      },
      diagnostics: [...diagnostics, '权威讲稿尚无完整音频与时间数据，已保留为可重试的失效草稿。'],
    };
  }
  const persistentTargets = new Set(input.persistentElementIds ?? []);
  const elementIds = collectReachDeckNativeElementIds(slide.elements);
  const appliedAnimations =
    input.animationMode === 'skip'
      ? []
      : input.animationMode === 'preserve'
        ? slide.animations.flatMap((animation) => {
            if (!isReachDeckNarrationDrivenAnimation(animation)) return [animation];
            // 目标已删除的孤儿动画原样保留：播放时本就忽略，不能因它对齐失败而整页报错。
            if (!elementIds.has(animation.targetId)) return [animation];
            if (persistentTargets.has(animation.targetId)) return [];
            const reveal = reveals.find((candidate) =>
              candidate.revealElementIds.includes(animation.targetId),
            );
            if (reveal === undefined || !Number.isFinite(reveal.start) || reveal.start < 0) {
              throw new Error('NARRATION_ANIMATION_ALIGNMENT_FAILED');
            }
            return [{ ...animation, start: reveal.start }];
          })
        : [...keptAnimations, ...narrationAnimations];
  return {
    slide: {
      ...base,
      animations: appliedAnimations,
      duration: Math.max(
        input.duration,
        ...appliedAnimations
          .filter((animation) => elementIds.has(animation.targetId))
          .map((animation) => animation.start + animation.duration),
      ),
      ...(segments.length === 0
        ? markdown === undefined
          ? {}
          : { narration: { markdown } }
        : {
            narration: {
              contentBaseline: nativeSlideNarrationContentBaseline(slide),
              ...(markdown === undefined ? {} : { markdown }),
              ...(speechMarkup === undefined ? {} : { speechMarkup }),
              ...(input.audioResourceId === undefined
                ? {}
                : { audioResourceId: input.audioResourceId }),
              segments,
              ...(hasAuthoritativeScientificTiming && input.scientificAnchorBindings !== undefined
                ? {
                    scientificAnchorBindings: input.scientificAnchorBindings.map((binding) => ({
                      ...binding,
                    })),
                  }
                : {}),
            },
          }),
    },
    diagnostics,
  };
};

/** Save exact teacher content while atomically removing all derived narration state. */
export const invalidateReachDeckNativeSlideNarration = (
  slide: ReachDeckNativeSlideV2,
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
  options?: { preserveAnimations?: boolean },
): ReachDeckNativeSlideV2 => {
  const canonical = normalizeReachDeckNarrationMarkdown(markdown);
  const canonicalSpeechMarkup =
    speechMarkup === undefined
      ? undefined
      : cloneSpeechMarkup(parseReachDeckSpeechMarkupV1(speechMarkup, canonical));
  const { duration: _duration, ...rest } = slide;
  return {
    ...rest,
    animations:
      options?.preserveAnimations === true
        ? slide.animations
        : slide.animations.filter((animation) => !isReachDeckNarrationDrivenAnimation(animation)),
    narration: {
      ...(slide.narration?.contentBaseline === undefined
        ? {}
        : { contentBaseline: slide.narration.contentBaseline }),
      markdown: canonical,
      ...(canonicalSpeechMarkup === undefined ? {} : { speechMarkup: canonicalSpeechMarkup }),
    },
  };
};

/**
 * 仅重写讲稿文字（textOnly）产物写回 native slide（纯函数）。
 *
 * 数据源：讲稿模型重写出的权威正文（无音频、无时间轴）。核心逻辑：
 * 1. 与 `invalidateReachDeckNativeSlideNarration` 同一语义：写入新正文与 speechMarkup，
 *    清除音频引用、segments、页时长、科学锚点绑定与讲稿驱动动画，保留教师自建动画；
 * 2. 新正文是对着当前版面写的，contentBaseline 取当前版面基线，而不是沿用旧讲稿的基线，
 *    避免刚重写的讲稿立即被判为"版面已变、讲稿过时"。
 */
export const applyReachDeckTextOnlyNarrationToNativeSlide = (
  slide: ReachDeckNativeSlideV2,
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): ReachDeckNativeSlideV2 => {
  const invalidated = invalidateReachDeckNativeSlideNarration(slide, markdown, speechMarkup);
  const { contentBaseline: _previousBaseline, ...narration } = invalidated.narration!;
  return {
    ...invalidated,
    narration: { contentBaseline: nativeSlideNarrationContentBaseline(slide), ...narration },
  };
};

const cloneSpeechMarkup = (
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): ReachDeckSpeechMarkupV1 | undefined =>
  speechMarkup === undefined
    ? undefined
    : {
        schemaVersion: speechMarkup.schemaVersion,
        marks: speechMarkup.marks.map((mark) => ({ ...mark })),
        ...(speechMarkup.speak === undefined ? {} : { speak: { ...speechMarkup.speak } }),
      };

/** Invalid starts keep their relative order at the end, where they are reported and skipped. */
const revealSortKey = (start: number): number =>
  Number.isFinite(start) && start >= 0 ? start : Number.POSITIVE_INFINITY;

/** 仅顶层元素可作 reveal 目标（与 serializer 同一取值域），记录类型供预设回落。 */
const collectAnimatableElementTypes = (
  elements: readonly ReachDeckNativeElementV2[],
): Map<string, ReachDeckNativeElementV2['type']> => {
  const types = new Map<string, ReachDeckNativeElementV2['type']>();
  for (const element of elements)
    types.set(
      element.id,
      element.type === 'shape' && element.style.fill?.kind === 'image' ? 'image' : element.type,
    );
  return types;
};

/** native 元素类型 → 缺省入场预设：文本类上浮、媒体类淡入，其余类型淡入兜底。 */
const defaultPresetForNativeElement = (
  elementType: ReachDeckNativeElementV2['type'],
): EntranceAnimationPresetName => {
  switch (elementType) {
    case 'textFrame':
    case 'shape':
      return DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE.textFrame;
    case 'image':
      return DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE.image;
    case 'video':
      return DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE.video;
    case 'scientificVisual':
      return DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE.scientificVisual;
    default:
      return 'fade';
  }
};
