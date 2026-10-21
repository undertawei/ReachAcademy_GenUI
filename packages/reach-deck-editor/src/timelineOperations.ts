export const MIN_TIMELINE_CLIP_DURATION = 0.1;
export const TIMELINE_STEP = 0.1;

/** 时间轴动画几何操作只关心 id/start/duration，v1 DeckAnimation 与 v2 ReachDeckAnimationV2 均满足。 */
export interface TimelineAnimationItem {
  id: string;
  start: number;
  duration: number;
}

/** 讲稿分段的展示窗输入：v2 narration 分段在 TTS 降级时可缺时间戳。 */
export interface TimelineNarrationWindow {
  start?: number;
  end?: number;
}

export function secondsToPixels(seconds: number, pixelsPerSecond: number): number {
  return seconds * pixelsPerSecond;
}

export function pixelsToSeconds(pixels: number, pixelsPerSecond: number): number {
  return pixelsPerSecond <= 0 ? 0 : pixels / pixelsPerSecond;
}

export function snapTimelineTime(value: number, step = TIMELINE_STEP): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.round(value / step) * step * 1_000_000_000) / 1_000_000_000;
}

export function timelineExtent(
  duration: number,
  narration: readonly TimelineNarrationWindow[],
  animations: readonly TimelineAnimationItem[],
  padding = 2,
): number {
  const cueEnd = narration.reduce((maximum, window) => Math.max(maximum, window.end ?? 0), 0);
  const animationEnd = animations.reduce(
    (maximum, animation) => Math.max(maximum, animation.start + animation.duration),
    0,
  );
  return Math.max(duration, cueEnd, animationEnd) + padding;
}

export function timelineContentDuration(
  narration: readonly TimelineNarrationWindow[],
  animations: readonly TimelineAnimationItem[],
): number {
  const cueEnd = narration.reduce((maximum, window) => Math.max(maximum, window.end ?? 0), 0);
  const animationEnd = animations.reduce(
    (maximum, animation) => Math.max(maximum, animation.start + animation.duration),
    0,
  );
  return Math.max(MIN_TIMELINE_CLIP_DURATION, snapTimelineTime(Math.max(cueEnd, animationEnd)));
}

export function moveAnimation<T extends TimelineAnimationItem>(
  animation: T,
  delta: number,
  laneAnimations: readonly T[] = [animation],
): T {
  const { previous, next } = animationNeighbours(animation.id, laneAnimations);
  const length = Math.max(MIN_TIMELINE_CLIP_DURATION, animation.duration);
  const lower = previous === undefined ? 0 : previous.start + previous.duration;
  const upper = next === undefined ? Number.POSITIVE_INFINITY : next.start - length;
  return {
    ...animation,
    start: clamp(snapTimelineTime(animation.start + delta), lower, Math.max(lower, upper)),
  };
}

export function resizeAnimation<T extends TimelineAnimationItem>(
  animation: T,
  edge: 'start' | 'end',
  delta: number,
  laneAnimations: readonly T[] = [animation],
): T {
  const { previous, next } = animationNeighbours(animation.id, laneAnimations);
  if (edge === 'start') {
    const end = animation.start + animation.duration;
    const start = clamp(
      snapTimelineTime(animation.start + delta),
      previous === undefined ? 0 : previous.start + previous.duration,
      end - MIN_TIMELINE_CLIP_DURATION,
    );
    return { ...animation, start, duration: snapTimelineTime(end - start) };
  }
  return {
    ...animation,
    duration: clamp(
      snapTimelineTime(animation.duration + delta),
      MIN_TIMELINE_CLIP_DURATION,
      next === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(MIN_TIMELINE_CLIP_DURATION, next.start - animation.start),
    ),
  };
}

