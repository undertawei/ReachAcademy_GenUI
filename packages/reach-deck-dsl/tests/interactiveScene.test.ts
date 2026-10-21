import { describe, expect, it } from 'vitest';
import {
  auditInteractiveDocumentHtml,
  INTERACTIVE_DOCUMENT_MAX_BYTES,
} from '../src/interactiveHtmlAudit.js';
import {
  canonicalizeInteractiveNarrationText,
  INTERACTIVE_NARRATION_MAX_TEXT_SCALARS,
  parseInteractiveEventManifestValue,
  parseInteractiveNarrationValue,
  parseInteractiveRuntimePolicyValue,
  parseInteractiveSceneValue,
  reachDeckInteractiveNarrationContentDigestInput,
  reachDeckInteractiveNarrationMarkdown,
  reachDeckInteractiveNarrationTextFromMarkdown,
  REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
} from '../src/interactiveScene.js';
import { stripInteractiveNarrationAudio } from '../src/generationWorkspace.js';
import {
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  type ReachDeckSpeechMarkupV1,
} from '../src/speechMarkup.js';
import {
  CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
  classifyInteractiveBlankDocument,
} from '../src/interactiveBlank.js';
import {
  INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_TAILWIND_RUNTIME_ID,
  INTERACTIVE_TAILWIND_RUNTIME_VERSION,
  parseInteractiveRuntimeDependenciesValue,
  parseInteractiveTailwindRuntimeMarkerValue,
} from '../src/interactiveRuntime.js';

const validDocument = `<!doctype html>
<html><head><style>body{margin:0;background-image:url(data:image/png;base64,AA==)}</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5" /></svg><canvas></canvas>
<script>window.ReachInteractive?.ready?.();</script></body></html>`;

const validScene = {
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'interactive-1',
  title: '探索',
  sceneType: 'interactive',
  documentHtml: validDocument,
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimePolicy: { completionMode: 'explicit', allowReset: true, maximumDurationSeconds: 300 },
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1',
    events: [
      {
        name: 'parameter_adjusted',
        eventVersion: 1,
        meaning: 'The learner changed a simulation parameter.',
        payloadFields: [
          {
            name: 'parameter',
            type: 'string',
            required: true,
            maxLength: 40,
            enum: ['mass', 'force'],
          },
          {
            name: 'value',
            type: 'number',
            required: true,
            minimum: 0,
            maximum: 100,
          },
          { name: 'committed', type: 'boolean', required: false },
        ],
        delivery: { mode: 'latest', intervalMs: 500 },
      },
    ],
  },
};

describe('InteractiveScene envelope', () => {
  it('accepts the strict v2 envelope and matching page identity', () => {
    expect(parseInteractiveSceneValue(validScene, 'interactive-1')).toEqual(validScene);
  });

  it('accepts an explicit empty event manifest without inventing an event', () => {
    const withoutMeaningfulEvents = {
      ...validScene,
      eventManifest: { ...validScene.eventManifest, events: [] },
    };
    expect(parseInteractiveSceneValue(withoutMeaningfulEvents)).toEqual(withoutMeaningfulEvents);
  });

  it('uses null to represent an activity without a time limit', () => {
    const untimed = {
      ...validScene,
      runtimePolicy: { ...validScene.runtimePolicy, maximumDurationSeconds: null },
    };
    expect(parseInteractiveSceneValue(untimed, 'interactive-1')).toEqual(untimed);
  });

  it.each([
    [{ ...validScene, extra: true }, /invalid InteractiveScene/],
    [{ ...validScene, id: 'other' }, /invalid InteractiveScene/],
    [{ ...validScene, sceneType: 'slide' }, /invalid InteractiveScene/],
    [{ ...validScene, schemaVersion: 'reach-interactive-scene\/v1' }, /invalid InteractiveScene/],
    [
      { ...validScene, eventManifest: { ...validScene.eventManifest, extra: true } },
      /eventManifest/,
    ],
    [{ ...validScene, bridgeVersion: 'future' }, /invalid InteractiveScene/],
    [
      { ...validScene, runtimePolicy: { ...validScene.runtimePolicy, extra: true } },
      /runtimePolicy/,
    ],
    [
      { ...validScene, runtimePolicy: { ...validScene.runtimePolicy, maximumDurationSeconds: 0 } },
      /runtimePolicy/,
    ],
    [
      {
        ...validScene,
        runtimePolicy: { ...validScene.runtimePolicy, maximumDurationSeconds: 3601 },
      },
      /runtimePolicy/,
    ],
    [
      {
        ...validScene,
        runtimePolicy: { ...validScene.runtimePolicy, maximumDurationSeconds: 1.5 },
      },
      /runtimePolicy/,
    ],
    [
      { ...validScene, runtimePolicy: { ...validScene.runtimePolicy, completionMode: 'quiz' } },
      /runtimePolicy/,
    ],
  ])('rejects malformed envelope or policy values', (value, message) => {
    expect(() => parseInteractiveSceneValue(value, 'interactive-1')).toThrow(message);
  });

  it('rejects missing manifests instead of accepting the old scene shape', () => {
    const { eventManifest: _eventManifest, ...oldShape } = validScene;
    expect(() => parseInteractiveSceneValue(oldShape)).toThrow(/invalid InteractiveScene/);
  });

  it('rejects unsafe prototypes and unsafe policy keys', () => {
    const polluted = Object.assign(Object.create({ inherited: true }), validScene);
    expect(() => parseInteractiveSceneValue(polluted)).toThrow(/invalid InteractiveScene/);
    const unsafePolicy = JSON.parse(
      '{"completionMode":"none","allowReset":false,"maximumDurationSeconds":1,"constructor":"x"}',
    );
    expect(() => parseInteractiveRuntimePolicyValue(unsafePolicy)).toThrow(/runtimePolicy/);
  });
});

