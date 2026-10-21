import { applyPageInstructionalSpec } from '@reachany/reach-deck-dsl';
import {
  DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE,
  ENTRANCE_ANIMATION_PRESET_NAMES,
  isEntranceAnimationPresetName,
  parsePageOutlineValue,
  type EntranceAnimationPresetName,
  type PageOutline,
  type PreviousPageNarration,
  type ReachDeckDesignContext,
} from '@reachany/reach-deck-dsl';

import {
  normalizeFreshGeneratedMarkdown,
  stripGeneratedNarrationPunctuationEscapes,
} from './model-markdown.js';
import { extractNarrationFormulaSpans, findNarrationFormulaRanges } from './narration-formulas.js';
import {
  compileGeneratedNarrationStructure,
  type CompiledNarrationStructure,
  type NarrationRevealRange,
} from './narration-structure.js';
import {
  buildNarrationStylePromptFragment,
  deriveNarrationTeachingMoves,
  inferNarrationExampleDiscipline,
} from './narration-style-selector.js';
import {
  composeChineseNarrationSystemPrompt,
  NARRATION_SYSTEM_PROMPT,
  PROMPT_CORPUS_DIGEST,
  PROMPT_CORPUS_VERSION,
} from './prompts/index.js';
import { PAGE_RESPONSIBILITY_PRIORITY } from './prompts/corpus/page-responsibility.js';

export type NarrationDeliveryFunction =
  | 'course_opening'
  | 'course_orientation'
  | 'section_transition'
  | 'concept_explanation'
  | 'guided_activity'
  | 'synthesis_transfer'
  | 'course_closure';

export type NarrationDisclosureMode =
  | 'welcome_and_frame'
  | 'preview_without_reveal'
  | 'question_without_answer'
  | 'observe_before_explaining'
  | 'resolve_prior_question'
  | 'explain_current_idea'
  | 'demonstrate_reasoning'
  | 'clarify_misconception'
  | 'transition_without_reteaching'
  | 'consolidate_current_stage'
  | 'synthesize_course'
  | 'transfer_learning'
  | 'close_briefly';

/** One compact entry per course page, in delivery order; never a second teaching source. */
export interface NarrationCoursePageMapEntry {
  title: string;
  sceneType: PageOutline['sceneType'];
  pageRole?: string;
  pageJob?: string;
  current?: true;
}

export const NARRATION_COURSE_PAGE_MAP_LIMITS = {
  pages: 200,
  title: 120,
  pageJob: 160,
} as const;

/** Optional model context only; the existing durable job and TTS contracts are unchanged. */
export interface NarrationLessonContext {
  courseTitle: string;
  pageIndex: number;
  totalPages: number;
  currentPage?: PageOutline;
  precedingPages?: PageOutline[];
  nextPage?: PageOutline;
  coursePageMap?: NarrationCoursePageMapEntry[];
}

export function validateNarrationLessonContext(
  value: unknown,
  pageId?: string,
  designContext?: ReachDeckDesignContext,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Narration lesson context must be an object.');
  if (typeof value.courseTitle !== 'string' || value.courseTitle.length > 512) {
    throw new Error('Narration lesson context course title is invalid.');
  }
  if (
    !Number.isInteger(value.pageIndex) ||
    !Number.isInteger(value.totalPages) ||
    (value.pageIndex as number) < 0 ||
    (value.totalPages as number) <= (value.pageIndex as number)
  ) {
    throw new Error('Narration lesson context page position is invalid.');
  }
  for (const key of ['currentPage', 'nextPage'] as const) {
    if (value[key] !== undefined) parsePageOutlineValue(value[key], designContext);
  }
  if (pageId !== undefined && isRecord(value.currentPage) && value.currentPage.id !== pageId) {
    throw new Error('Narration lesson context must describe the requested page.');
  }
  if (value.precedingPages !== undefined) {
    if (!Array.isArray(value.precedingPages) || value.precedingPages.length > 2) {
      throw new Error('Narration lesson context preceding pages are invalid.');
    }
    value.precedingPages.forEach((page) => parsePageOutlineValue(page, designContext));
  }
  if (value.coursePageMap !== undefined) {
    validateNarrationCoursePageMap(value.coursePageMap, value.totalPages as number);
  }
}