/** 把动画放进目标轨最近的可用空隙，用于新增动画和跨轨移动。 */
export function placeAnimationInLane<T extends TimelineAnimationItem>(
  animation: T,
  laneAnimations: readonly T[],
): T {
  const duration = Math.max(MIN_TIMELINE_CLIP_DURATION, animation.duration);
  const preferredStart = Math.max(0, snapTimelineTime(animation.start));
  const ordered = laneAnimations
    .filter((candidate) => candidate.id !== animation.id)
    .sort(compareTimelineItems);
  const candidates: number[] = [];
  let gapStart = 0;
  for (const candidate of ordered) {
    const gapEnd = candidate.start;
    if (gapEnd - gapStart >= duration) {
      candidates.push(clamp(preferredStart, gapStart, gapEnd - duration));
    }
    gapStart = Math.max(gapStart, candidate.start + candidate.duration);
  }
  candidates.push(Math.max(preferredStart, gapStart));
  const start = candidates.reduce((closest, candidate) =>
    Math.abs(candidate - preferredStart) < Math.abs(closest - preferredStart) ? candidate : closest,
  );
  return { ...animation, duration, start: snapTimelineTime(start) };
}

export interface AnimationLaneLayout {
  count: number;
  byAnimationId: Record<string, number>;
}

/** 给遗留的并行动画分配最少数量的无重叠轨道。 */
export function buildAnimationLaneLayout<T extends TimelineAnimationItem>(
  animations: readonly T[],
  preferred?: AnimationLaneLayout,
): AnimationLaneLayout {
  const lanes = Array.from({ length: Math.max(1, preferred?.count ?? 1) }, () => [] as T[]);
  const byAnimationId: Record<string, number> = {};
  const ordered = [...animations].sort(compareTimelineItems);
  const place = (animation: T, requestedLane?: number) => {
    let lane =
      requestedLane !== undefined && animationFitsLane(animation, lanes[requestedLane] ?? [])
        ? requestedLane
        : lanes.findIndex((candidate) => animationFitsLane(animation, candidate));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push(animation);
    byAnimationId[animation.id] = lane;
  };
  for (const animation of ordered) {
    const requestedLane = preferred?.byAnimationId[animation.id];
    if (requestedLane !== undefined) place(animation, requestedLane);
  }
  for (const animation of ordered) {
    if (preferred?.byAnimationId[animation.id] !== undefined) continue;
    place(animation);
  }
  return { count: lanes.length, byAnimationId };
}

export interface AnimationLane<T extends TimelineAnimationItem = TimelineAnimationItem> {
  id: string;
  targetId: string;
  index: number;
  animations: T[];
}

