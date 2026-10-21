import {
  isEntranceAnimationPresetName,
  buildReachDeckMediaResourceForObjectKey,
  parseDeckSlideValue,
  parseArtifactValue,
  isNativeSlideArtifact,
  parseInteractiveSceneValue,
  parseLayoutJudgeResultValue,
  parseLessonPlanValue,
  parsePagedDeckOutlineValue,
  parseQuizSceneValue,
  parseSlideGenerationMetadataValue,
  normalizeReachDeckNarrationMarkdown,
  parseReachDeckSpeechMarkupV1,
  type GeneratedSceneArtifact,
  type GenerationSceneType,
} from '@reachany/reach-deck-dsl';

import {
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
} from './job-identity.js';

import type {
  ReachDeckCapturedModelPrompt,
  ReachDeckStagedGenerationJobKind,
  ReachDeckStagedGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from './contracts.js';

export interface ReachDeckStagedResultProvenance {
  kind: ReachDeckStagedGenerationJobKind;
  runId: string;
  createdFromDraftRevision: number;
  pageId?: string;
  requestedRevision?: number;
  attempt?: number;
  sceneType?: GenerationSceneType;
}

export function stagedResultProvenanceFromPayload(
  payload: ReachDeckStagedGenerationJobPayload,
): ReachDeckStagedResultProvenance {
  if (payload.kind === 'lesson-plan' || payload.kind === 'page-outline') {
    return {
      kind: payload.kind,
      runId: payload.runId,
      createdFromDraftRevision: payload.createdFromDraftRevision,
    };
  }
  // page-generation 与 narration-generation 共用页级身份分量；
  // 讲稿 job（两条通道）只对 slide 页运行：工作区通道由 page 契约保证，
  // native 通道（materialized-native，无 page 字段）按定义恒为 slide。
  const request = payload.request;
  return {
    kind: payload.kind,
    runId: payload.runId,
    createdFromDraftRevision: payload.createdFromDraftRevision,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType:
      'page' in request
        ? request.page.sceneType
        : request.sourceKind === 'materialized-interactive'
          ? 'interactive'
          : 'slide',
  };
}

export function parseCompletedStagedResult(
  value: unknown,
  provenance: ReachDeckStagedResultProvenance,
): ReachDeckStagedGenerationResult {
  // 讲稿 job 的两条通道结果值互斥：工作区通道是完整 slide 工件（artifact），
  // native 通道是中立讲稿产物（nativeNarration）。按实际携带的键分流解析。
  const narrationValueKey =
    provenance.kind === 'narration-generation' &&
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'interactiveNarration')
      ? 'interactiveNarration'
      : provenance.kind === 'narration-generation' &&
          Object.prototype.hasOwnProperty.call(value, 'nativeNarration')
        ? 'nativeNarration'
        : resultValueKey(provenance.kind);
  const result = exactRecord(
    value,
    [
      'kind',
      'runId',
      'generatedFromDraftRevision',
      narrationValueKey,
      ...(provenance.kind === 'narration-generation' && narrationValueKey === 'artifact'
        ? (['narrationContentDigest'] as const)
        : []),
    ],
    `completed ${provenance.kind} result`,
    provenance.kind === 'narration-generation' && narrationValueKey === 'artifact'
      ? ['capturedModelPrompts', 'audioFailureCode']
      : ['capturedModelPrompts'],
  );
  // 调试工作台捕获的完整提示词随结果一起存下来，供页面只读回显。
  const capturedModelPrompts = parseCapturedModelPrompts(result.capturedModelPrompts);
  const captured = capturedModelPrompts === undefined ? {} : { capturedModelPrompts };
  if (
    result.kind !== provenance.kind ||
    result.runId !== provenance.runId ||
    result.generatedFromDraftRevision !== provenance.createdFromDraftRevision
  ) {
    throw new Error('completed result provenance does not match its staged job');
  }
  switch (provenance.kind) {
    case 'lesson-plan':
      return {
        kind: 'lesson-plan',
        runId: provenance.runId,
        generatedFromDraftRevision: provenance.createdFromDraftRevision,
        ...captured,
        candidate: parseLessonPlanValue(result.candidate),
      };
    case 'page-outline':
      return {
        kind: 'page-outline',
        runId: provenance.runId,
        generatedFromDraftRevision: provenance.createdFromDraftRevision,
        ...captured,
        candidate: parsePagedDeckOutlineValue(result.candidate),
      };
    case 'page-generation':
      return {
        kind: 'page-generation',
        runId: provenance.runId,
        generatedFromDraftRevision: provenance.createdFromDraftRevision,
        ...captured,
        artifact: parseCompletedArtifact(result.artifact, provenance),
      };
    case 'narration-generation': {
      if (narrationValueKey === 'interactiveNarration') {
        if (provenance.sceneType !== 'interactive') {
          throw new Error('completed Interactive narration requires an interactive scene type');
        }
        // 仅重写文字的变体用 textOnly 取代 audioObjectKey：新正文不带音频引用。
        const textOnly = hasKey(result.interactiveNarration, 'textOnly');
        const interactive = exactRecord(
          result.interactiveNarration,
          [
            'interactiveContentDigest',
            'narrationTextDigest',
            textOnly ? 'textOnly' : 'audioObjectKey',
            'artifact',
            ...(hasKey(result.interactiveNarration, 'sourceNarrationTextDigest')
              ? ['sourceNarrationTextDigest', 'sourceInteractiveContentDigest']
              : []),
          ],
          'completed Interactive narration product',
        );
        if (
          typeof interactive.interactiveContentDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(interactive.interactiveContentDigest) ||
          typeof interactive.narrationTextDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(interactive.narrationTextDigest) ||
          (interactive.sourceNarrationTextDigest !== undefined &&
            (typeof interactive.sourceNarrationTextDigest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(interactive.sourceNarrationTextDigest) ||
              typeof interactive.sourceInteractiveContentDigest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(interactive.sourceInteractiveContentDigest))) ||
          (textOnly
            ? interactive.textOnly !== true || interactive.sourceNarrationTextDigest === undefined
            : typeof interactive.audioObjectKey !== 'string' ||
              interactive.audioObjectKey.trim().length === 0)
        ) {
          throw new Error('completed Interactive narration identity is invalid');
        }
        const artifact = parseCompletedArtifact(interactive.artifact, provenance);
        if (artifact.sceneType !== 'interactive' || artifact.scene.narration === undefined) {
          throw new Error('completed Interactive narration artifact is missing narration');
        }
        const audioObjectKey = textOnly ? undefined : (interactive.audioObjectKey as string);
        const expectedAudioResourceId =
          audioObjectKey === undefined
            ? undefined
            : buildReachDeckMediaResourceForObjectKey(audioObjectKey).id;
        if (
          buildReachDeckInteractiveContentDigest(artifact.scene) !==
            interactive.interactiveContentDigest ||
          buildReachDeckInteractiveNarrationTextDigest(
            artifact.scene.narration.text,
            artifact.scene.narration.speechMarkup,
          ) !== interactive.narrationTextDigest ||
          artifact.scene.narration.audioResourceId !== expectedAudioResourceId
        ) {
          throw new Error('completed Interactive narration provenance does not match its artifact');
        }
        return {
          kind: 'narration-generation',
          runId: provenance.runId,
          generatedFromDraftRevision: provenance.createdFromDraftRevision,
          ...captured,
          interactiveNarration: {
            interactiveContentDigest: interactive.interactiveContentDigest,
            narrationTextDigest: interactive.narrationTextDigest,
            ...(interactive.sourceNarrationTextDigest === undefined
              ? {}
              : {
                  sourceNarrationTextDigest: interactive.sourceNarrationTextDigest as string,
                  sourceInteractiveContentDigest:
                    interactive.sourceInteractiveContentDigest as string,
                }),
            ...(audioObjectKey === undefined ? { textOnly: true as const } : { audioObjectKey }),
            artifact,
          },
        };
      }
      if (provenance.sceneType !== 'slide') {
        throw new Error('completed narration result requires a slide scene type');
      }
      if (narrationValueKey === 'nativeNarration') {
        return {
          kind: 'narration-generation',
          runId: provenance.runId,
          generatedFromDraftRevision: provenance.createdFromDraftRevision,
          ...captured,
          nativeNarration: parseCompletedNativeNarration(result.nativeNarration, provenance),
        };
      }
      if (
        typeof result.narrationContentDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.narrationContentDigest)
      ) {
        throw new Error('completed narration source digest is invalid');
      }
      const artifact = parseCompletedArtifact(result.artifact, provenance);
      const audioFailureCode =
        result.audioFailureCode === undefined
          ? undefined
          : boundedString(result.audioFailureCode, 'audioFailureCode', 128);
      if (audioFailureCode !== undefined) {
        // 音频失败的工件只保留讲稿：必须是原生 slide，带讲稿正文，不带音频与段落时间轴。
        const narration = isNativeSlideArtifact(artifact)
          ? artifact.nativeSlide.narration
          : undefined;
        if (
          narration?.markdown === undefined ||
          narration.markdown.trim().length === 0 ||
          narration.audioResourceId !== undefined ||
          (narration.segments ?? []).length > 0
        ) {
          throw new Error('completed narration audio failure must keep only the script');
        }
      }
      return {
        kind: 'narration-generation',
        runId: provenance.runId,
        generatedFromDraftRevision: provenance.createdFromDraftRevision,
        ...captured,
        narrationContentDigest: result.narrationContentDigest,
        artifact,
        ...(audioFailureCode === undefined ? {} : { audioFailureCode }),
      };
    }
  }
}