function validateNarrationCoursePageMap(value: unknown, totalPages: number): void {
  const limits = NARRATION_COURSE_PAGE_MAP_LIMITS;
  if (
    !Array.isArray(value) ||
    value.length > Math.min(totalPages, limits.pages) ||
    value.filter((entry) => isRecord(entry) && entry.current === true).length > 1
  ) {
    throw new Error('Narration lesson context course page map is invalid.');
  }
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) => !['title', 'sceneType', 'pageRole', 'pageJob', 'current'].includes(key),
      ) ||
      typeof entry.title !== 'string' ||
      entry.title.length > limits.title ||
      !['slide', 'quiz', 'interactive'].includes(entry.sceneType as string) ||
      (entry.pageRole !== undefined &&
        (typeof entry.pageRole !== 'string' || entry.pageRole.length > 64)) ||
      (entry.pageJob !== undefined &&
        (typeof entry.pageJob !== 'string' || entry.pageJob.length > limits.pageJob)) ||
      (entry.current !== undefined && entry.current !== true)
    ) {
      throw new Error('Narration lesson context course page map entry is invalid.');
    }
  }
}

export interface NarrationVisualElement {
  id: string;
  type: string;
  text?: string;
  variant?: string;
  /** Explicit or containment-derived reveal unit; ungrouped visuals reveal on their own. */
  revealGroupId?: string;
  /**
   * A card surface (and its unlabelled contents) shared by explicit sub-groups inside it. It enters
   * with the earliest sub-group only when every listed group is revealed; otherwise it stays visible.
   */
  revealCompanionGroupIds?: readonly string[];
  /** Decorative or structural visuals stay visible unless they belong to a revealed group. */
  decorative?: boolean;
  scientificAnchors?: ReadonlyArray<{ id: string; description: string }>;
}

export interface NarrationRevealGroup {
  groupId: string;
  elementIds: string[];
  /**
   * Shared card elements (also listed in elementIds) that follow several groups. They may only
   * enter when every group they follow is revealed; otherwise they stay visible from the start.
   */
  followerElementIds?: string[];
  classification: 'required' | 'persistent';
  defaultEffect: EntranceAnimationPresetName;
  allowedEffects: readonly EntranceAnimationPresetName[];
  description: string;
}

export interface NarrationRevealManifest {
  schemaVersion: 'reach-deck-reveal-groups/v1';
  groups: NarrationRevealGroup[];
}

/**
 * Each ungrouped visual is its own reveal unit and grouped members reveal together. A group stays
 * persistent when it holds the title or a disallowed element, or when every member is decorative.
 */