describe('Interactive policy and event diagnostics', () => {
  it('names the runtimePolicy constraint the caller violated', () => {
    expect(() =>
      parseInteractiveRuntimePolicyValue({ completionMode: 'explicit', allowReset: true }),
    ).toThrow(
      'runtimePolicy declares exactly completionMode, allowReset, maximumDurationSeconds; received completionMode, allowReset.',
    );
    expect(() =>
      parseInteractiveRuntimePolicyValue({
        completionMode: 'on_submit',
        allowReset: true,
        maximumDurationSeconds: null,
      }),
    ).toThrow('completionMode must be explicit, automatic, or none; received "on_submit".');
    expect(() =>
      parseInteractiveRuntimePolicyValue({
        completionMode: 'none',
        allowReset: true,
        maximumDurationSeconds: 0,
      }),
    ).toThrow('maximumDurationSeconds must be null or an integer within 1..3600; received 0.');
  });

  it('names the event declaration and the constraint it violated', () => {
    const event = validScene.eventManifest.events[0]!;
    expect(() =>
      parseInteractiveEventManifestValue({
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [{ ...event, payloadFields: [] }],
      }),
    ).toThrow(
      'invalid Interactive event declaration "parameter_adjusted": payloadFields must be an array of 1..12 fields',
    );
    const { delivery: _delivery, ...withoutDelivery } = event;
    expect(() =>
      parseInteractiveEventManifestValue({
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [withoutDelivery],
      }),
    ).toThrow('received name, eventVersion, meaning, payloadFields.');
    expect(() =>
      parseInteractiveEventManifestValue({
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [{ ...event, delivery: { mode: 'latest', intervalMs: 300 } }],
      }),
    ).toThrow("use exactly {mode:'immediate'} or {mode:'latest', intervalMs: 250|500|1000|2000}");
    expect(() => parseInteractiveEventManifestValue({ events: [] })).toThrow(
      "expected exactly {schemaVersion:'reach-interactive-event-manifest/v1', events:[...]}",
    );
  });
});

describe('Interactive Tailwind runtime contract', () => {
  it('pins the runtime id, version, and root marker value', () => {
    expect(INTERACTIVE_TAILWIND_RUNTIME_ID).toBe('tailwind-browser');
    expect(INTERACTIVE_TAILWIND_RUNTIME_VERSION).toBe('4.3.0');
    expect(INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE).toBe('data-reach-tailwind-runtime');
    expect(parseInteractiveTailwindRuntimeMarkerValue('4.3.0')).toBe('4.3.0');
    expect(
      parseInteractiveRuntimeDependenciesValue([
        { id: INTERACTIVE_TAILWIND_RUNTIME_ID, version: INTERACTIVE_TAILWIND_RUNTIME_VERSION },
      ]),
    ).toEqual([{ id: 'tailwind-browser', version: '4.3.0' }]);
  });

  it.each([undefined, null, '', '4', '4.3.1'])('rejects marker value %j', (value) => {
    expect(() => parseInteractiveTailwindRuntimeMarkerValue(value)).toThrow(
      /Tailwind runtime marker/,
    );
  });
});