/**
 * native 通道讲稿产物的权威解析（耐久结果防损坏 + 身份比对）。
 *
 * 段落时间轴要求与 v2 校验同构：start/end 同在、非负、start<=end、跨段 start
 * 单调非降——落地写回后要过 parseReachDeckNativeSlideV2，坏时间轴在这里先拦下。
 */
function parseCompletedNativeNarration(
  value: unknown,
  provenance: ReachDeckStagedResultProvenance,
): Extract<
  ReachDeckStagedGenerationResult,
  { kind: 'narration-generation'; nativeNarration: unknown }
>['nativeNarration'] {
  if (
    provenance.pageId === undefined ||
    provenance.requestedRevision === undefined ||
    provenance.attempt === undefined
  ) {
    throw new Error('completed native narration job provenance is incomplete');
  }
  const narration = exactRecord(
    value,
    [
      'pageId',
      'requestedRevision',
      'attempt',
      'generatedAt',
      'nativeSlideContentDigest',
      ...(hasKey(value, 'animationMode') ? (['animationMode'] as const) : []),
      ...(hasKey(value, 'preservedNarrationDigest') ? (['preservedNarrationDigest'] as const) : []),
      'narrationContentDigest',
      'markdown',
      ...(hasKey(value, 'speechMarkup') ? (['speechMarkup'] as const) : []),
      'segments',
      ...(hasKey(value, 'audioFailureCode') ? (['audioFailureCode'] as const) : []),
      ...(hasKey(value, 'textOnly') ? (['textOnly'] as const) : []),
      ...(hasKey(value, 'reveals') ? (['reveals'] as const) : []),
      ...(hasKey(value, 'persistentElementIds') ? (['persistentElementIds'] as const) : []),
      ...(hasKey(value, 'scientificAnchorBindings') ? (['scientificAnchorBindings'] as const) : []),
      ...(hasKey(value, 'audioObjectKey') ? (['audioObjectKey'] as const) : []),
      'duration',
    ],
    'completed native narration product',
  );
  if (
    narration.animationMode !== undefined &&
    narration.animationMode !== 'preserve' &&
    narration.animationMode !== 'regenerate' &&
    narration.animationMode !== 'animations' &&
    narration.animationMode !== 'skip'
  ) {
    throw new Error('completed native narration animationMode is invalid');
  }
  if (
    narration.animationMode === 'animations' &&
    (typeof narration.preservedNarrationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(narration.preservedNarrationDigest))
  ) {
    throw new Error('completed native animation-only narration timing identity is invalid');
  }
  if (
    narration.pageId !== provenance.pageId ||
    narration.requestedRevision !== provenance.requestedRevision ||
    narration.attempt !== provenance.attempt ||
    typeof narration.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(narration.generatedAt))
  ) {
    throw new Error('completed native narration identity does not match its staged job');
  }
  if (
    typeof narration.nativeSlideContentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(narration.nativeSlideContentDigest)
  ) {
    throw new Error('completed native narration content digest is invalid');
  }
  if (
    typeof narration.narrationContentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(narration.narrationContentDigest)
  ) {
    throw new Error('completed native narration source digest is invalid');
  }
  if (
    typeof narration.markdown !== 'string' ||
    normalizeReachDeckNarrationMarkdown(narration.markdown) !== narration.markdown
  ) {
    throw new Error('completed native narration markdown must be canonical');
  }
  const speechMarkup =
    narration.speechMarkup === undefined
      ? undefined
      : parseReachDeckSpeechMarkupV1(narration.speechMarkup, narration.markdown);
  const audioFailureCode =
    narration.audioFailureCode === undefined
      ? undefined
      : boundedString(narration.audioFailureCode, 'audioFailureCode', 128);
  const audioObjectKey =
    narration.audioObjectKey === undefined
      ? undefined
      : boundedString(narration.audioObjectKey, 'audioObjectKey', 2048);
  const audioFailed = audioFailureCode !== undefined;
  // 仅重写文字是与音频失败并列的"无音频"成功形态：两者互斥，且不带动画模式、
  // 科学锚点绑定或保留可见性决定。
  const textOnly = narration.textOnly !== undefined;
  if (
    textOnly &&
    (narration.textOnly !== true ||
      audioFailed ||
      narration.animationMode !== undefined ||
      narration.preservedNarrationDigest !== undefined ||
      narration.persistentElementIds !== undefined ||
      narration.scientificAnchorBindings !== undefined)
  ) {
    throw new Error('completed native text-only narration is invalid');
  }
  const withoutAudio = audioFailed || textOnly;
  if (
    typeof narration.duration !== 'number' ||
    !Number.isFinite(narration.duration) ||
    (withoutAudio ? narration.duration !== 0 : !(narration.duration > 0))
  ) {
    throw new Error('completed native narration duration does not match its audio status');
  }
  if (withoutAudio === (audioObjectKey !== undefined)) {
    throw new Error('completed native narration audio status is inconsistent');
  }
  if (
    !Array.isArray(narration.segments) ||
    (withoutAudio ? narration.segments.length !== 0 : narration.segments.length === 0) ||
    narration.segments.length > 8
  ) {
    throw new Error('completed native narration segments do not match its audio status');
  }
  let previousStart = 0;
  const segments = narration.segments.map((segmentValue, index) => {
    const segment = exactRecord(
      segmentValue,
      ['text', 'start', 'end', ...(hasKey(segmentValue, 'words') ? (['words'] as const) : [])],
      `completed native narration segment ${index}`,
    );
    if (typeof segment.text !== 'string' || segment.text.trim().length === 0) {
      throw new Error(`completed native narration segment ${index} text must be nonblank`);
    }
    if (
      typeof segment.start !== 'number' ||
      typeof segment.end !== 'number' ||
      !(segment.start >= 0) ||
      segment.start > segment.end ||
      segment.start < previousStart
    ) {
      throw new Error(`completed native narration segment ${index} timing is invalid`);
    }
    previousStart = segment.start;
    // 词级时间戳（TTS 真实对齐产出）：逐词校验成对秒偏移与单调非降。
    const words =
      segment.words === undefined ? undefined : parseNarrationWords(segment.words, index);
    return {
      text: segment.text,
      start: segment.start,
      end: segment.end,
      ...(words === undefined ? {} : { words }),
    };
  });
  if (!withoutAudio && segments.map((segment) => segment.text).join('') !== narration.markdown) {
    throw new Error('completed native narration segments must exactly cover markdown');
  }
  if (withoutAudio && Array.isArray(narration.reveals) && narration.reveals.length > 0) {
    throw new Error('audio-free native narration cannot contain timed reveals');
  }
  if (narration.reveals !== undefined && !Array.isArray(narration.reveals)) {
    throw new Error('completed native narration reveals must be an array');
  }
  if (Array.isArray(narration.reveals) && narration.reveals.length > 64) {
    throw new Error('completed native narration reveals exceed the page limit');
  }
  const revealed = new Set<string>();
  let previousRevealStart = 0;
  const reveals = (narration.reveals ?? []).map((revealValue, index) => {
    const reveal = exactRecord(
      revealValue,
      [
        'start',
        'revealElementIds',
        ...(hasKey(revealValue, 'revealEffect') ? (['revealEffect'] as const) : []),
      ],
      `completed native narration reveal ${index}`,
    );
    if (
      typeof reveal.start !== 'number' ||
      !Number.isFinite(reveal.start) ||
      reveal.start < previousRevealStart ||
      reveal.start > (narration.duration as number) ||
      !Array.isArray(reveal.revealElementIds) ||
      reveal.revealElementIds.length === 0
    ) {
      throw new Error(`completed native narration reveal ${index} is invalid`);
    }
    previousRevealStart = reveal.start;
    const ids = reveal.revealElementIds.map((id) => {
      if (typeof id !== 'string' || id.trim().length === 0 || revealed.has(id)) {
        throw new Error(`completed native narration reveal ${index} target is invalid`);
      }
      revealed.add(id);
      return id;
    });
    if (reveal.revealEffect !== undefined && !isEntranceAnimationPresetName(reveal.revealEffect)) {
      throw new Error(`completed native narration reveal ${index} effect is invalid`);
    }
    return {
      start: reveal.start,
      revealElementIds: ids,
      ...(reveal.revealEffect === undefined ? {} : { revealEffect: reveal.revealEffect }),
    };
  });
  const persistentElementIds =
    narration.persistentElementIds === undefined
      ? undefined
      : (() => {
          if (
            narration.animationMode !== 'preserve' ||
            !Array.isArray(narration.persistentElementIds) ||
            narration.persistentElementIds.length > 256
          ) {
            throw new Error('completed native narration persistentElementIds are invalid');
          }
          const ids = narration.persistentElementIds.map((id) => {
            if (
              typeof id !== 'string' ||
              id.trim().length === 0 ||
              id.length > 256 ||
              revealed.has(id)
            ) {
              throw new Error('completed native narration persistentElementId is invalid');
            }
            return id;
          });
          if (new Set(ids).size !== ids.length)
            throw new Error('completed native narration persistentElementIds are duplicated');
          return ids;
        })();
  if (
    narration.scientificAnchorBindings !== undefined &&
    !Array.isArray(narration.scientificAnchorBindings)
  ) {
    throw new Error('completed native narration scientificAnchorBindings must be an array');
  }
  const bindingIds = new Set<string>();
  const bindingPairs = new Set<string>();
  let previousBindingStart = 0;
  const scientificAnchorBindings = (narration.scientificAnchorBindings ?? []).map(
    (bindingValue, index) => {
      const binding = exactRecord(
        bindingValue,
        ['id', 'elementId', 'anchorId', 'start', 'end'],
        `completed native narration scientific anchor binding ${index}`,
      );
      if (
        typeof binding.elementId !== 'string' ||
        binding.elementId.trim().length === 0 ||
        typeof binding.anchorId !== 'string' ||
        binding.anchorId.trim().length === 0 ||
        binding.id !== `narration-anchor:${binding.elementId}:${binding.anchorId}` ||
        typeof binding.start !== 'number' ||
        typeof binding.end !== 'number' ||
        !Number.isFinite(binding.start) ||
        !Number.isFinite(binding.end) ||
        binding.start < previousBindingStart ||
        binding.start < 0 ||
        binding.start > binding.end ||
        binding.end > (narration.duration as number)
      ) {
        throw new Error(`completed native narration scientific anchor binding ${index} is invalid`);
      }
      const id = binding.id as string;
      const pair = `${binding.elementId}\u0000${binding.anchorId}`;
      if (bindingIds.has(id) || bindingPairs.has(pair)) {
        throw new Error(
          `completed native narration scientific anchor binding ${index} is duplicated`,
        );
      }
      bindingIds.add(id);
      bindingPairs.add(pair);
      previousBindingStart = binding.start;
      return {
        id,
        elementId: binding.elementId,
        anchorId: binding.anchorId,
        start: binding.start,
        end: binding.end,
      };
    },
  );
  if (scientificAnchorBindings.length > 16) {
    throw new Error('completed native narration scientificAnchorBindings exceed the page limit');
  }
  return {
    pageId: provenance.pageId,
    requestedRevision: provenance.requestedRevision,
    attempt: provenance.attempt,
    generatedAt: narration.generatedAt,
    ...(narration.animationMode === undefined ? {} : { animationMode: narration.animationMode }),
    ...(narration.preservedNarrationDigest === undefined
      ? {}
      : { preservedNarrationDigest: narration.preservedNarrationDigest as string }),
    nativeSlideContentDigest: narration.nativeSlideContentDigest,
    narrationContentDigest: narration.narrationContentDigest,
    markdown: narration.markdown,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    segments,
    ...(audioFailureCode === undefined ? {} : { audioFailureCode }),
    ...(textOnly ? { textOnly: true as const } : {}),
    ...(reveals.length === 0 ? {} : { reveals }),
    ...(persistentElementIds === undefined ? {} : { persistentElementIds }),
    ...(scientificAnchorBindings.length === 0 ? {} : { scientificAnchorBindings }),
    ...(audioObjectKey === undefined ? {} : { audioObjectKey }),
    duration: narration.duration,
  } as Extract<
    ReachDeckStagedGenerationResult,
    { kind: 'narration-generation'; nativeNarration: unknown }
  >['nativeNarration'];
}