export function buildAnimationLanes<T extends TimelineAnimationItem & { targetId: string }>(
  animations: readonly T[],
): AnimationLane<T>[] {
  const byTarget = new Map<string, T[]>();
  for (const animation of animations) {
    const current = byTarget.get(animation.targetId) ?? [];
    current.push(animation);
    byTarget.set(animation.targetId, current);
  }

  const lanes: AnimationLane<T>[] = [];
  for (const [targetId, targetAnimations] of [...byTarget.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const targetLanes: T[][] = [];
    for (const animation of [...targetAnimations].sort(compareTimelineItems)) {
      const available = targetLanes.find(
        (lane) => (lane.at(-1)?.start ?? 0) + (lane.at(-1)?.duration ?? 0) <= animation.start,
      );
      if (available) available.push(animation);
      else targetLanes.push([animation]);
    }
    targetLanes.forEach((lane, index) =>
      lanes.push({ id: `${targetId}:${index}`, targetId, index, animations: lane }),
    );
  }
  return lanes;
}

function animationNeighbours<T extends TimelineAnimationItem>(
  animationId: string,
  laneAnimations: readonly T[],
): { previous?: T; next?: T } {
  const ordered = [...laneAnimations].sort(compareTimelineItems);
  const index = ordered.findIndex((animation) => animation.id === animationId);
  if (index < 0) return {};
  return { previous: ordered[index - 1], next: ordered[index + 1] };
}

function compareTimelineItems<T extends TimelineAnimationItem>(left: T, right: T): number {
  return left.start === right.start ? left.id.localeCompare(right.id) : left.start - right.start;
}

function animationFitsLane<T extends TimelineAnimationItem>(
  animation: T,
  laneAnimations: readonly T[],
): boolean {
  const end = animation.start + animation.duration;
  return laneAnimations.every(
    (candidate) =>
      end <= candidate.start || animation.start >= candidate.start + candidate.duration,
  );
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

/**
 * 与服务端 slide-model-output.ts 的 NARRATION_PLACEHOLDER_SEGMENT_SECONDS 对齐：
 * services 包不可被前端引用，此处以具名常量复刻，改动需两侧同步。
 */
export const NARRATION_FALLBACK_SEGMENT_SECONDS = 7;

export interface NarrationDisplayWindow {
  index: number;
  start: number;
  end: number;
  text: string;
  /** TTS 词级时间戳（持久化于 v2 narration segment）；降级路径缺省。 */
  words?: readonly { text: string; start: number; end: number }[];
}

/**
 * v2 讲稿固定轴的展示窗：有真实 TTS 时间戳的分段原样定位；缺时间戳（降级）
 * 的分段从游标处顺推占位窗。只影响展示，绝不写回 narration。
 */
export function narrationDisplayWindows(
  segments: readonly {
    text: string;
    start?: number;
    end?: number;
    words?: readonly { text: string; start: number; end: number }[];
  }[],
): NarrationDisplayWindow[] {
  let cursor = 0;
  return segments.map((segment, index) => {
    const hasTiming =
      segment.start !== undefined && segment.end !== undefined && segment.end > segment.start;
    const start = hasTiming ? segment.start! : cursor;
    const end = hasTiming ? segment.end! : cursor + NARRATION_FALLBACK_SEGMENT_SECONDS;
    cursor = Math.max(cursor, end);
    return {
      index,
      start,
      end,
      text: segment.text,
      ...(hasTiming && segment.words !== undefined && segment.words.length > 0
        ? { words: segment.words }
        : {}),
    };
  });
}

/** 讲稿单条固定条的结束时间：取所有展示窗末端的最大值，无讲稿时为 0。 */
export function narrationBarEnd(windows: readonly NarrationDisplayWindow[]): number {
  return windows.reduce((maximum, window) => Math.max(maximum, window.end), 0);
}

export interface NarrationCharacterMark {
  /** 可视 token；英文单词保持整体，中文在窄缩放下按密度抽样。 */
  char: string;
  /** `char` 是去掉定界符的公式 LaTeX，展示侧渲染成公式而不是源码。 */
  formula?: true;
  /** 字符中点对应的音频时间（秒）。 */
  time: number;
}

/**
 * 把讲稿文字按时间戳铺到轴上。优先用段内持久化的 TTS 词级时间戳：词内字符在
 * 词窗 [start, end] 内均匀插值取中点；无词级（缓存命中/占位窗降级）时回退
 * 段级均匀插值。只用于展示。
 */
export function narrationCharacterMarks(
  windows: readonly NarrationDisplayWindow[],
  pixelsPerSecond = 72,
): NarrationCharacterMark[] {
  const marks: NarrationCharacterMark[] = [];
  for (const window of windows) {
    const windowMarks: NarrationCharacterMark[] = [];
    if (window.words !== undefined && window.words.length > 0) {
      for (const word of normalizeNarrationFormulaWords(window.words)) {
        const tokens = narrationDisplayTokens(word.text);
        const span = Math.max(0, word.end - word.start);
        const weight = tokens.reduce((total, token) => total + [...token.text].length, 0);
        let offset = 0;
        tokens.forEach((token) => {
          const length = [...token.text].length;
          windowMarks.push({
            char: token.text,
            time: word.start + ((offset + length / 2) * span) / Math.max(1, weight),
            ...(token.formula ? { formula: true as const } : {}),
          });
          offset += length;
        });
      }
    } else {
      const tokens = narrationDisplayTokens(window.text);
      const span = Math.max(0, window.end - window.start);
      const weight = tokens.reduce((total, token) => total + [...token.text].length, 0);
      let offset = 0;
      tokens.forEach((token) => {
        const length = [...token.text].length;
        windowMarks.push({
          char: token.text,
          time: window.start + ((offset + length / 2) * span) / Math.max(1, weight),
          ...(token.formula ? { formula: true as const } : {}),
        });
        offset += length;
      });
    }
    // 字幕最小中心距约 14px。缩得越窄，中文只展示代表字符；英文单词始终作为整体。
    const minimumSeconds = 14 / Math.max(1, pixelsPerSecond);
    let lastTime = Number.NEGATIVE_INFINITY;
    for (const mark of windowMarks) {
      if (mark.time - lastTime < minimumSeconds) continue;
      marks.push(mark);
      lastTime = mark.time;
    }
  }
  return marks;
}

/** 完整闭合的行内 `\(…\)` / 块级 `\[…\]` 公式源码（含定界符）。 */
const NARRATION_FORMULA_PATTERN = /\\\((.*?)\\\)|\\\[(.*?)\\\]/gsu;

type NarrationWord = { text: string; start: number; end: number };

/**
 * 展示侧兜底：历史数据里 TTS 条目会把公式定界符吸附到相邻词上（如 `足 \(` +
 * `y=2x+1\) `）。按词文本拼接后重新识别完整公式，把它收拢成一个原子词（时间取所有
 * 相交词的并集），公式外的残片保留原词时间。只影响展示，不回写数据。
 */
export function normalizeNarrationFormulaWords(
  words: readonly NarrationWord[],
): readonly NarrationWord[] {
  const full = words.map((word) => word.text).join('');
  const formulas = [...full.matchAll(NARRATION_FORMULA_PATTERN)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
  if (formulas.length === 0) return words;
  const result: NarrationWord[] = [];
  const formulaWords = new Map<(typeof formulas)[number], NarrationWord>();
  let offset = 0;
  for (const word of words) {
    const from = offset;
    const to = offset + word.text.length;
    offset = to;
    let cursor = from;
    for (const formula of formulas) {
      if (formula.to <= cursor || formula.from >= to) continue;
      pushPiece(result, word, full.slice(cursor, formula.from));
      const existing = formulaWords.get(formula);
      if (existing === undefined) {
        const merged = {
          text: full.slice(formula.from, formula.to),
          start: word.start,
          end: word.end,
        };
        formulaWords.set(formula, merged);
        result.push(merged);
      } else {
        existing.start = Math.min(existing.start, word.start);
        existing.end = Math.max(existing.end, word.end);
      }
      cursor = Math.min(to, formula.to);
    }
    pushPiece(result, word, full.slice(cursor, to));
  }
  return result;
}

/** 公式外的残片沿用原词时间；纯空白残片不成词。 */
function pushPiece(result: NarrationWord[], word: NarrationWord, text: string): void {
  if (text.trim().length > 0) result.push({ ...word, text });
}

/**
 * 英文/数字按词展示，其余非空白 Unicode 字符维持逐字符时间语义；完整公式整体作为一个
 * token（去掉定界符），绝不拆出孤立的 `\`、`(`、`)`。
 */
function narrationDisplayTokens(value: string): Array<{ text: string; formula: boolean }> {
  const tokens: Array<{ text: string; formula: boolean }> = [];
  const plain = (text: string) =>
    narrationPlainTokens(text).forEach((token) => tokens.push({ text: token, formula: false }));
  let cursor = 0;
  for (const match of value.matchAll(NARRATION_FORMULA_PATTERN)) {
    plain(value.slice(cursor, match.index));
    const body = (match[1] ?? match[2] ?? '').trim();
    if (body.length > 0) tokens.push({ text: body, formula: true });
    cursor = match.index + match[0].length;
  }
  plain(value.slice(cursor));
  return tokens;
}

function narrationPlainTokens(value: string): string[] {
  // Stored narration Markdown escapes punctuation such as `\+`; show the character itself.
  const text = value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu, '$1');
  return text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\s]/gu) ?? [];
}
