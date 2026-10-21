import {
  isReachDeckNarrationDrivenAnimation,
  type ReachDeckNativeSlideV2,
  type ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';

/** 页面列表缩略图上按生成通道展示的四枚状态图标。 */
export type ReachDeckPageLane = 'layout' | 'image' | 'narration' | 'audio' | 'animation';
export type ReachDeckPageLaneState = 'ready' | 'generating' | 'attention' | 'none';
export type ReachDeckPageLaneStatuses = Readonly<
  Partial<Record<ReachDeckPageLane, ReachDeckPageLaneState>>
>;

export const REACH_DECK_PAGE_LANES: readonly ReachDeckPageLane[] = [
  'layout',
  'image',
  'narration',
  'audio',
  'animation',
];

/** 批次成员在这些状态下仍在排队或执行，页面对应通道显示"生成中"。 */
const IN_FLIGHT_BATCH_STATUSES = new Set([
  'waiting-predecessor',
  'waiting-dispatch',
  'dispatching',
  'queued',
  'registered',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
  'running',
  'active',
  'cancelling',
]);
const ATTENTION_BATCH_STATUSES = new Set(['failed', 'blocked']);

export interface ReachDeckPageLaneStatusInput {
  page: ReachDeckPublishedPage;
  nativeSlide?: Pick<ReachDeckNativeSlideV2, 'animations' | 'narration'>;
  /** 版面尚未落地（宿主 lockedPageIds 包含该页）。 */
  locked?: boolean;
  imageStatus?: ReachDeckPageLaneState;
  generationStatus?: {
    affectedLanes?: readonly ReachDeckPageLane[];
    phase: 'layout' | 'narration';
    state: 'loading' | 'failed' | 'manual-review-required';
  };
  batchStatuses?: readonly {
    status: string;
    kind?: 'narration' | 'media' | 'regeneration';
    affectedLanes?: readonly ReachDeckPageLane[];
  }[];
}

/**
 * 把文档内容、宿主投影的生成状态与批次状态合成每页四个通道的状态。
 *
 * 规则优先级：批次/生成态里的"进行中"与"失败" > 文档中是否已有内容。
 * 通道内容判定只看已落地的文档：讲稿=markdown，语音=audioResourceId，
 * 动画=讲稿驱动的入场动画；正在重生成但旧内容仍在时，只有明确的批次
 * kind 能把对应通道标为"生成中"，否则以内容为准。
 */
export function deriveReachDeckPageLaneStatuses(
  input: ReachDeckPageLaneStatusInput,
): ReachDeckPageLaneStatuses {
  const { page, nativeSlide, locked = false, generationStatus, batchStatuses = [] } = input;
  const pureImage =
    generationStatus?.affectedLanes?.length === 1 && generationStatus.affectedLanes[0] === 'image';
  const layoutGenerating =
    locked ||
    (!pureImage && generationStatus?.phase === 'layout' && generationStatus.state === 'loading');
  let layout: ReachDeckPageLaneState =
    !pureImage && generationStatus?.phase === 'layout' && generationStatus.state === 'failed'
      ? 'attention'
      : layoutGenerating
        ? 'generating'
        : 'ready';
  for (const batch of batchStatuses) {
    if (batch.kind !== 'regeneration' || !batch.affectedLanes?.includes('layout')) continue;
    if (IN_FLIGHT_BATCH_STATUSES.has(batch.status)) layout = 'generating';
    else if (ATTENTION_BATCH_STATUSES.has(batch.status) && layout !== 'generating')
      layout = 'attention';
  }
  if (page.sceneType === 'quiz') return { layout };

  const content =
    page.sceneType === 'slide'
      ? {
          narration: (nativeSlide?.narration?.markdown?.trim().length ?? 0) > 0,
          audio: nativeSlide?.narration?.audioResourceId !== undefined,
          animation: nativeSlide?.animations.some(isReachDeckNarrationDrivenAnimation) ?? false,
        }
      : {
          narration: (page.scene.narration?.text.trim().length ?? 0) > 0,
          audio: page.scene.narration?.audioResourceId !== undefined,
          animation: false,
        };
  const lanes: Record<Exclude<ReachDeckPageLane, 'layout'>, ReachDeckPageLaneState> = {
    image: input.imageStatus ?? 'none',
    narration: content.narration ? 'ready' : 'none',
    audio: content.audio ? 'ready' : 'none',
    animation: content.animation ? 'ready' : 'none',
  };
  const narrationLanes: (keyof typeof lanes)[] =
    page.sceneType === 'slide' ? ['narration', 'audio', 'animation'] : ['narration', 'audio'];

  if (generationStatus?.affectedLanes?.includes('image'))
    lanes.image = generationStatus.state === 'loading' ? 'generating' : 'attention';
  for (const batch of batchStatuses) {
    if (batch.affectedLanes?.includes('image')) {
      if (IN_FLIGHT_BATCH_STATUSES.has(batch.status)) lanes.image = 'generating';
      else if (ATTENTION_BATCH_STATUSES.has(batch.status) && lanes.image !== 'generating')
        lanes.image = 'attention';
    }
  }

  // Regeneration advertises its selected downstream work before layout lands. Old artifacts
  // remain saved until success, but must not look ready while their replacements are pending.
  if (generationStatus?.phase === 'layout' && generationStatus.state === 'loading') {
    for (const lane of generationStatus.affectedLanes ?? []) {
      if (lane !== 'layout' && narrationLanes.includes(lane)) lanes[lane] = 'generating';
    }
  }

  // 版面还没落地时，宿主投影的 narration 阶段状态无从谈起：它描述的是这一页当前那一轮
  // 生成走到哪了，版面未落地就没有可信的讲稿轮次。
  if (!layoutGenerating && layout !== 'attention' && generationStatus?.phase === 'narration') {
    if (
      generationStatus.affectedLanes !== undefined &&
      generationStatus.state !== 'manual-review-required'
    ) {
      for (const lane of generationStatus.affectedLanes) {
        if (lane !== 'layout' && narrationLanes.includes(lane))
          lanes[lane] = generationStatus.state === 'loading' ? 'generating' : 'attention';
      }
    } else if (generationStatus.state === 'loading') {
      for (const lane of narrationLanes) if (lanes[lane] !== 'ready') lanes[lane] = 'generating';
    } else if (generationStatus.state === 'manual-review-required') {
      lanes.narration = 'attention';
    } else {
      const missing = narrationLanes.find((lane) => lanes[lane] !== 'ready');
      lanes[missing ?? 'narration'] = 'attention';
    }
  }
  // 批次状态是服务端持久化的、按 kind 归属明确的信号，不受版面通道影响。此前它和上面的
  // narration 阶段判定共用一个 `!layoutGenerating` 门，于是宿主只要把某页标成 locked，
  // 缩略图就只剩一枚蓝色的版面图标，真正在跑的语音/动画通道反而全无状态。
  for (const batch of batchStatuses) {
    const affected: (keyof typeof lanes)[] =
      batch.kind === 'regeneration'
        ? (batch.affectedLanes ?? []).filter(
            (lane): lane is keyof typeof lanes =>
              lane !== 'layout' && narrationLanes.includes(lane),
          )
        : batch.kind === 'media'
          ? ['audio', 'animation']
          : batch.kind === 'narration'
            ? narrationLanes
            : [];
    if (IN_FLIGHT_BATCH_STATUSES.has(batch.status)) {
      for (const lane of affected) lanes[lane] = 'generating';
    } else if (ATTENTION_BATCH_STATUSES.has(batch.status) && batch.kind === 'regeneration') {
      for (const lane of affected) if (lanes[lane] !== 'generating') lanes[lane] = 'attention';
    } else if (ATTENTION_BATCH_STATUSES.has(batch.status)) {
      const target = batch.kind === 'media' ? 'audio' : 'narration';
      if (lanes[target] !== 'generating') lanes[target] = 'attention';
    }
  }

  return page.sceneType === 'slide'
    ? {
        layout,
        ...(input.imageStatus !== undefined ||
        generationStatus?.affectedLanes?.includes('image') ||
        batchStatuses.some((batch) => batch.affectedLanes?.includes('image'))
          ? { image: lanes.image }
          : {}),
        narration: lanes.narration,
        audio: lanes.audio,
        animation: lanes.animation,
      }
    : { layout, narration: lanes.narration, audio: lanes.audio };
}