function hasKey(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key)
  );
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`completed native narration ${label} must be a bounded nonblank string`);
  }
  return value;
}

function parseCompletedArtifact(
  value: unknown,
  provenance: ReachDeckStagedResultProvenance,
): GeneratedSceneArtifact {
  if (
    provenance.pageId === undefined ||
    provenance.requestedRevision === undefined ||
    provenance.attempt === undefined ||
    provenance.sceneType === undefined
  ) {
    throw new Error('completed artifact job provenance is incomplete');
  }
  const commonKeys = [
    'runId',
    'pageId',
    'requestedRevision',
    'attempt',
    'sceneType',
    'scene',
    'status',
    'generatedAt',
  ];
  if (
    provenance.sceneType === 'slide' &&
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 'reach-deck-slide-artifact/v2'
  ) {
    const parsed = parseArtifactValue(value, provenance.runId, provenance.pageId);
    if (
      !isNativeSlideArtifact(parsed) ||
      parsed.status !== 'ready' ||
      parsed.requestedRevision !== provenance.requestedRevision ||
      parsed.attempt !== provenance.attempt ||
      Number.isNaN(Date.parse(parsed.generatedAt))
    ) {
      throw new Error('completed native artifact identity does not match its staged job');
    }
    return { ...parsed, status: 'ready' };
  }
  const legacySlideKeys =
    provenance.sceneType === 'slide' && typeof value === 'object' && value !== null
      ? (['judgeResult', 'acceptedWarningIds'] as const).filter((key) =>
          Object.prototype.hasOwnProperty.call(value, key),
        )
      : [];
  const artifact = exactRecord(
    value,
    provenance.sceneType === 'slide'
      ? [...commonKeys, 'generationMetadata', ...legacySlideKeys]
      : commonKeys,
    `completed ${provenance.kind} artifact`,
  );
  if (
    artifact.runId !== provenance.runId ||
    artifact.pageId !== provenance.pageId ||
    artifact.requestedRevision !== provenance.requestedRevision ||
    artifact.attempt !== provenance.attempt ||
    artifact.sceneType !== provenance.sceneType ||
    typeof artifact.generatedAt !== 'string' ||
    artifact.generatedAt.trim().length === 0 ||
    Number.isNaN(Date.parse(artifact.generatedAt))
  ) {
    throw new Error('completed artifact identity does not match its staged job');
  }
  if (artifact.sceneType === 'slide') {
    if (!['ready', 'warning', 'accepted'].includes(String(artifact.status))) {
      throw new Error('completed slide artifact status is invalid');
    }
    const scene = parseDeckSlideValue(artifact.scene);
    const generationMetadata = parseSlideGenerationMetadataValue(artifact.generationMetadata);
    if (artifact.judgeResult !== undefined) parseLayoutJudgeResultValue(artifact.judgeResult);
    if (
      generationMetadata.blueprint.pageId !== provenance.pageId ||
      (artifact.acceptedWarningIds !== undefined &&
        (!Array.isArray(artifact.acceptedWarningIds) ||
          artifact.acceptedWarningIds.some((entry) => typeof entry !== 'string')))
    ) {
      throw new Error('completed slide artifact structure is invalid');
    }
    return {
      runId: provenance.runId,
      pageId: provenance.pageId,
      requestedRevision: provenance.requestedRevision,
      attempt: provenance.attempt,
      sceneType: 'slide',
      scene,
      status: 'ready',
      generatedAt: artifact.generatedAt,
      generationMetadata,
    };
  }
  if (artifact.status !== 'ready') {
    throw new Error('completed non-slide artifact status must be ready');
  }
  const identity = {
    runId: provenance.runId,
    pageId: provenance.pageId,
    requestedRevision: provenance.requestedRevision,
    attempt: provenance.attempt,
    status: 'ready' as const,
    generatedAt: artifact.generatedAt,
  };
  switch (artifact.sceneType) {
    case 'quiz':
      return {
        ...identity,
        sceneType: 'quiz',
        scene: parseQuizSceneValue(artifact.scene, provenance.pageId),
      };
    case 'interactive':
      return {
        ...identity,
        sceneType: 'interactive',
        scene: parseInteractiveSceneValue(artifact.scene, provenance.pageId),
      };
    default:
      throw new Error('completed artifact scene type is invalid');
  }
}