export function buildNarrationRevealManifest(
  elements: readonly NarrationVisualElement[],
  allowedElementIds: ReadonlySet<string>,
): NarrationRevealManifest {
  const grouped = new Map<string, NarrationVisualElement[]>();
  const companions: NarrationVisualElement[] = [];
  const elementIds = new Set<string>();
  for (const element of elements) {
    if (elementIds.has(element.id)) throw new Error('Narration visual element IDs must be unique.');
    elementIds.add(element.id);
    if (element.revealGroupId !== undefined && !element.revealGroupId.trim()) {
      throw new Error('Narration reveal group ID must be nonempty.');
    }
    if (element.revealCompanionGroupIds !== undefined) {
      if (element.revealGroupId !== undefined || element.revealCompanionGroupIds.length === 0) {
        throw new Error('Narration reveal companions must follow at least one other group.');
      }
      companions.push(element);
      continue;
    }
    const groupId = element.revealGroupId ?? element.id;
    const members = grouped.get(groupId);
    if (members === undefined) grouped.set(groupId, [element]);
    else {
      if (element.revealGroupId === undefined || members[0]!.revealGroupId === undefined) {
        throw new Error('Narration reveal group IDs must not collide with ungrouped elements.');
      }
      members.push(element);
    }
  }
  return {
    schemaVersion: 'reach-deck-reveal-groups/v1',
    groups: [...grouped].map(([groupId, members]) => {
      const followers = companions.filter((companion) =>
        companion.revealCompanionGroupIds!.includes(groupId),
      );
      const persistent =
        [...members, ...followers].some(
          (element) => !allowedElementIds.has(element.id) || element.variant === 'title',
        ) || members.every((element) => element.decorative === true);
      const element =
        members.find((member) => member.type === 'text') ??
        members.find((member) => member.text !== undefined) ??
        members[0]!;
      const defaultEffect =
        DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE[
          element.type as keyof typeof DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE
        ] ?? DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE.textFrame;
      return {
        groupId,
        elementIds: [...members, ...followers].map((member) => member.id),
        ...(followers.length === 0
          ? {}
          : { followerElementIds: followers.map((follower) => follower.id) }),
        classification: persistent ? 'persistent' : 'required',
        defaultEffect,
        allowedEffects: persistent ? [] : ENTRANCE_ANIMATION_PRESET_NAMES,
        description: members.map((member) => member.text ?? member.type).join('\n'),
      };
    }),
  };
}

const ROLE_DISCLOSURE: Readonly<Record<string, NarrationDisclosureMode>> = {
  exploration: 'question_without_answer',
  attempt: 'question_without_answer',
  reveal: 'resolve_prior_question',
  develop: 'explain_current_idea',
  title: 'welcome_and_frame',
  roadmap: 'preview_without_reveal',
  advance_organizer: 'preview_without_reveal',
  hook: 'question_without_answer',
  learner_promise: 'question_without_answer',
  section_open: 'transition_without_reteaching',
  section_bridge: 'transition_without_reteaching',
  worked_example: 'demonstrate_reasoning',
  stage_summary: 'consolidate_current_stage',
  synthesis: 'synthesize_course',
  transfer: 'transfer_learning',
  close: 'close_briefly',
};