describe('Interactive narration', () => {
  it('keeps legacy scenes valid and accepts text-only and complete narration shapes', () => {
    expect(parseInteractiveSceneValue(validScene)).not.toHaveProperty('narration');

    const draft = {
      schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
      text: '  拖动滑块   比较结果。  ',
    };
    expect(parseInteractiveSceneValue({ ...validScene, narration: draft }).narration).toEqual({
      schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
      text: '拖动滑块 比较结果。',
    });

    const complete = {
      ...draft,
      text: 'Move the slider and observe the result.',
      audioResourceId: 'interactive-narration-audio',
    };
    expect(
      parseInteractiveSceneValue({
        ...validScene,
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }],
        narration: complete,
      }).narration,
    ).toEqual(complete);
  });

  it.each([
    CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>新互动活动</title></head><body><main><h1>新互动活动</h1><p>在这里设计互动内容。</p></main></body></html>',
  ])('rejects narration on a recognized intentional-empty scene', (documentHtml) => {
    expect(() =>
      parseInteractiveSceneValue({
        ...validScene,
        documentHtml,
        narration: {
          schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
          text: 'Explore the activity.',
        },
      }),
    ).toThrow(/intentional-empty.*must not provide narration/i);
  });

  it('canonicalizes only U+0020 while preserving NBSP and combining characters', () => {
    expect(canonicalizeInteractiveNarrationText('  A  e\u0301  中\u00a0文  ')).toBe(
      'A e\u0301 中\u00a0文',
    );
    expect(
      parseInteractiveNarrationValue({
        schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
        text: '探索 🔬 并观察变化。',
      }),
    ).toMatchObject({ text: '探索 🔬 并观察变化。' });
  });

  it('builds a stable versioned digest input from canonical narration text', () => {
    expect(reachDeckInteractiveNarrationContentDigestInput('  调整  参数。  ')).toBe(
      'reach-interactive-narration/v1\n调整 参数。',
    );
    expect(reachDeckInteractiveNarrationContentDigestInput('调整 参数。')).toBe(
      reachDeckInteractiveNarrationContentDigestInput('  调整  参数。  '),
    );
    expect(() => reachDeckInteractiveNarrationContentDigestInput('first\nsecond')).toThrow(
      /plain-text paragraph/,
    );
  });

  it('counts Unicode scalar values rather than UTF-16 code units', () => {
    const atLimit = '🔬'.repeat(INTERACTIVE_NARRATION_MAX_TEXT_SCALARS);
    expect(canonicalizeInteractiveNarrationText(atLimit)).toBe(atLimit);
    expect(() => canonicalizeInteractiveNarrationText(`${atLimit}a`)).toThrow(
      /600 Unicode scalar values/,
    );

    const combiningAtLimit = 'e\u0301'.repeat(INTERACTIVE_NARRATION_MAX_TEXT_SCALARS / 2);
    expect(canonicalizeInteractiveNarrationText(combiningAtLimit)).toBe(combiningAtLimit);
    expect(() => canonicalizeInteractiveNarrationText(`${combiningAtLimit}e`)).toThrow(
      /600 Unicode scalar values/,
    );
  });

  it.each([
    ['', /cannot be empty/],
    ['   ', /cannot be empty/],
    ['first\nsecond', /plain-text paragraph/],
    ['first\rsecond', /plain-text paragraph/],
    ['first\tsecond', /plain-text paragraph/],
    ['first\u0085second', /plain-text paragraph/],
    ['first\u2028second', /plain-text paragraph/],
    ['first\u2029second', /plain-text paragraph/],
    ['first\ufeffsecond', /plain-text paragraph/],
    ['first\ud800second', /isolated surrogates/],
    ['first\udc00second', /isolated surrogates/],
  ])('rejects non-paragraph narration text %#', (text, message) => {
    expect(() => canonicalizeInteractiveNarrationText(text)).toThrow(message);
  });

  it.each([
    [
      {
        schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
        text: 'Valid text.',
        segments: [],
      },
    ],
    [
      {
        schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
        text: 'Valid text.',
        duration: 1,
      },
    ],
    [{ schemaVersion: 'reach-interactive-narration/v2', text: 'Valid text.' }],
    [
      {
        schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
        text: 'Valid text.',
        audioResourceId: '',
      },
    ],
  ])('rejects non-exact or invalid narration shape %#', (narration) => {
    expect(() => parseInteractiveNarrationValue(narration)).toThrow(/Interactive narration/);
  });
});

