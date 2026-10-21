import { DECK_SAFE_AREA, STANDARD_ELEMENT_GAP } from './layoutContract.js';
import type { SlideContentBlueprint, SlideContentClassification } from './slideSemantics.js';
import type { DeckFrame } from './types.js';

export type SlideLayoutRecipeId =
  | 'single-focus-v1'
  | 'dominant-support-v1'
  | 'balanced-grid-v1'
  | 'horizontal-sequence-v1'
  | 'vertical-reasoning-v1';

export interface SlideLayoutSlot {
  id: string;
  role: 'primary' | 'supporting';
  contentUnitIds: string[];
  frame: DeckFrame;
}

/**
 * 语义 → 几何之间的确定性中间结果。
 *
 * LLM 仍负责选择 DSL 元素，但不再凭空猜测整张 1600×900 画布。计划中的 frame
 * 由纯函数生成，可记录、复现并在后续版本升级为完全由代码物化的布局编译器。
 */
export interface SlideLayoutPlan {
  schemaVersion: 'reach-deck-layout-plan/v1';
  recipeId: SlideLayoutRecipeId;
  titleFrame: DeckFrame;
  contentFrame: DeckFrame;
  slots: SlideLayoutSlot[];
  rules: string[];
}

const TITLE_FRAME: DeckFrame = {
  x: DECK_SAFE_AREA.x,
  y: DECK_SAFE_AREA.y,
  width: DECK_SAFE_AREA.width,
  height: 112,
};
const CONTENT_FRAME: DeckFrame = {
  x: DECK_SAFE_AREA.x,
  y: TITLE_FRAME.y + TITLE_FRAME.height + 32,
  width: DECK_SAFE_AREA.width,
  height: DECK_SAFE_AREA.y + DECK_SAFE_AREA.height - (TITLE_FRAME.y + TITLE_FRAME.height + 32),
};

const frame = (x: number, y: number, width: number, height: number): DeckFrame => ({
  x,
  y,
  width,
  height,
});

const split = (total: number, count: number, gap = STANDARD_ELEMENT_GAP): number =>
  (total - gap * Math.max(0, count - 1)) / count;

const verticalFrames = (bounds: DeckFrame, count: number): DeckFrame[] => {
  const height = split(bounds.height, count);
  return Array.from({ length: count }, (_, index) =>
    frame(bounds.x, bounds.y + index * (height + STANDARD_ELEMENT_GAP), bounds.width, height),
  );
};

const gridFrames = (bounds: DeckFrame, count: number, columns: number): DeckFrame[] => {
  const columnCount = Math.max(1, Math.min(columns, count));
  const rowCount = Math.ceil(count / columnCount);
  const width = split(bounds.width, columnCount);
  const height = split(bounds.height, rowCount);
  return Array.from({ length: count }, (_, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    return frame(
      bounds.x + column * (width + STANDARD_ELEMENT_GAP),
      bounds.y + row * (height + STANDARD_ELEMENT_GAP),
      width,
      height,
    );
  });
};

const dominantSupportFrames = (count: number): DeckFrame[] => {
  if (count <= 1) return [{ ...CONTENT_FRAME }];
  const primaryWidth = Math.round(CONTENT_FRAME.width * 0.64);
  const supportFrame = frame(
    CONTENT_FRAME.x + primaryWidth + STANDARD_ELEMENT_GAP,
    CONTENT_FRAME.y,
    CONTENT_FRAME.width - primaryWidth - STANDARD_ELEMENT_GAP,
    CONTENT_FRAME.height,
  );
  return [
    frame(CONTENT_FRAME.x, CONTENT_FRAME.y, primaryWidth, CONTENT_FRAME.height),
    ...verticalFrames(supportFrame, count - 1),
  ];
};

const selectRecipe = (
  classification: SlideContentClassification,
  count: number,
): { id: SlideLayoutRecipeId; frames: DeckFrame[] } => {
  if (count === 1) return { id: 'single-focus-v1', frames: [{ ...CONTENT_FRAME }] };
  if (
    classification.mediaType !== 'none' ||
    ['single_focus', 'media_annotation', 'data_evidence', 'question_reveal'].includes(
      classification.primaryType,
    )
  ) {
    return { id: 'dominant-support-v1', frames: dominantSupportFrames(count) };
  }
  if (classification.primaryType === 'worked_steps') {
    return { id: 'vertical-reasoning-v1', frames: verticalFrames(CONTENT_FRAME, count) };
  }
  if (classification.primaryType === 'sequence' && count <= 4) {
    return { id: 'horizontal-sequence-v1', frames: gridFrames(CONTENT_FRAME, count, count) };
  }
  const columns =
    classification.primaryType === 'comparison' ? 2 : count <= 3 ? count : count <= 4 ? 2 : 3;
  return { id: 'balanced-grid-v1', frames: gridFrames(CONTENT_FRAME, count, columns) };
};

export const compileSlideLayoutPlan = (
  blueprint: SlideContentBlueprint,
  classification: SlideContentClassification,
): SlideLayoutPlan => {
  const units = [...blueprint.contentUnits].sort((left, right) => {
    if (left.priority === right.priority) return 0;
    if (left.priority === 'primary') return -1;
    if (right.priority === 'primary') return 1;
    return left.priority === 'supporting' ? -1 : 1;
  });
  const selected = selectRecipe(classification, units.length);
  return {
    schemaVersion: 'reach-deck-layout-plan/v1',
    recipeId: selected.id,
    titleFrame: { ...TITLE_FRAME },
    contentFrame: { ...CONTENT_FRAME },
    slots: units.map((unit, index) => ({
      id: `slot-${index + 1}`,
      role: index === 0 ? 'primary' : 'supporting',
      contentUnitIds: [unit.id],
      frame: selected.frames[index],
    })),
    // 语义为"参考"而非"指令":这是一个可行的构图起点，模型可自由偏离,
    // 只要最终仍落在安全区内且元素互不重叠(由 judge 的建议性 issue 兜底)。
    rules: [
      'The title frame is a suggested placement for the page title, not a mandatory slot.',
      'Each slot is a feasible starting point for its content unit; diverge from it whenever a different composition better serves the content.',
      'A purposeful diagram or media element may realize multiple units inside the primary slot.',
      'Regardless of how far the composition departs from this plan, keep every element inside the safe area and free of overlap.',
    ],
  };
};