export function buildNarrationCapabilityContext(input: {
  page?: PageOutline;
  pageTitle: string;
  source?: string;
  lessonContext?: NarrationLessonContext;
  previousPageNarration?: PreviousPageNarration;
  elements: readonly NarrationVisualElement[];
  revealGroupManifest: NarrationRevealManifest;
}) {
  const originalPage = input.page ?? input.lessonContext?.currentPage;
  const page =
    originalPage?.instructionalSpec?.schemaVersion === 'reach-deck-instructional-spec/v3'
      ? applyPageInstructionalSpec(originalPage, originalPage.instructionalSpec)
      : originalPage;
  const pageIndex = input.lessonContext?.pageIndex ?? page?.order;
  const totalPages = input.lessonContext?.totalPages;
  const pagePosition =
    pageIndex === 0
      ? 'first'
      : totalPages !== undefined && pageIndex === totalPages - 1
        ? 'last'
        : 'middle';
  const mode =
    ROLE_DISCLOSURE[page?.pageRole ?? ''] ??
    (page?.microCycleStages?.includes('explain_reveal')
      ? 'resolve_prior_question'
      : page?.microCycleStages?.includes('attempt_predict') ||
          page?.microCycleStages?.includes('curiosity_explore')
        ? 'question_without_answer'
        : 'explain_current_idea');
  const evidence = [
    input.source ?? '',
    input.lessonContext?.courseTitle ?? '',
    input.pageTitle,
    ...input.elements.map((element) => element.text ?? ''),
  ];
  const previousPage = input.lessonContext?.precedingPages?.at(-1);
  const fragment = buildNarrationStylePromptFragment({
    language: /\p{Script=Han}/u.test(evidence.join('\n')) ? 'zh-CN' : 'en-US',
    pagePosition,
    precedingSceneType: previousPage?.sceneType ?? 'none',
    teachingMoves: deriveNarrationTeachingMoves({
      pagePosition,
      sceneType: page?.sceneType ?? 'slide',
      precedingSceneType: previousPage?.sceneType ?? 'none',
      title: input.pageTitle,
      pageRole: page?.pageRole,
      pageJob: page?.pageJob,
      keyPoints: page?.instructionalSpec?.keyPoints,
      pageFunctions: page?.pageFunctions,
      teachingMove: page?.instructionalSpec?.teachingMove,
    }),
    discipline: inferNarrationExampleDiscipline(evidence),
    keyConcepts: [input.pageTitle, ...(page?.instructionalSpec?.keyPoints ?? [])],
    disclosureMode: mode,
  });
  return {
    systemPrompt: [
      /\p{Script=Han}/u.test(evidence.join('\n'))
        ? composeChineseNarrationSystemPrompt(fragment?.promptText)
        : NARRATION_SYSTEM_PROMPT,
      PAGE_RESPONSIBILITY_PRIORITY,
      NATURAL_NARRATION_ADAPTER_INSTRUCTION,
    ].join('\n\n'),
    context: {
      ...input.lessonContext,
      promptCorpus: { version: PROMPT_CORPUS_VERSION, digest: PROMPT_CORPUS_DIGEST },
      pagePosition,
      currentPage: {
        ...page,
        title: input.pageTitle,
        deliveryPolicy: { mode },
      },
      ...(input.previousPageNarration === undefined
        ? {}
        : { previousPageNarration: input.previousPageNarration }),
      visibleElements: input.elements,
      requiredFormulaSpans: [
        ...new Set(
          input.elements.flatMap((element) => extractNarrationFormulaSpans(element.text ?? '')),
        ),
      ],
      revealGroupManifest: input.revealGroupManifest,
      referenceExampleId: fragment?.teacherExample?.id ?? fragment?.oneToOneExample?.id,
    },
  };
}

export const NATURAL_NARRATION_ADAPTER_INSTRUCTION = `The supplied pageRole, pageFunctions and pageJob remain authoritative over deliveryPolicy, which is only a compatibility projection. Write the complete natural narrationMarkdown before choosing bindings. Bind visual groups only where useful; an unbound visual remains visible and must never force extra narration. Decorative or persistent elements do not need bindings. Related groups may share a natural phrase. A phrase identifies an approximate teaching moment, not word-for-word coverage of the visual. Preserve every declared scientific anchor, using a natural phrase near its teaching moment; do not invent timestamps. Never change page responsibility, wording or explanation order for animation coverage.`;