describe('Interactive narration speech markup', () => {
  const narrationOf = (text: string, speechMarkup?: unknown, audioResourceId?: string) => ({
    schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
    text,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    ...(audioResourceId === undefined ? {} : { audioResourceId }),
  });
  const markupOf = (marks: unknown[], speak?: unknown) => ({
    schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
    marks,
    ...(speak === undefined ? {} : { speak }),
  });

  it('accepts, canonicalizes, and orders speechMarkup before audioResourceId', () => {
    const parsed = parseInteractiveNarrationValue(
      narrationOf(
        '拖动  滑块，观察 SSML 结果。',
        markupOf([
          { type: 'sub', from: 10, to: 14, alias: '语音标记' },
          { type: 'break', at: 2, durationMs: 300 },
        ]),
        'audio-1',
      ),
    );
    expect(parsed).toEqual({
      schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
      text: '拖动 滑块，观察 SSML 结果。',
      speechMarkup: markupOf([
        { type: 'break', at: 2, durationMs: 300 },
        { type: 'sub', from: 10, to: 14, alias: '语音标记' },
      ]),
      audioResourceId: 'audio-1',
    });
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'text',
      'speechMarkup',
      'audioResourceId',
    ]);
    expect(parseInteractiveNarrationValue(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(
      parseInteractiveSceneValue({ ...validScene, narration: parsed }).narration?.speechMarkup,
    ).toEqual(parsed.speechMarkup);
  });

  it('accepts speak-only markup and omits empty markup', () => {
    const speakOnly = markupOf([], { backgroundMusicVolume: 30 });
    expect(parseInteractiveNarrationValue(narrationOf('观察结果。', speakOnly))).toEqual(
      narrationOf('观察结果。', speakOnly),
    );
    const omitted = parseInteractiveNarrationValue(
      narrationOf('观察结果。', markupOf([]), 'audio-1'),
    );
    expect(omitted).toEqual(narrationOf('观察结果。', undefined, 'audio-1'));
    expect(omitted).not.toHaveProperty('speechMarkup');
  });

  it('anchors offsets on the derived narration Markdown', () => {
    // 纯文本 `a - b` 的派生 Markdown 为 `a \\- b`：偏移 3 落在转义内部，非法。
    expect(reachDeckInteractiveNarrationMarkdown('a - b')).toBe('a \\- b');
    expect(
      parseInteractiveNarrationValue(
        narrationOf('a - b', markupOf([{ type: 'break', at: 2, durationMs: 100 }])),
      ).speechMarkup?.marks,
    ).toEqual([{ type: 'break', at: 2, durationMs: 100 }]);
    expect(() =>
      parseInteractiveNarrationValue(
        narrationOf('a - b', markupOf([{ type: 'break', at: 3, durationMs: 100 }])),
      ),
    ).toThrow(/Invalid Interactive narration speechMarkup/);
  });

  it.each([
    ['offset beyond the text', markupOf([{ type: 'break', at: 99, durationMs: 100 }])],
    ['span inside a formula', markupOf([{ type: 'say-as', from: 3, to: 4, interpretAs: 'Math' }])],
    ['unknown mark key', markupOf([{ type: 'break', at: 1, durationMs: 100, extra: true }])],
    ['empty speak options', markupOf([], {})],
    ['wrong schema version', { schemaVersion: 'reach-deck-speech-marks/v0', marks: [] }],
    ['non-record markup', 'markup'],
  ])('rejects invalid speechMarkup: %s', (_label, speechMarkup) => {
    expect(() =>
      parseInteractiveNarrationValue(narrationOf('读 \\(x+1\\) 的值。', speechMarkup)),
    ).toThrow(/Invalid Interactive narration speechMarkup/);
  });

  it('still rejects unknown keys and markup on text the Markdown dialect cannot represent', () => {
    expect(() =>
      parseInteractiveNarrationValue({
        ...narrationOf('观察结果。', markupOf([{ type: 'break', at: 1, durationMs: 100 }])),
        marks: [],
      }),
    ).toThrow('AI provider returned invalid Interactive narration.');
    expect(parseInteractiveNarrationValue(narrationOf('1. 先观察。'))).toEqual(
      narrationOf('1. 先观察。'),
    );
    expect(() =>
      parseInteractiveNarrationValue(
        narrationOf('1. 先观察。', markupOf([{ type: 'break', at: 1, durationMs: 100 }])),
      ),
    ).toThrow(/cannot be represented as narration Markdown/);
  });

  it('keeps speechMarkup when stripping synthesized audio', () => {
    const narration = parseInteractiveNarrationValue(
      narrationOf('观察结果。', markupOf([{ type: 'break', at: 2, durationMs: 200 }]), 'audio-1'),
    );
    const scene = parseInteractiveSceneValue({ ...validScene, narration });
    expect(stripInteractiveNarrationAudio(scene).narration).toEqual({
      schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
      text: '观察结果。',
      speechMarkup: narration.speechMarkup,
    });
  });

  it.each([
    ['plain CJK text', '拖动滑块，比较结果。', '拖动滑块，比较结果。'],
    ['emoji', '探索 🔬 并观察变化。', '探索 🔬 并观察变化。'],
    ['hyphen and underscore', 'a - b_c', 'a \\- b\\_c'],
    ['quote and heading markers', '> 注意 # 标题', '\\> 注意 \\# 标题'],
    ['asterisks', '2 * 3 = 6', '2 \\* 3 = 6'],
    ['mid-text ordered marker', '步骤 1. 观察', '步骤 1. 观察'],
    ['literal backslash', 'a\\b', 'a\\\\b'],
    ['canonical inline formula', '面积 \\(S=\\pi r^2\\) 不变。', '面积 \\(S=\\pi r^2\\) 不变。'],
    ['non-canonical formula text', '\\(x\\) a*b', '\\\\(x\\\\) a\\*b'],
    ['whole block formula text', '\\[x\\]', '\\\\[x\\\\]'],
    ['escaped markdown text', 'a \\- b', 'a \\- b'],
  ])('derives single-paragraph Markdown from %s', (_label, text, markdown) => {
    expect(reachDeckInteractiveNarrationMarkdown(text)).toBe(markdown);
    expect(reachDeckInteractiveNarrationMarkdown(`  ${text}  `)).toBe(markdown);
  });

  it.each(['1. 先观察。', '2) 再比较。', '见 [说明](http://example.com)。'])(
    'rejects plain text the narration Markdown dialect cannot represent: %s',
    (text) => {
      expect(() => reachDeckInteractiveNarrationMarkdown(text)).toThrow(
        /cannot be represented as narration Markdown/,
      );
    },
  );

  it.each([
    ['拖动滑块，比较结果。', '拖动滑块，比较结果。'],
    ['探索 🔬 并观察变化。', '探索 🔬 并观察变化。'],
    ['a \\- b\\_c', 'a - b_c'],
    ['\\- 列表样式开头', '- 列表样式开头'],
    ['\\> 注意 \\# 标题 \\* 号', '> 注意 # 标题 * 号'],
    ['步骤 1. 观察', '步骤 1. 观察'],
    ['a\\\\b', 'a\\b'],
    ['\\<b\\> 标签', '<b> 标签'],
    ['面积 \\(S=\\pi r^2\\) 不变。', '面积 \\(S=\\pi r^2\\) 不变。'],
    // 解码后的 `\\(x\\)` 会被重新解释为公式，故回退为 Markdown 本身。
    ['\\\\(x\\\\) 字面量', '\\\\(x\\\\) 字面量'],
    ['\\\\(x\\\\) a\\*b', '\\(x\\) a*b'],
    ['\\\\[x\\\\]', '\\[x\\]'],
  ])('round-trips editor Markdown %j through text', (markdown, text) => {
    expect(reachDeckInteractiveNarrationTextFromMarkdown(markdown)).toBe(text);
    expect(reachDeckInteractiveNarrationMarkdown(text)).toBe(markdown);
  });

  it('collapses U+0020 runs, so only whitespace-canonical Markdown round-trips exactly', () => {
    expect(reachDeckInteractiveNarrationTextFromMarkdown('a  b ')).toBe('a b');
    expect(reachDeckInteractiveNarrationMarkdown('a b')).toBe('a b');
  });

  it.each([
    ['first\n\nsecond', /one paragraph/],
    ['first\nsecond', /one paragraph/],
    ['\\[x\\]', /one paragraph/],
    ['a*b', /canonical narration Markdown/],
    ['', /visible text/],
    ['a\tb', /plain-text paragraph/],
  ])('rejects non-single-paragraph editor Markdown %j', (markdown, message) => {
    expect(() => reachDeckInteractiveNarrationTextFromMarkdown(markdown)).toThrow(message);
  });

  it('keeps the historical digest input unless non-empty markup is present', () => {
    const legacy = 'reach-interactive-narration/v1\n调整 参数。';
    expect(reachDeckInteractiveNarrationContentDigestInput('调整  参数。')).toBe(legacy);
    expect(reachDeckInteractiveNarrationContentDigestInput('调整 参数。', undefined)).toBe(legacy);
    expect(
      reachDeckInteractiveNarrationContentDigestInput(
        '调整 参数。',
        markupOf([]) as ReachDeckSpeechMarkupV1,
      ),
    ).toBe(legacy);

    const breakMark = { type: 'break', at: 2, durationMs: 200 } as const;
    const subMark = { type: 'sub', from: 3, to: 5, alias: '参量' } as const;
    const withMarks = reachDeckInteractiveNarrationContentDigestInput(
      '调整 参数。',
      markupOf([subMark, breakMark]) as ReachDeckSpeechMarkupV1,
    );
    expect(withMarks).toBe(`${legacy}\0${JSON.stringify(markupOf([breakMark, subMark]))}`);
    expect(
      reachDeckInteractiveNarrationContentDigestInput(
        '调整  参数。',
        markupOf([breakMark, subMark]) as ReachDeckSpeechMarkupV1,
      ),
    ).toBe(withMarks);
    expect(
      reachDeckInteractiveNarrationContentDigestInput(
        '调整 参数。',
        markupOf([{ ...breakMark, durationMs: 300 }, subMark]) as ReachDeckSpeechMarkupV1,
      ),
    ).not.toBe(withMarks);
    expect(() =>
      reachDeckInteractiveNarrationContentDigestInput(
        '调整 参数。',
        markupOf([{ ...breakMark, at: 99 }]) as ReachDeckSpeechMarkupV1,
      ),
    ).toThrow();
  });
});