function resultValueKey(kind: ReachDeckStagedGenerationJobKind): 'candidate' | 'artifact' {
  // page-generation 与 narration-generation 的结果值都是完整场景工件。
  return kind === 'lesson-plan' || kind === 'page-outline' ? 'candidate' : 'artifact';
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  const allowed = new Set([...keys, ...optional]);
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    expected.size !== keys.length
  ) {
    throw new Error(`${label} contains missing or unsupported keys`);
  }
  return record;
}

/**
 * 调试工作台捕获的完整提示词。
 *
 * 只在 harness 模式下出现，是纯观测数据，不参与任何生成判定；这里只做形状校验，
 * 保证它不会把非字符串内容带进耐久结果。
 */
function parseCapturedModelPrompts(value: unknown): ReachDeckCapturedModelPrompt[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('captured model prompts must be an array');
  return value.map((entry) => {
    const captured = exactRecord(
      entry,
      ['stage', 'serializedModelInput'],
      'captured model prompt',
      ['promptVersion'],
    );
    if (
      typeof captured.stage !== 'string' ||
      typeof captured.serializedModelInput !== 'string' ||
      (captured.promptVersion !== undefined && typeof captured.promptVersion !== 'string')
    ) {
      throw new Error('captured model prompt contains invalid values');
    }
    return {
      stage: captured.stage,
      serializedModelInput: captured.serializedModelInput,
      ...(captured.promptVersion === undefined
        ? {}
        : { promptVersion: captured.promptVersion as string }),
    };
  });
}

/** 词级时间戳校验：非空数组、逐词 text 非空 + 成对秒偏移 + start 单调非降。 */
function parseNarrationWords(
  value: unknown,
  segmentIndex: number,
): Array<{ text: string; start: number; end: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`completed native narration segment ${segmentIndex} words must be nonempty`);
  }
  let previousStart = 0;
  return value.map((wordValue, wordIndex) => {
    const word = exactRecord(
      wordValue,
      ['text', 'start', 'end'],
      `completed native narration segment ${segmentIndex} word ${wordIndex}`,
    );
    if (typeof word.text !== 'string' || word.text.trim().length === 0) {
      throw new Error(
        `completed native narration segment ${segmentIndex} word ${wordIndex} text must be nonblank`,
      );
    }
    if (
      typeof word.start !== 'number' ||
      typeof word.end !== 'number' ||
      !(word.start >= 0) ||
      word.start > word.end ||
      word.start < previousStart
    ) {
      throw new Error(
        `completed native narration segment ${segmentIndex} word ${wordIndex} timing is invalid`,
      );
    }
    previousStart = word.start;
    return { text: word.text, start: word.start, end: word.end };
  });
}
