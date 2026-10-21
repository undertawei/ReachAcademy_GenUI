/**
 * Native slide 讲稿入场动画的分组推导（#705）。
 *
 * HTML 版式编译出来的 native 页是扁平的绝对定位元素：卡片底图/底色与卡片上的文字是兄弟元素，
 * DOM 结构不携带分组。逐元素做入场会把底卡和文字拆开，页面元素多时还会显得很碎；反过来把
 * 所有未分组元素都当常驻，又会一个动画都没有。这里按确定性规则推导可入场单元：
 *
 * 1. 显式分组：元素名 `reveal-group:<id>`（HTML 的 `data-reach-reveal-group`），始终优先；
 * 2. 容器分组：一个无文字的底卡（图片或无字形状）完整包住绘制在它之上的元素时，底卡与这些
 *    元素合成一个单元；嵌套时取最外层。底卡内部若有显式子组，底卡与未标记的成员作为这些
 *    子组的共享成员：子组全部入场时随最早的子组出现，否则（有子组不入场）常驻，避免文字悬空；
 *    未标记成员包含调用方指定的常驻标题时，底卡与这些成员另组常驻单元，显式子组仍可独立入场；
 * 3. 结构元素常驻：线条、无字形状、覆盖半张画布以上的背景不单独入场；
 * 4. 其余元素各自是一个单元。
 *
 * 纯函数，无 I/O；只看几何与元素类型，不看文字内容。
 */
import type { ReachDeckNativeSlideV2 } from '@reachany/reach-deck-dsl';

type NativeElement = ReachDeckNativeSlideV2['elements'][number];

const STAGE_AREA = 1600 * 900;
/** 覆盖画布一半以上的元素是背景，不做容器也不入场。 */
const BACKDROP_AREA_RATIO = 0.5;
/** 包含判定的像素容差，吸收 HTML 布局取整与描边外扩。 */
const CONTAINMENT_TOLERANCE = 4;

export interface NativeSlideRevealGrouping {
  /** 元素 → 所属入场单元（显式或容器推导）；未出现的元素是单独单元或结构元素。 */
  groupIdByElementId: Map<string, string>;
  /** 底卡及其未标记成员 → 跟随的显式子组；子组全部入场时由最早的子组带出，否则常驻。 */
  companionGroupIdsByElementId: Map<string, string[]>;
  /** 常驻的结构元素：线条、无字形状、背景。 */
  structuralElementIds: Set<string>;
}