describe('Interactive blank template and runtime declarations', () => {
  it('classifies only the canonical template and the two bounded legacy editor shapes', () => {
    expect(classifyInteractiveBlankDocument(CANONICAL_BLANK_INTERACTIVE_DOCUMENT)).toBe(
      'canonical-v1',
    );
    expect(
      classifyInteractiveBlankDocument(`<!doctype html>
        <html lang="en-US"><head><meta charset="utf-8"><title>New interactive activity</title></head>
        <body><main><h1>New interactive activity</h1><p>Design the interactive content here.</p></main></body></html>`),
    ).toBe('legacy-editor-v1');
    expect(
      classifyInteractiveBlankDocument(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>新互动活动</title></head><body><main><h1>新互动活动</h1><p>在这里设计互动内容。</p></main></body></html>',
      ),
    ).toBe('legacy-editor-v1');
  });

  it('does not let unmarked, marker-only, altered, or spoof-ready content classify as blank', () => {
    for (const documentHtml of [
      '<!doctype html><html><head></head><body></body></html>',
      '<!doctype html><html><head><meta name="reach-interactive-template" content="reach-interactive-blank/v1"></head><body><main></main></body></html>',
      CANONICAL_BLANK_INTERACTIVE_DOCUMENT.replace(
        '</main>',
        '<button>Real activity</button></main>',
      ),
      '<!doctype html><html><head></head><body><button>Real activity</button><script>ReachInteractive.ready({empty:true})</script></body></html>',
    ]) {
      expect(classifyInteractiveBlankDocument(documentHtml)).toBe('nonblank');
    }
  });

  it('accepts only unique supported runtime pins and sorts them canonically', () => {
    expect(
      parseInteractiveRuntimeDependenciesValue([
        { id: 'function-plot', version: '1.25.4' },
        { id: 'animate-css', version: '4.1.1' },
        { id: 'expression', version: '3.0.3' },
      ]),
    ).toEqual([
      { id: 'animate-css', version: '4.1.1' },
      { id: 'expression', version: '3.0.3' },
      { id: 'function-plot', version: '1.25.4' },
    ]);
    expect(() =>
      parseInteractiveRuntimeDependenciesValue([{ id: 'mermaid', version: '11.16.0' }]),
    ).toThrow(/id, version/);
    expect(() =>
      parseInteractiveRuntimeDependenciesValue([{ id: 'expression', version: '3.0.2' }]),
    ).toThrow(/id, version/);
    expect(() =>
      parseInteractiveRuntimeDependenciesValue([
        { id: 'expression', version: '3.0.3' },
        { id: 'expression', version: '3.0.3' },
      ]),
    ).toThrow(/id, version/);
  });
});