/** Convert the new model envelope to the unchanged prepared narration/TTS shape. */
export function compileNaturalNarration(
  value: unknown,
  manifest: NarrationRevealManifest,
  scientificAnchors: ReadonlyMap<string, string> = new Map(),
  savedMarkdown?: string,
  onMarkdownNormalized?: Parameters<typeof compileGeneratedNarrationStructure>[3],
): CompiledNarrationStructure {
  if (!isRecord(value)) throw new Error('Natural narration output must be an object.');
  if (savedMarkdown !== undefined && 'narrationMarkdown' in value) {
    throw new Error('Saved narration binding output must not contain narrationMarkdown.');
  }
  if (savedMarkdown === undefined && typeof value.narrationMarkdown !== 'string') {
    throw new Error('Natural narration output must contain narrationMarkdown.');
  }
  const allowedKeys = new Set([
    'revealBindings',
    'scientificBindings',
    ...(savedMarkdown === undefined ? ['narrationMarkdown'] : []),
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('Natural narration output contains unsupported envelope fields.');
  }
  const markdown =
    savedMarkdown ??
    compileGeneratedNarrationStructure(
      {
        cues: [
          {
            segments: [
              {
                script: stripGeneratedNarrationPunctuationEscapes(
                  normalizeFreshGeneratedMarkdown(value.narrationMarkdown as string),
                ),
              },
            ],
          },
        ],
      },
      new Set(),
      new Map(),
      onMarkdownNormalized,
    ).markdown;
  const cues = splitNaturalNarrationCues(markdown);
  const groups = new Map(manifest.groups.map((group) => [group.groupId, group]));
  const used = new Set<string>();
  const groupRanges = array(value.revealBindings, 'revealBindings').flatMap(
    (binding): Array<{ groupId: string; range: NarrationRevealRange }> => {
      if (!isRecord(binding)) throw new Error('Narration reveal binding is invalid.');
      const group = groups.get(String(binding.revealGroupId));
      if (group === undefined || group.classification === 'persistent' || used.has(group.groupId)) {
        throw new Error('Narration reveal group is unknown, persistent or duplicated.');
      }
      used.add(group.groupId);
      if (
        binding.effect != null &&
        (!isEntranceAnimationPresetName(binding.effect) ||
          !group.allowedEffects.includes(binding.effect))
      ) {
        throw new Error('Narration reveal effect is invalid.');
      }
      const range = locateNaturalAnchor(markdown, binding.anchorText, cues);
      if (range === undefined) return [];
      return [
        {
          groupId: group.groupId,
          range: {
            ...range,
            revealElementIds: [...group.elementIds],
            revealEffect: binding.effect == null ? group.defaultEffect : binding.effect,
          },
        },
      ];
    },
  );
  // A shared card cannot enter late while text it carries is visible from the start: it animates
  // only when every group it follows actually produced a reveal range (unbound groups and bindings
  // whose anchor matched nothing both leave their text visible).
  const animatedGroupIds = new Set(groupRanges.map(({ groupId }) => groupId));
  const visibleFollowers = new Set(
    manifest.groups.flatMap((group) =>
      animatedGroupIds.has(group.groupId) ? [] : (group.followerElementIds ?? []),
    ),
  );
  const revealRanges: NarrationRevealRange[] = groupRanges
    .map(({ range }) => range)
    .sort((left, right) => left.start - right.start)
    .flatMap((range) => {
      const revealElementIds = range.revealElementIds.filter((id) => !visibleFollowers.has(id));
      return revealElementIds.length === 0 ? [] : [{ ...range, revealElementIds }];
    });
  const expectedScientific = [...scientificAnchors.keys()];
  const bindings = array(value.scientificBindings, 'scientificBindings');
  if (bindings.length !== expectedScientific.length) {
    throw new Error('Narration must bind every declared scientific anchor once.');
  }
  let previousScientificRange = { start: 0, end: markdown.length };
  const scientificAnchorRanges = bindings.map((binding, index) => {
    if (!isRecord(binding) || binding.scientificAnchorId !== expectedScientific[index]) {
      throw new Error('Narration scientific anchors must preserve their declared state order.');
    }
    const proposed = locateNaturalAnchor(markdown, binding.anchorText, cues);
    if (proposed === undefined)
      throw new Error('Narration scientific anchor has no matching spoken context.');
    const range =
      proposed.start < previousScientificRange.start ? previousScientificRange : proposed;
    previousScientificRange = range;
    return {
      elementId: scientificAnchors.get(expectedScientific[index]!)!,
      anchorId: expectedScientific[index]!,
      ...range,
    };
  });
  return {
    markdown,
    cues,
    revealRanges,
    ...(scientificAnchorRanges.length ? { scientificAnchorRanges } : {}),
  };
}

function locateNaturalAnchor(
  markdown: string,
  anchor: unknown,
  cues: readonly { text: string }[],
): { start: number; end: number } | undefined {
  if (typeof anchor !== 'string' || anchor.trim().length === 0)
    throw new Error('Narration anchor must be nonempty.');
  const words = new Set(Array.from(anchor).filter((character) => /[\p{L}\p{N}]/u.test(character)));
  if (words.size === 0) return undefined;
  const start = markdown.indexOf(anchor);
  if (
    start >= 0 &&
    legalBoundary(markdown, start) &&
    legalBoundary(markdown, start + anchor.length)
  ) {
    return { start, end: start + anchor.length };
  }
  let offset = 0;
  const candidates = cues
    .map((cue) => {
      const candidate = {
        start: offset,
        end: offset + cue.text.length,
        score: [...words].filter((word) => cue.text.includes(word)).length,
      };
      offset += cue.text.length;
      return candidate;
    })
    .sort((left, right) => right.score - left.score || left.start - right.start);
  const selected = candidates[0];
  if (selected === undefined || selected.score === 0) return undefined;
  return { start: selected.start, end: selected.end };
}

/** Server-side caption boundaries preserve text and never split a formula or surrogate pair. */
export function splitNaturalNarrationCues(markdown: string): Array<{ text: string }> {
  if (markdown.trim().length === 0) throw new Error('Narration Markdown must be nonempty.');
  const boundaries = [0];
  const formulaRanges = findNarrationFormulaRanges(markdown);
  const protectedRanges = [
    ...formulaRanges,
    ...Array.from(markdown.matchAll(/<break\b[^>]*\/>/giu), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  ];
  for (let index = 1; index < markdown.length; index += 1) {
    const previous = markdown[index - 1]!;
    if (
      /[。！？.!?\n]/u.test(previous) &&
      (previous !== '.' || isSentencePeriod(markdown, index - 1)) &&
      !protectedRanges.some((range) => index > range.start && index < range.end)
    ) {
      let next = index;
      // 句末标点后紧跟的叠用标点、后引号与后括号（？！、。”、。）、……）属于同一句，
      // 不能被切到下一条字幕句首；换行后的引号可能是下一句的前引号，不吞。
      if (previous !== '\n') {
        while (
          next < markdown.length &&
          /[。！？.!?…”’"'」』）)\]】》〉〕]/u.test(markdown[next]!) &&
          !protectedRanges.some((range) => next + 1 > range.start && next + 1 < range.end)
        )
          next += 1;
        // 引语内的句末标点后紧跟逗号/顿号等（“……？”，副标题……）说明整句还没说完，此处不切。
        if (/[，、；：,;:]/u.test(markdown[next] ?? '')) {
          index = next;
          continue;
        }
      }
      while (next < markdown.length && /\s/u.test(markdown[next]!)) next += 1;
      if (
        next < markdown.length &&
        next > boundaries.at(-1)! &&
        markdown.slice(boundaries.at(-1)!, next).trim()
      )
        boundaries.push(next);
      index = next;
    }
  }
  boundaries.push(markdown.length);
  while (boundaries.length > 9) {
    let smallest = 1;
    for (let index = 2; index < boundaries.length - 1; index += 1) {
      if (
        boundaries[index + 1]! - boundaries[index - 1]! <
        boundaries[smallest + 1]! - boundaries[smallest - 1]!
      )
        smallest = index;
    }
    boundaries.splice(smallest, 1);
  }
  return boundaries
    .slice(0, -1)
    .map((start, index) => ({ text: markdown.slice(start, boundaries[index + 1]) }));
}

function isSentencePeriod(markdown: string, index: number): boolean {
  // Decimal points, version components, domain names and the inner dots of abbreviations.
  if (/[\p{L}\p{N}]/u.test(markdown[index + 1] ?? '')) return false;
  const prefix = markdown.slice(0, index + 1);
  if (/(?:\b[a-z]\.){2,}$/iu.test(prefix)) return false;
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Fig|No)\.$/iu.test(prefix)) return false;
  return true;
}

function legalBoundary(markdown: string, index: number): boolean {
  if (
    index > 0 &&
    index < markdown.length &&
    /[\uD800-\uDBFF]/u.test(markdown[index - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(markdown[index]!)
  )
    return false;
  return !findNarrationFormulaRanges(markdown).some(
    (range) => index > range.start && index < range.end,
  );
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Narration output must contain ${field}.`);
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