export function deriveNativeSlideRevealGrouping(
  slide: ReachDeckNativeSlideV2,
  persistentElementIds: ReadonlySet<string> = new Set(),
): NativeSlideRevealGrouping {
  const visible = slide.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.hidden !== true)
    .sort((left, right) => left.element.zIndex - right.element.zIndex || left.index - right.index);
  const paintOrder = new Map(visible.map(({ element }, order) => [element.id, order] as const));
  const elements = visible.map(({ element }) => element);
  const elementIds = new Set(slide.elements.map((element) => element.id));

  const explicit = new Map<string, string>();
  for (const element of elements) {
    const groupId = element.name?.match(/^reveal-group:(.+)$/u)?.[1]?.trim();
    if (groupId) explicit.set(element.id, groupId);
  }
  // 显式组名与非成员元素 id 撞名时改名，保证组名与单独单元（组名即元素 id）互不冲突。
  const renamed = new Map<string, string>();
  const usedGroupIds = new Set<string>();
  for (const groupId of new Set(explicit.values())) {
    const collides = (candidate: string) =>
      usedGroupIds.has(candidate) ||
      (elementIds.has(candidate) && explicit.get(candidate) !== groupId);
    let unique = groupId;
    for (let suffix = 2; collides(unique); suffix += 1) unique = `${groupId}~${suffix}`;
    renamed.set(groupId, unique);
    usedGroupIds.add(unique);
  }
  const explicitGroupOf = (element: NativeElement): string | undefined => {
    const groupId = explicit.get(element.id);
    return groupId === undefined ? undefined : renamed.get(groupId);
  };

  const backdrop = new Set(
    elements
      .filter((element) => area(element) >= BACKDROP_AREA_RATIO * STAGE_AREA)
      .map((element) => element.id),
  );
  const groupIdByElementId = new Map<string, string>();
  const companionGroupIdsByElementId = new Map<string, string[]>();
  const owned = new Set<string>();

  const containers = elements
    .filter((element) => isContainerCandidate(element) && !backdrop.has(element.id))
    .sort((left, right) => area(right) - area(left));
  for (const container of containers) {
    if (owned.has(container.id)) continue;
    const members = elements.filter(
      (element) =>
        element.id !== container.id &&
        !owned.has(element.id) &&
        !backdrop.has(element.id) &&
        paintOrder.get(element.id)! > paintOrder.get(container.id)! &&
        contains(container, element),
    );
    if (members.length === 0) continue;
    owned.add(container.id);
    members.forEach((member) => owned.add(member.id));

    const containerGroup = explicitGroupOf(container);
    const unlabelled = [container, ...members].filter(
      (element) => explicitGroupOf(element) === undefined,
    );
    for (const element of [container, ...members]) {
      const groupId = explicitGroupOf(element);
      if (groupId !== undefined) groupIdByElementId.set(element.id, groupId);
    }
    if (containerGroup !== undefined) {
      unlabelled.forEach((element) => groupIdByElementId.set(element.id, containerGroup));
      continue;
    }
    const subGroups = [...new Set(members.flatMap((member) => explicitGroupOf(member) ?? []))];
    // 常驻标题与底卡、未标记成员独立成组，不能通过共享成员关系把显式步骤一起冻结。
    if (
      subGroups.length > 0 &&
      !unlabelled.some((element) => persistentElementIds.has(element.id))
    ) {
      unlabelled.forEach((element) => companionGroupIdsByElementId.set(element.id, subGroups));
      continue;
    }
    const groupId = uniqueGroupId(container.id, usedGroupIds, elementIds, container.id);
    usedGroupIds.add(groupId);
    unlabelled.forEach((element) => groupIdByElementId.set(element.id, groupId));
  }

  const structuralElementIds = new Set<string>();
  for (const element of elements) {
    if (owned.has(element.id)) continue;
    const groupId = explicitGroupOf(element);
    if (groupId !== undefined) {
      groupIdByElementId.set(element.id, groupId);
      continue;
    }
    if (backdrop.has(element.id) || element.type === 'line' || isTextlessShape(element)) {
      structuralElementIds.add(element.id);
    }
  }
  return { groupIdByElementId, companionGroupIdsByElementId, structuralElementIds };
}

/** 图片与无字形状（含图片填充的无字形状）可以作为底卡。 */
function isContainerCandidate(element: NativeElement): boolean {
  return element.type === 'image' || isTextlessShape(element);
}

function isTextlessShape(element: NativeElement): boolean {
  return element.type === 'shape' && element.text === undefined;
}

function area(element: NativeElement): number {
  return Math.max(0, element.transform.width) * Math.max(0, element.transform.height);
}

function contains(outer: NativeElement, inner: NativeElement): boolean {
  const a = outer.transform;
  const b = inner.transform;
  return (
    b.x >= a.x - CONTAINMENT_TOLERANCE &&
    b.y >= a.y - CONTAINMENT_TOLERANCE &&
    b.x + b.width <= a.x + a.width + CONTAINMENT_TOLERANCE &&
    b.y + b.height <= a.y + a.height + CONTAINMENT_TOLERANCE
  );
}

/** 推导组名取底卡 id；它只会与底卡自身同名，而底卡正是该组成员。 */
function uniqueGroupId(
  base: string,
  used: ReadonlySet<string>,
  elementIds: ReadonlySet<string>,
  ownerId: string,
): string {
  let candidate = base;
  for (
    let suffix = 2;
    used.has(candidate) || (elementIds.has(candidate) && candidate !== ownerId);
    suffix += 1
  ) {
    candidate = `${base}~${suffix}`;
  }
  return candidate;
}