describe('Interactive event manifest', () => {
  const manifest = validScene.eventManifest;

  it('accepts all bounded scalar field types and both delivery modes', () => {
    const value = {
      schemaVersion: 'reach-interactive-event-manifest/v1',
      events: [
        manifest.events[0],
        {
          name: 'strategy_chosen',
          eventVersion: 1,
          meaning: 'The learner committed to a strategy.',
          payloadFields: [
            {
              name: 'step_count',
              type: 'integer',
              required: true,
              minimum: 1,
              maximum: 20,
            },
          ],
          delivery: { mode: 'immediate' },
        },
      ],
    };
    expect(parseInteractiveEventManifestValue(value)).toEqual(value);
  });

  it.each([
    [{ ...manifest, schemaVersion: 'future' }, /eventManifest/],
    [
      {
        ...manifest,
        events: Array.from({ length: 13 }, (_, index) => ({
          ...manifest.events[0],
          name: `event_${index}`,
        })),
      },
      /eventManifest/,
    ],
    [{ ...manifest, events: [manifest.events[0], manifest.events[0]] }, /declaration/],
    [{ ...manifest, events: [{ ...manifest.events[0], name: 'ParameterChanged' }] }, /declaration/],
    [{ ...manifest, events: [{ ...manifest.events[0], eventVersion: 2 }] }, /declaration/],
    [{ ...manifest, events: [{ ...manifest.events[0], meaning: '' }] }, /declaration/],
    [{ ...manifest, events: [{ ...manifest.events[0], payloadFields: [] }] }, /declaration/],
    [
      {
        ...manifest,
        events: [{ ...manifest.events[0], delivery: { mode: 'latest', intervalMs: 300 } }],
      },
      /delivery/,
    ],
    [
      {
        ...manifest,
        events: [{ ...manifest.events[0], delivery: { mode: 'immediate', intervalMs: 250 } }],
      },
      /delivery/,
    ],
  ])('rejects invalid manifest structure', (value, message) => {
    expect(() => parseInteractiveEventManifestValue(value)).toThrow(message);
  });

  // 报错必须点名字段、所属事件和违反的约束：生成侧只拿到一句"invalid payload field"时会放弃提交整页。
  it.each([
    [{ name: 'bad-name', type: 'boolean', required: true }, /"bad-name".+name must match/],
    [
      { name: 'choice', type: 'string', required: true, maxLength: 201, enum: [] },
      /"choice" on event "parameter_adjusted": maxLength must be an integer within 1\.\.200; received 201/,
    ],
    [
      { name: 'choice', type: 'string', required: true, maxLength: 3, enum: ['long'] },
      /every enum member must be a non-empty string of at most maxLength \(3\)/,
    ],
    [
      { name: 'value', type: 'number', required: true, minimum: Number.NaN, maximum: 1 },
      /minimum and maximum must be finite numbers within -1000000000\.\.1000000000/,
    ],
    [
      { name: 'value', type: 'number', required: true, minimum: 2, maximum: 1 },
      /minimum must not exceed maximum/,
    ],
    [
      { name: 'count', type: 'integer', required: true, minimum: 0.5, maximum: 2 },
      /an integer field requires integer minimum and maximum/,
    ],
    [
      { name: 'flag', type: 'boolean', required: true, maximum: 1 },
      /a boolean field declares exactly name, type, required; received name, type, required, maximum/,
    ],
    [{ name: 'answer', type: 'boolean', required: true }, /"answer".+name is reserved/],
    [
      { name: 'choice', type: 'text', required: true },
      /type must be one of string, number, integer, boolean; received "text"/,
    ],
    [{ name: 'flag', type: 'boolean' }, /required must be declared explicitly/],
  ])('rejects malformed bounded scalar fields', (field, message) => {
    expect(() =>
      parseInteractiveEventManifestValue({
        ...manifest,
        events: [{ ...manifest.events[0], payloadFields: [field] }],
      }),
    ).toThrow(message);
  });
});

describe('Interactive document HTML audit', () => {
  it('accepts complete inline HTML, CSS, JavaScript, SVG, Canvas, and embedded visual assets', () => {
    expect(auditInteractiveDocumentHtml(validDocument)).toEqual(
      expect.objectContaining({ status: 'pass', issues: [] }),
    );
  });

  it.each([
    ['remote script', '<script src="https://cdn.example/app.js"></script>', 'external_resource'],
    ['relative image', '<img src="/asset.png">', 'external_resource'],
    [
      'mixed image srcset',
      '<img srcset="data:image/png;base64,AA== 1x, https://cdn.example/a.png 2x">',
      'external_resource',
    ],
    ['remote CSS', '<style>@import "https://cdn.example/a.css";</style>', 'external_resource'],
    ['nested frame', '<iframe srcdoc="<p>x</p>"></iframe>', 'nested_document'],
    ['fetch', '<script>fetch("https://example.test")</script>', 'network_api'],
    ['optional fetch', '<script>window.fetch?.("https://example.test")</script>', 'network_api'],
    [
      'bracket fetch',
      '<script>globalThis["fetch"]("https://example.test")</script>',
      'network_api',
    ],
    [
      'static template bracket fetch',
      '<script>window[`fetch`]("https://example.test")</script>',
      'network_api',
    ],
    [
      'computed template global property',
      '<script>window[`fe${suffix}tch`]("https://example.test")</script>',
      'network_api',
    ],
    [
      'template expression fetch',
      '<script>const result = `${fetch?.("https://example.test")}`</script>',
      'network_api',
    ],
    [
      'template expression after regex',
      '<script>const result = `${/}/.test("}") && fetch?.("https://example.test")}`</script>',
      'network_api',
    ],
    [
      'division after a control-body call',
      '<script>if (ready) compute() / fetch / divisor</script>',
      'network_api',
    ],
    [
      'worker division after a control-body call',
      '<script>while (ready) compute() / Worker / divisor</script>',
      'worker_api',
    ],
    ['quoted handler fetch', '<button onclick="fetch?.(event)">x</button>', 'network_api'],
    ['unquoted handler fetch', '<button onclick=fetch?.(event)>x</button>', 'network_api'],
    [
      'entity handler fetch',
      '<button onclick="window.fetch&#x3f;.(event)">x</button>',
      'network_api',
    ],
    ['dynamic import', '<script type="module">import("./chunk.js")</script>', 'network_api'],
    ['worker', '<script>new Worker("data:text/javascript,")</script>', 'worker_api'],
    [
      'optional worker',
      '<script>globalThis.Worker?.("data:text/javascript,")</script>',
      'worker_api',
    ],
    [
      'static template bracket worker',
      '<script>self[`Worker`]("data:text/javascript,")</script>',
      'worker_api',
    ],
    [
      'computed template worker global property',
      '<script>navigator[`service${suffix}Worker`].register("worker.js")</script>',
      'network_api',
    ],
    [
      'handler service worker',
      '<button onclick="navigator?.serviceWorker.register(event)">x</button>',
      'worker_api',
    ],
    [
      'service worker',
      '<script>navigator.serviceWorker.register("/worker.js")</script>',
      'worker_api',
    ],
    [
      'policy override',
      '<meta http-equiv="Content-Security-Policy" content="default-src *">',
      'policy_override',
    ],
  ])('rejects unsupported offline construct: %s', (_name, fragment, code) => {
    const result = auditInteractiveDocumentHtml(
      `<!doctype html><html><head></head><body>${fragment}</body></html>`,
    );
    expect(result.issues.map((candidate) => candidate.code)).toContain(code);
  });

  it('allows data/blob resources and does not mistake comments or strings for network calls', () => {
    const result = auditInteractiveDocumentHtml(
      '<!doctype html><html><head><style>.x{background:url(data:image/png;base64,AA==)}</style></head><body><!-- <script>fetch("x")</script><button onclick="new Worker()">ignored</button> --><img src="blob:local"><button onclick="const note=\'fetch?.()\'; const pattern=/fetch|Worker/">x</button><script>// fetch("x")\nconst note="new Worker() and import(\\"x\\")"; const pattern=/fetch|Worker|}/; const template=`fetch?.() ${/}/.test("}") ? 1 : 0}`; ReachInteractive.ready({restored:false});</script></body></html>',
    );
    expect(result.status).toBe('pass');
  });

  it('rejects forged bundled KaTeX markers unless the pinned bytes match exactly', () => {
    for (const [fragment, code] of [
      ['<script data-maic-offline-katex>/* pinned bundle */ fetch Worker</script>', 'worker_api'],
      ['<script data-maic-offline-katex id="spoof">fetch</script>', 'network_api'],
    ] as const) {
      const result = auditInteractiveDocumentHtml(
        `<!doctype html><html><head></head><body>${fragment}</body></html>`,
      );
      expect(result.issues.map((entry) => entry.code)).toContain('network_api');
      expect(result.issues.map((entry) => entry.code)).toContain(code);
    }
  });

  it('allows quoted and unquoted offline CSS urls', () => {
    const result = auditInteractiveDocumentHtml(`<!doctype html><html><head><style>
      .data { background: url("data:image/png;base64,AA==") }
      .blob { background: url('blob:local') }
      .fragment { filter: url("#mask") }
    </style></head><body>
      <div style="background:url(data:image/png;base64,AA==)">x</div>
    </body></html>`);

    expect(result.status).toBe('pass');
  });

  it('keeps standalone and ordinary computed templates inert', () => {
    const result = auditInteractiveDocumentHtml(`<!doctype html><html><head></head><body><script>
      const note = \`fetch Worker serviceWorker\`;
      const label = \`item-${'${kind}'}\`;
      const property = model[\`label-${'${kind}'}\`];
    </script></body></html>`);

    expect(result.status).toBe('pass');
  });

  it('treats regex literals at control-statement body starts as inert executable data', () => {
    const result = auditInteractiveDocumentHtml(`<!doctype html><html><head></head><body>
      <button onclick="if /* header */ (ready) /fetch|Worker|serviceWorker/.test(label)">x</button>
      <script>
        if (((ready))) /* nested body */ /fetch/.test(label);
        while /* spaced header */ ((ready))
          /Worker/.test(label);
        for /* loop header */ (let index = 0; index < 1; index += 1) /* body */
          /serviceWorker/.test(label);
      </script>
    </body></html>`);

    expect(result.status).toBe('pass');
  });

  it('requires a complete document and rejects malformed markup', () => {
    expect(auditInteractiveDocumentHtml('<div>fragment</div>').issues).toContainEqual(
      expect.objectContaining({ code: 'document_incomplete' }),
    );
    expect(
      auditInteractiveDocumentHtml(
        '<html><head></head><body><div title="unterminated></div></body></html>',
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'malformed_markup' }));
  });

  it('measures the 512 KiB limit as UTF-8 bytes', () => {
    const overhead = new TextEncoder().encode('<html><head></head><body></body></html>').byteLength;
    const atLimit = `<html><head></head><body>${'a'.repeat(INTERACTIVE_DOCUMENT_MAX_BYTES - overhead)}</body></html>`;
    expect(auditInteractiveDocumentHtml(atLimit).status).toBe('pass');
    const overLimit = `<html><head></head><body>${'界'.repeat(Math.ceil(INTERACTIVE_DOCUMENT_MAX_BYTES / 3))}</body></html>`;
    expect(auditInteractiveDocumentHtml(overLimit).issues).toContainEqual(
      expect.objectContaining({ code: 'document_too_large' }),
    );
  });
});
