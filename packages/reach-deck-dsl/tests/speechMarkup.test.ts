import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_SAY_AS_INTERPRETATIONS,
  REACH_DECK_SPEECH_EFFECTS,
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  REACH_DECK_SSML_MAX_CHARACTERS,
  REACH_DECK_SSML_MAX_SEMANTIC_UNITS,
  ReachDeckSpeechMarkupError,
  applyReachDeckNarrationToNativeSlide,
  analyzeReachDeckNarrationMarkdown,
  canonicalizeReachDeckSpeechMarkupV1,
  invalidateReachDeckNativeSlideNarration,
  isReachDeckSpeechMarkupLegalBoundary,
  normalizeReachDeckNarrationMarkdown,
  parseReachDeckNativeSlideV2,
  parseReachDeckSpeechMarkupV1,
  planReachDeckSsmlChunks,
  planReachDeckSsmlSelectionChunks,
  projectReachDeckSpeechDocument,
  projectReachDeckSpeechMarkup,
  projectReachDeckSpeechVisibleRange,
  reachDeckNarrationContentDigestInput,
  reachDeckNarrationFormulaRanges,
  reachDeckNarrationSpeechContentDigestInput,
  reachDeckSpeechMarkupLegalBoundaries,
  serializeReachDeckSpeechMarkupToSsml,
  type ReachDeckNativeSlideV2,
  type ReachDeckSpeechMarkupV1,
  type ReachDeckSpeechMarkV1,
} from '../src/index.js';

const markup = (marks: ReachDeckSpeechMarkV1[]): ReachDeckSpeechMarkupV1 => ({
  schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  marks,
});

const rangeOf = (source: string, selected: string) => {
  const from = source.indexOf(selected);
  if (from < 0) throw new Error(`Missing fixture selection: ${selected}`);
  return { from, to: from + selected.length };
};

const nativeSlide = (narration?: ReachDeckNativeSlideV2['narration']): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide-1',
  title: 'Speech marks',
  background: { kind: 'none' },
  elements: [],
  animations: [],
  ...(narration === undefined ? {} : { narration }),
});

describe('Reach Deck speech-mark contract', () => {
  it('strictly parses every supported mark and serializes allowlisted SSML', () => {
    const markdown = normalizeReachDeckNarrationMarkdown('欢迎 SSML，日期 2026-09-11，汉字。');
    const speechMarkup = markup([
      { type: 'break', at: 2, durationMs: 200 },
      { type: 'sub', ...rangeOf(markdown, 'SSML'), alias: '语音标记' },
      {
        type: 'say-as',
        ...rangeOf(markdown, normalizeReachDeckNarrationMarkdown('2026-09-11')),
        interpretAs: 'Date-YMD',
      },
      { type: 'phoneme', ...rangeOf(markdown, '汉字'), alphabet: 'py', ph: 'han4 zi4' },
    ]);

    expect(parseReachDeckSpeechMarkupV1(speechMarkup, markdown)).toEqual(speechMarkup);
    expect(serializeReachDeckSpeechMarkupToSsml(markdown, speechMarkup)).toBe(
      '<speak>欢迎<break time="200ms"/> <sub alias="语音标记">SSML</sub>，日期 <say-as interpret-as="Date-YMD">2026-09-11</say-as>，<phoneme alphabet="py" ph="han4 zi4">汉字</phoneme>。</speak>',
    );
  });

  it('serializes sound events and document settings while keeping alignment XML-free', () => {
    const markdown = '甲乙';
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [
        {
          type: 'soundEvent',
          at: 1,
          src: 'https://cdn.example.com/chime.mp3?variant=1&gain=2',
        },
      ],
      speak: {
        bgm: 'https://cdn.example.com/music.mp3?track=1&loop=true',
        backgroundMusicVolume: 35,
        effect: 'true_robot',
      },
    };

    expect(parseReachDeckSpeechMarkupV1(speechMarkup, markdown)).toEqual(speechMarkup);
    expect(serializeReachDeckSpeechMarkupToSsml(markdown, speechMarkup)).toBe(
      '<speak bgm="https://cdn.example.com/music.mp3?track=1&amp;loop=true" backgroundMusicVolume="35" effect="true_robot">甲<soundEvent src="https://cdn.example.com/chime.mp3?variant=1&amp;gain=2"/>乙</speak>',
    );
    expect(projectReachDeckSpeechMarkup(markdown, speechMarkup)).toMatchObject({
      visibleText: markdown,
      alignmentTranscript: markdown,
      alignmentMap: expect.arrayContaining([
        expect.objectContaining({
          kind: 'soundEvent',
          markdownFrom: 1,
          markdownTo: 1,
          spokenFrom: 1,
          spokenTo: 1,
          atomic: true,
        }),
      ]),
    });
  });

  it.each(REACH_DECK_SAY_AS_INTERPRETATIONS)(
    'accepts and serializes documented say-as interpretation %s',
    (interpretAs) => {
      const speechMarkup = markup([{ type: 'say-as', from: 0, to: 3, interpretAs }]);

      expect(parseReachDeckSpeechMarkupV1(speechMarkup, '123')).toEqual(speechMarkup);
      expect(serializeReachDeckSpeechMarkupToSsml('123', speechMarkup)).toBe(
        `<speak><say-as interpret-as="${interpretAs}">123</say-as></speak>`,
      );
    },
  );

  it.each(REACH_DECK_SPEECH_EFFECTS)(
    'accepts and serializes documented speak effect %s',
    (effect) => {
      const speechMarkup: ReachDeckSpeechMarkupV1 = {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { effect },
      };

      expect(parseReachDeckSpeechMarkupV1(speechMarkup, '正文')).toEqual(speechMarkup);
      expect(serializeReachDeckSpeechMarkupToSsml('正文', speechMarkup)).toBe(
        `<speak effect="${effect}">正文</speak>`,
      );
    },
  );

  it('rejects unsafe URLs and invalid document settings', () => {
    const invalid: unknown[] = [
      markup([{ type: 'soundEvent', at: 1, src: '/relative/chime.mp3' }]),
      markup([{ type: 'soundEvent', at: 1, src: 'file:///tmp/chime.mp3' }]),
      markup([
        {
          type: 'soundEvent',
          at: 1,
          src: 'https://user:secret@example.com/chime.mp3',
        },
      ]),
      markup([{ type: 'soundEvent', at: 1, src: 'https://example.com/chime.mp3#sample' }]),
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { bgm: 'javascript:alert(1)' },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { bgm: 'https://user:secret@example.com/music.mp3' },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { bgm: 'https://example.com/music.mp3#sample' },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { backgroundMusicVolume: -1 },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { backgroundMusicVolume: 101 },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { backgroundMusicVolume: 1.5 },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { effect: 'unsupported_effect' },
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: {},
      },
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [],
        speak: { effect: 'true_robot', extra: true },
      },
    ];

    for (const candidate of invalid) {
      expect(() => parseReachDeckSpeechMarkupV1(candidate, '正文')).toThrowError(
        ReachDeckSpeechMarkupError,
      );
    }
  });

  it('unescapes Markdown before XML escaping text and attributes', () => {
    const markdown = normalizeReachDeckNarrationMarkdown('A < B & "SSML"');
    const speechMarkup = markup([{ type: 'sub', ...rangeOf(markdown, 'SSML'), alias: 'A&B<"\'' }]);

    expect(markdown).toBe('A \\< B & "SSML"');
    expect(serializeReachDeckSpeechMarkupToSsml(markdown, speechMarkup)).toBe(
      '<speak>A &lt; B &amp; "<sub alias="A&amp;B&lt;&quot;&apos;">SSML</sub>"</speak>',
    );
  });

  it('rejects unknown and missing keys at both schema levels', () => {
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        { schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION, marks: [], extra: true },
        '正文',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-schema' }));
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        markup([{ type: 'break', at: 1, durationMs: 200, extra: true } as never]),
        '正文',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-schema' }));
    expect(() =>
      parseReachDeckSpeechMarkupV1(markup([{ type: 'prosody', from: 0, to: 1 } as never]), '正文'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-mark' }));
  });

  it('requires persisted marks to be canonical and offers deterministic editor canonicalization', () => {
    const unsorted = markup([
      { type: 'sub', from: 2, to: 3, alias: '乙' },
      { type: 'break', at: 1, durationMs: 100 },
    ]);
    expect(() => parseReachDeckSpeechMarkupV1(unsorted, '甲乙丙')).toThrowError(
      expect.objectContaining({ code: 'non-canonical-order' }),
    );
    expect(canonicalizeReachDeckSpeechMarkupV1(unsorted, '甲乙丙').marks).toEqual([
      { type: 'break', at: 1, durationMs: 100 },
      { type: 'sub', from: 2, to: 3, alias: '乙' },
    ]);
  });

  it('rejects duplicate, crossing, nested, and point-inside-span marks', () => {
    const invalid = [
      markup([
        { type: 'break', at: 1, durationMs: 100 },
        { type: 'break', at: 1, durationMs: 200 },
      ]),
      markup([
        { type: 'sub', from: 0, to: 3, alias: '甲' },
        { type: 'say-as', from: 2, to: 4, interpretAs: 'Cardinal' },
      ]),
      markup([
        { type: 'sub', from: 0, to: 4, alias: '甲' },
        { type: 'phoneme', from: 1, to: 2, alphabet: 'py', ph: 'yi1' },
      ]),
      markup([
        { type: 'sub', from: 0, to: 4, alias: '甲' },
        { type: 'break', at: 2, durationMs: 100 },
      ]),
    ];
    for (const candidate of invalid) {
      expect(() => canonicalizeReachDeckSpeechMarkupV1(candidate, '甲乙丙丁')).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/^(invalid-mark|overlapping-marks)$/),
        }),
      );
    }
  });

  it('rejects formula intersections while exposing their full canonical ranges', () => {
    const markdown = '先算 \\(x<y\\)，再看\n\n\\[a+b\\]';
    const inlineFrom = markdown.indexOf('\\(');
    const blockFrom = markdown.indexOf('\\[');
    expect(reachDeckNarrationFormulaRanges(markdown)).toEqual([
      { from: inlineFrom, to: markdown.indexOf('\\)') + 2 },
      { from: blockFrom, to: markdown.indexOf('\\]') + 2 },
    ]);
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        markup([{ type: 'break', at: inlineFrom + 2, durationMs: 100 }]),
        markdown,
      ),
    ).toThrowError(expect.objectContaining({ code: 'formula-intersection' }));
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        markup([
          {
            type: 'sub',
            from: inlineFrom - 1,
            to: markdown.indexOf('\\)') + 2,
            alias: '比较式',
          },
        ]),
        markdown,
      ),
    ).toThrowError(expect.objectContaining({ code: 'formula-intersection' }));
  });

  it('uses UTF-16 coordinates without permitting surrogate or Markdown escape splits', () => {
    expect(() =>
      parseReachDeckSpeechMarkupV1(markup([{ type: 'break', at: 1, durationMs: 100 }]), '😀好'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-boundary' }));

    const escaped = normalizeReachDeckNarrationMarkdown('-');
    expect(escaped).toBe('\\-');
    expect(isReachDeckSpeechMarkupLegalBoundary(escaped, 1)).toBe(false);
    expect(isReachDeckSpeechMarkupLegalBoundary(escaped, 2)).toBe(true);
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        markup([{ type: 'say-as', from: 1, to: 2, interpretAs: 'Spell' }]),
        escaped,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-boundary' }));
  });

  it('validates bounds and provider-supported attributes', () => {
    const cases: Array<[ReachDeckSpeechMarkupV1, string]> = [
      [markup([{ type: 'break', at: 1, durationMs: 0 }]), '正文'],
      [markup([{ type: 'break', at: 3, durationMs: 100 }]), '正文'],
      [markup([{ type: 'say-as', from: 0, to: 1, interpretAs: 'Characters' as never }]), '正文'],
      [markup([{ type: 'sub', from: 0, to: 1, alias: ' ' }]), '正文'],
      [markup([{ type: 'phoneme', from: 0, to: 2, alphabet: 'py', ph: 'zhong1' }]), 'A中'],
      [markup([{ type: 'phoneme', from: 0, to: 2, alphabet: 'cmu', ph: 'HH AH0' }]), '中文'],
      [markup([{ type: 'phoneme', from: 0, to: 5, alphabet: 'ipa', ph: '' }]), 'hello'],
    ];
    for (const [candidate, markdown] of cases) {
      expect(() => parseReachDeckSpeechMarkupV1(candidate, markdown)).toThrowError(
        ReachDeckSpeechMarkupError,
      );
    }
  });

  it('rejects XML controls and unpaired Unicode instead of emitting malformed XML', () => {
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        markup([{ type: 'break', at: 1, durationMs: 100 }]),
        '甲\u0001乙',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-unicode' }));
    expect(() =>
      parseReachDeckSpeechMarkupV1(
        markup([{ type: 'break', at: 1, durationMs: 100 }]),
        '甲\ud800乙',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-unicode' }));
  });
});

describe('Reach Deck spoken projection and alignment map', () => {
  it('rejects visible projection ranges beyond the full canonical source', () => {
    const projection = projectReachDeckSpeechDocument('正文', undefined);

    expect(() => projectReachDeckSpeechVisibleRange(projection, { from: 0, to: 3 })).toThrowError(
      expect.objectContaining({ code: 'invalid-range' }),
    );
  });

  it('projects sub aliases while preserving visible source and atomic mark mapping', () => {
    const markdown = normalizeReachDeckNarrationMarkdown('A-B SSML 中文');
    const speechMarkup = markup([
      { type: 'break', at: 0, durationMs: 100 },
      { type: 'sub', ...rangeOf(markdown, 'SSML'), alias: '语音标记' },
      { type: 'phoneme', ...rangeOf(markdown, '中文'), alphabet: 'py', ph: 'zhong1 wen2' },
    ]);
    const projected = projectReachDeckSpeechMarkup(markdown, speechMarkup);

    expect(markdown).toBe('A\\-B SSML 中文');
    expect(projected.visibleText).toBe('A-B SSML 中文');
    expect(projected.alignmentTranscript).toBe('A-B 语音标记 中文');
    expect(projected.alignmentMap).toContainEqual({
      kind: 'break',
      markdownFrom: 0,
      markdownTo: 0,
      spokenFrom: 0,
      spokenTo: 0,
      atomic: true,
    });
    expect(projected.alignmentMap).toContainEqual({
      kind: 'sub',
      markdownFrom: markdown.indexOf('SSML'),
      markdownTo: markdown.indexOf('SSML') + 4,
      spokenFrom: 4,
      spokenTo: 8,
      atomic: true,
    });
    expect(projected.alignmentMap.at(-1)).toMatchObject({
      kind: 'phoneme',
      markdownFrom: markdown.indexOf('中文'),
      markdownTo: markdown.length,
      atomic: true,
    });
  });

  it('marks formulas and pronunciation spans as the only forbidden range interiors', () => {
    const markdown = '甲乙 \\(x+y\\) 丙丁';
    const speechMarkup = markup([{ type: 'say-as', from: 0, to: 2, interpretAs: 'Spell' }]);
    const boundaries = reachDeckSpeechMarkupLegalBoundaries(markdown, speechMarkup);
    expect(boundaries).toContain(0);
    expect(boundaries).toContain(2);
    expect(boundaries).not.toContain(1);
    expect(boundaries).not.toContain(markdown.indexOf('x'));
    expect(boundaries).toContain(markdown.indexOf('\\('));
    expect(boundaries).toContain(markdown.indexOf('\\)') + 2);
  });
});

describe('Reach Deck SSML chunk planning', () => {
  it('preserves the 79-unit five-break fixture boundaries and alignment while removing provider newlines', () => {
    const markdown =
      '在正式学习课文之前，我们先来探讨一个千年难题：成功究竟更依赖天赋还是勤奋？\n\n古往今来，这个问题一直存在两种截然不同的观点。天赋派认为，与生俱来的"巧"才是关键，';
    const speechMarkup = markup([
      { type: 'break', at: 10, durationMs: 300 },
      { type: 'break', at: 23, durationMs: 1000 },
      { type: 'break', at: 37, durationMs: 2000 },
      { type: 'break', at: 62, durationMs: 500 },
      { type: 'break', at: 68, durationMs: 300 },
    ]);
    const chunks = planReachDeckSsmlChunks(markdown, speechMarkup);

    expect(analyzeReachDeckNarrationMarkdown(markdown).semanticUnits).toBe(79);
    expect(chunks.map((chunk) => [...chunk.ssml].length)).toEqual([119, 99]);
    expect(chunks.map((chunk) => [chunk.markdownFrom, chunk.markdownTo])).toEqual([
      [0, 39],
      [39, 81],
    ]);
    expect(chunks.every((chunk) => !/[\r\n]/u.test(chunk.ssml))).toBe(true);
    expect(chunks[0]?.ssml).toMatch(/<break time="2000ms"\/>  <\/speak>$/u);
    expect(chunks.flatMap((chunk) => chunk.ssml.match(/<break[^>]+\/>/gu) ?? [])).toEqual([
      '<break time="300ms"/>',
      '<break time="1000ms"/>',
      '<break time="2000ms"/>',
      '<break time="500ms"/>',
      '<break time="300ms"/>',
    ]);
    expect(chunks.map((chunk) => chunk.alignmentTranscript)).toEqual([
      markdown.slice(0, 39),
      markdown.slice(39),
    ]);
    const expectedMaps = [
      [
        {
          kind: 'text',
          markdownFrom: 0,
          markdownTo: 10,
          spokenFrom: 0,
          spokenTo: 10,
          atomic: false,
        },
        {
          kind: 'break',
          markdownFrom: 10,
          markdownTo: 10,
          spokenFrom: 10,
          spokenTo: 10,
          atomic: true,
        },
        {
          kind: 'text',
          markdownFrom: 10,
          markdownTo: 23,
          spokenFrom: 10,
          spokenTo: 23,
          atomic: false,
        },
        {
          kind: 'break',
          markdownFrom: 23,
          markdownTo: 23,
          spokenFrom: 23,
          spokenTo: 23,
          atomic: true,
        },
        {
          kind: 'text',
          markdownFrom: 23,
          markdownTo: 37,
          spokenFrom: 23,
          spokenTo: 37,
          atomic: false,
        },
        {
          kind: 'break',
          markdownFrom: 37,
          markdownTo: 37,
          spokenFrom: 37,
          spokenTo: 37,
          atomic: true,
        },
        {
          kind: 'text',
          markdownFrom: 37,
          markdownTo: 39,
          spokenFrom: 37,
          spokenTo: 39,
          atomic: false,
        },
      ],
      [
        {
          kind: 'text',
          markdownFrom: 39,
          markdownTo: 62,
          spokenFrom: 0,
          spokenTo: 23,
          atomic: false,
        },
        {
          kind: 'break',
          markdownFrom: 62,
          markdownTo: 62,
          spokenFrom: 23,
          spokenTo: 23,
          atomic: true,
        },
        {
          kind: 'text',
          markdownFrom: 62,
          markdownTo: 68,
          spokenFrom: 23,
          spokenTo: 29,
          atomic: false,
        },
        {
          kind: 'break',
          markdownFrom: 68,
          markdownTo: 68,
          spokenFrom: 29,
          spokenTo: 29,
          atomic: true,
        },
        {
          kind: 'text',
          markdownFrom: 68,
          markdownTo: 81,
          spokenFrom: 29,
          spokenTo: 42,
          atomic: false,
        },
      ],
    ];
    expect(chunks.map((chunk) => chunk.alignmentMap)).toEqual(expectedMaps);
    expect(projectReachDeckSpeechMarkup(markdown, speechMarkup)).toMatchObject({
      visibleText: markdown,
      alignmentTranscript: markdown,
    });
    expect(planReachDeckSsmlSelectionChunks(markdown, speechMarkup, { from: 0, to: 39 })).toEqual([
      chunks[0],
    ]);
    expect(
      planReachDeckSsmlChunks(`${markdown}天赋决定了一个人能够攀登的高度。`, speechMarkup)[0],
    ).toEqual(chunks[0]);
  });

  it.each([
    ['paragraph', 'Hello\n\nworld', 'Hello\n\nworld', '<speak>Hello  world</speak>'],
    ['hard break', 'Hello\nworld', 'Hello\nworld', '<speak>Hello world</speak>'],
  ])(
    'keeps English words separated across a %s without changing alignment',
    (_name, markdown, visible, ssml) => {
      expect(normalizeReachDeckNarrationMarkdown(markdown)).toBe(markdown);
      expect(serializeReachDeckSpeechMarkupToSsml(markdown)).toBe(ssml);
      expect(projectReachDeckSpeechMarkup(markdown)).toMatchObject({
        visibleText: visible,
        alignmentTranscript: visible,
      });
      expect(
        planReachDeckSsmlSelectionChunks(markdown, undefined, { from: 0, to: markdown.length })[0],
      ).toMatchObject({
        ssml,
        markdownFrom: 0,
        markdownTo: markdown.length,
        alignmentTranscript: visible,
      });
    },
  );

  it.each(['\r\n', '\r'])('normalizes %j before applying speech offsets', (newline) => {
    const source = `Hello${newline}world`;
    const canonical = normalizeReachDeckNarrationMarkdown(source);
    expect(canonical).toBe('Hello\nworld');
    expect(() => serializeReachDeckSpeechMarkupToSsml(source)).toThrowError(
      expect.objectContaining({ code: 'invalid-range' }),
    );
    expect(serializeReachDeckSpeechMarkupToSsml(canonical)).toBe('<speak>Hello world</speak>');
  });

  it('keeps multiline block formulas atomic and preserves formula alignment', () => {
    const markdown = '\\[a\n+b\\]';
    expect(normalizeReachDeckNarrationMarkdown(markdown)).toBe(markdown);
    expect(planReachDeckSsmlChunks(markdown)).toEqual([
      {
        index: 0,
        markdownFrom: 0,
        markdownTo: markdown.length,
        ssml: '<speak>\\[a +b\\]</speak>',
        alignmentTranscript: markdown,
        alignmentMap: [
          {
            kind: 'formula',
            markdownFrom: 0,
            markdownTo: markdown.length,
            spokenFrom: 0,
            spokenTo: markdown.length,
            atomic: true,
          },
        ],
      },
    ]);
    expect(() => planReachDeckSsmlChunks(markdown, undefined, 22)).toThrowError(
      expect.objectContaining({ code: 'chunk-unit-limit' }),
    );
  });

  it('preserves legal attribute whitespace and XML escaping independently of text whitespace', () => {
    const markdown = 'API\n\nnext';
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      ...markup([{ type: 'sub', from: 0, to: 3, alias: 'A\nB & "C"' }]),
      speak: { bgm: 'https://example.com/a\nb?x=1&y=2' },
    };
    expect(serializeReachDeckSpeechMarkupToSsml(markdown, speechMarkup)).toBe(
      '<speak bgm="https://example.com/a\nb?x=1&amp;y=2"><sub alias="A\nB &amp; &quot;C&quot;">API</sub>  next</speak>',
    );
    expect(projectReachDeckSpeechMarkup(markdown, speechMarkup).alignmentTranscript).toBe(
      'A\nB & "C"\n\nnext',
    );
  });

  it.each<ReachDeckSpeechMarkV1>([
    { type: 'sub', from: 0, to: 3, alias: 'alias' },
    { type: 'say-as', from: 0, to: 3, interpretAs: 'Cardinal' },
    { type: 'phoneme', from: 0, to: 3, alphabet: 'py', ph: 'jia3 yi3' },
  ])('continues rejecting $type spans across hard breaks', (mark) => {
    expect(() => serializeReachDeckSpeechMarkupToSsml('甲\n乙', markup([mark]))).toThrowError(
      expect.objectContaining({
        code: mark.type === 'phoneme' ? 'invalid-attribute' : 'invalid-range',
      }),
    );
  });

  it('keeps 80 editor units together and splits the 81st without losing source offsets', () => {
    expect(REACH_DECK_SSML_MAX_SEMANTIC_UNITS).toBe(80);
    expect(planReachDeckSsmlChunks('甲'.repeat(80))).toHaveLength(1);
    const markdown = '甲'.repeat(81);
    const chunks = planReachDeckSsmlChunks(markdown);

    expect(chunks.map((chunk) => chunk.alignmentTranscript.length)).toEqual([80, 1]);
    expect(
      chunks.map(({ index, markdownFrom, markdownTo }) => ({ index, markdownFrom, markdownTo })),
    ).toEqual([
      { index: 0, markdownFrom: 0, markdownTo: 80 },
      { index: 1, markdownFrom: 80, markdownTo: 81 },
    ]);
    expect(chunks.flatMap((chunk) => chunk.alignmentMap)).toEqual([
      { kind: 'text', markdownFrom: 0, markdownTo: 80, spokenFrom: 0, spokenTo: 80, atomic: false },
      { kind: 'text', markdownFrom: 80, markdownTo: 81, spokenFrom: 0, spokenTo: 1, atomic: false },
    ]);
  });

  it.each([
    ['Latin and digit tokens with whitespace', `${'甲'.repeat(78)} alphabet123 987654321`],
    ['formula', `${'甲'.repeat(79)}\\(x+y+123\\)`],
    ['emoji grapheme', `${'甲'.repeat(79)}👩‍🔬`],
    ['combining marks across text units', `${'甲'.repeat(79)}e\u0301`],
    ['punctuation', `${'甲'.repeat(79)}。`],
  ])('uses editor semantic counting for %s', (_name, markdown) => {
    expect(planReachDeckSsmlChunks(markdown)).toHaveLength(1);
    const chunks = planReachDeckSsmlChunks(`${markdown}乙`);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(`${markdown}乙`);
  });

  it('preserves Latin/digit tokens across marks and ignores pauses in semantic counting', () => {
    const markdown = `${'甲'.repeat(79)}ABC123`;
    const speechMarkup = markup([
      { type: 'sub', from: 80, to: 81, alias: 'B' },
      { type: 'break', at: 82, durationMs: 1 },
    ]);
    const [chunk] = planReachDeckSsmlChunks(markdown, speechMarkup);

    expect(planReachDeckSsmlChunks(markdown, speechMarkup)).toHaveLength(1);
    expect(chunk?.alignmentTranscript).toBe(markdown);
    expect(planReachDeckSsmlChunks(`${markdown}乙`, speechMarkup)).toHaveLength(2);
  });

  it('keeps phoneme markup that exceeds 80 XML characters but contains four editor units', () => {
    const markdown = '重庆银行';
    const speechMarkup = markup([
      { type: 'phoneme', from: 0, to: 4, alphabet: 'py', ph: 'chong2 qing4 yin2 hang2' },
    ]);
    const [chunk] = planReachDeckSsmlChunks(markdown, speechMarkup);

    expect(planReachDeckSsmlChunks(markdown, speechMarkup)).toHaveLength(1);
    expect([...chunk!.ssml]).toHaveLength(81);
    expect(chunk?.alignmentTranscript).toBe(markdown);
  });

  it('rejects indivisible 81-unit visible text even when the XML envelope fits', () => {
    for (const count of [80, 81]) {
      const markdown = '甲'.repeat(count);
      const speechMarkup = markup([{ type: 'sub', from: 0, to: count, alias: '简称' }]);
      expect([...serializeReachDeckSpeechMarkupToSsml(markdown, speechMarkup)].length).toBeLessThan(
        150,
      );
      if (count === 80) {
        expect(planReachDeckSsmlChunks(markdown, speechMarkup)).toHaveLength(1);
      } else {
        expect(() => planReachDeckSsmlChunks(markdown, speechMarkup)).toThrowError(
          expect.objectContaining({ code: 'chunk-unit-limit' }),
        );
      }
    }
  });

  it('also limits substituted spoken text to 80 semantic units', () => {
    const accepted = markup([{ type: 'sub', from: 0, to: 1, alias: '乙'.repeat(80) }]);
    const rejected = markup([{ type: 'sub', from: 0, to: 1, alias: '乙'.repeat(81) }]);
    expect(planReachDeckSsmlChunks('甲', accepted)[0]?.alignmentTranscript).toBe('乙'.repeat(80));
    expect([...serializeReachDeckSpeechMarkupToSsml('甲', rejected)].length).toBeLessThan(150);
    expect(() => planReachDeckSsmlChunks('甲', rejected)).toThrowError(
      expect.objectContaining({ code: 'chunk-unit-limit' }),
    );

    const markdown = `${'甲'.repeat(40)}X`;
    const chunks = planReachDeckSsmlChunks(
      markdown,
      markup([{ type: 'sub', from: 40, to: 41, alias: '乙'.repeat(41) }]),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.alignmentTranscript.length <= 80)).toBe(true);
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(
      `${'甲'.repeat(40)}${'乙'.repeat(41)}`,
    );
  });

  it('applies the same semantic limit to selection previews with global source offsets', () => {
    const markdown = `前文${'甲'.repeat(81)}后文`;
    const chunks = planReachDeckSsmlSelectionChunks(markdown, undefined, { from: 2, to: 83 });

    expect(chunks.map((chunk) => chunk.alignmentTranscript.length)).toEqual([80, 1]);
    expect(chunks.map((chunk) => [chunk.markdownFrom, chunk.markdownTo])).toEqual([
      [2, 82],
      [82, 83],
    ]);
    expect(() =>
      planReachDeckSsmlSelectionChunks(
        '前甲后',
        markup([{ type: 'sub', from: 1, to: 2, alias: '乙'.repeat(81) }]),
        { from: 1, to: 2 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'chunk-unit-limit' }));
  });

  it('plans a mid-line ordered-list-looking selection in its full Markdown context', () => {
    const markdown = '第一步 2. 加热样品';
    const from = markdown.indexOf('2. ');

    expect(
      planReachDeckSsmlSelectionChunks(markdown, undefined, { from, to: markdown.length }),
    ).toEqual([
      expect.objectContaining({
        markdownFrom: from,
        markdownTo: markdown.length,
        ssml: '<speak>2. 加热样品</speak>',
        alignmentTranscript: '2. 加热样品',
      }),
    ]);
  });

  it('keeps selection boundaries atomic and alignment free of serialized SSML', () => {
    const markdown = normalizeReachDeckNarrationMarkdown('前文 A < B SSML \\(x+y\\) 后文');
    const selected = rangeOf(markdown, 'A \\< B SSML \\(x+y\\)');
    const marked = rangeOf(markdown, 'SSML');
    const speechMarkup = markup([{ type: 'sub', ...marked, alias: '语音标记' }]);
    const [chunk] = planReachDeckSsmlSelectionChunks(markdown, speechMarkup, selected);

    expect(chunk).toMatchObject({
      ssml: '<speak>A &lt; B <sub alias="语音标记">SSML</sub> \\(x+y\\)</speak>',
      alignmentTranscript: 'A < B 语音标记 \\(x+y\\)',
    });
    expect(chunk?.alignmentTranscript).not.toMatch(/<\/?(?:speak|sub)\b/u);
    expect(() =>
      planReachDeckSsmlSelectionChunks(markdown, speechMarkup, {
        from: marked.from + 1,
        to: marked.to,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-boundary' }));
    expect(() =>
      planReachDeckSsmlSelectionChunks(markdown, speechMarkup, {
        from: markdown.indexOf('\\<') + 1,
        to: marked.from,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-boundary' }));
    const formulaFrom = markdown.indexOf('\\(');
    expect(() =>
      planReachDeckSsmlSelectionChunks(markdown, speechMarkup, {
        from: formulaFrom + 2,
        to: markdown.indexOf('\\)'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-boundary' }));
    expect(() =>
      planReachDeckSsmlSelectionChunks('安全选区 <speak>非法全文</speak>', undefined, {
        from: 0,
        to: 4,
      }),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-markdown' }));
  });

  it.each([
    {
      name: 'paragraph and line boundaries',
      markdown: '第一段第一行\n第一段第二行\n\n第二段第一行\n第二段第二行',
      expectedBoundary: /\n$/u,
      limit: 26,
    },
    {
      name: 'Chinese and English sentence endings',
      markdown: '第一句话结束。第二句话也结束。Third sentence ends. Fourth sentence ends.',
      expectedBoundary: /(?:。|\.)$/u,
      limit: 39,
    },
    {
      name: 'Latin word whitespace',
      markdown: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda',
      expectedBoundary: /\s$/u,
      limit: 35,
    },
  ])('prefers the nearest soft boundary for $name', ({ markdown, expectedBoundary, limit }) => {
    const canonical = normalizeReachDeckNarrationMarkdown(markdown);
    const chunks = planReachDeckSsmlChunks(canonical, undefined, limit);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.alignmentTranscript).toMatch(expectedBoundary);
    }
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(
      projectReachDeckSpeechMarkup(canonical).alignmentTranscript,
    );
  });

  it('prefers a sentence end over the edge of a mid-sentence reading', () => {
    // 序数词读法是原子单元，但它两侧只是句中位置；旧规则切在它旁边，「It’s on」与「second」
    // 分开合成，语调重置。窗口内有句末时应切在句末。
    const markdown =
      '先看教材原句里的日期写法。It’s on 2nd August, and that is the answer. 这句话的意思是它在八月二日。';
    const from = markdown.indexOf('2nd');
    for (const limit of [40, 50, 60]) {
      const transcripts = planReachDeckSsmlChunks(markdown, undefined, limit, {
        formulaReadings: [{ from, to: from + 3, reading: 'second' }],
      }).map((chunk) => chunk.alignmentTranscript);
      expect(transcripts[0]).toBe('先看教材原句里的日期写法。');
      expect(transcripts[1]).toMatch(/^It’s on second August, /u);
    }
  });

  it('keeps a closing quote with the sentence it ends', () => {
    // 第 9 页真实讲稿：旧规则切在句号与右引号之间，下一块以孤立的「”」开头。
    const markdown =
      '原文说：“We celebrate William Shakespeare’s birthday, as English Language Day.” 这里的关键信息是它的生日。';
    const transcripts = planReachDeckSsmlChunks(markdown, undefined, 100).map(
      (chunk) => chunk.alignmentTranscript,
    );
    expect(transcripts.length).toBeGreaterThan(1);
    expect(transcripts[0]).toMatch(/Day\.”$/u);
    expect(transcripts.slice(1).every((value) => !value.startsWith('”'))).toBe(true);
  });

  it('treats a full stop followed directly by Han as a sentence end', () => {
    // 中文讲稿常在英文句号后直接接汉字；旧规则把汉字当作缩写或小数的延续，切到「twelfth of」后面。
    const markdown =
      '原文说：We celebrate International Nurses Day on the 12th of May.这里解释日期前要用 on，日期中的日用序数词。';
    const from = markdown.indexOf('12th');
    const transcripts = planReachDeckSsmlChunks(markdown, undefined, 80, {
      formulaReadings: [{ from, to: from + 4, reading: 'twelfth' }],
    }).map((chunk) => chunk.alignmentTranscript);
    expect(transcripts[0]).toBe(
      '原文说：We celebrate International Nurses Day on the twelfth of May.',
    );
  });

  it('never treats a decimal point as a sentence end', () => {
    const markdown = `${'甲'.repeat(20)}质量约 2.5 千克${'乙'.repeat(30)}`;
    const chunks = planReachDeckSsmlChunks(markdown, undefined, 60);
    expect(chunks.some((chunk) => chunk.alignmentTranscript.includes('2.5'))).toBe(true);
  });

  it('hard-splits ordinary text only when the fitting window has no soft boundary', () => {
    const markdown = 'supercalifragilisticexpialidocious';
    const chunks = planReachDeckSsmlChunks(markdown, undefined, 25);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(markdown);
    expect(chunks.every((chunk) => [...chunk.ssml].length <= 25)).toBe(true);
  });

  it('emits deterministic <=150-character documents without splitting marks or formulas', () => {
    const formula = `\\(${`x`.repeat(50)}\\)`;
    const markdown = `${'前文。'.repeat(20)}SSML${formula}${'后文。'.repeat(20)}`;
    const speechMarkup = markup([
      { type: 'sub', ...rangeOf(markdown, 'SSML'), alias: '语音标记' },
      { type: 'break', at: markdown.indexOf(formula), durationMs: 200 },
    ]);
    const chunks = planReachDeckSsmlChunks(markdown, speechMarkup);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => [...chunk.ssml].length <= REACH_DECK_SSML_MAX_CHARACTERS)).toBe(
      true,
    );
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(
      projectReachDeckSpeechMarkup(markdown, speechMarkup).alignmentTranscript,
    );
    expect(
      chunks.flatMap((chunk) => chunk.alignmentMap).filter((entry) => entry.kind === 'sub'),
    ).toHaveLength(1);
    expect(
      chunks.flatMap((chunk) => chunk.alignmentMap).filter((entry) => entry.kind === 'formula'),
    ).toHaveLength(1);
  });

  it('counts and preserves speak attributes in every full-document and selection chunk', () => {
    const markdown = '甲'.repeat(300);
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [],
      speak: {
        bgm: 'https://cdn.example.com/music.mp3',
        backgroundMusicVolume: 25,
        effect: 'office_ambiance',
      },
    };
    const fullDocument = planReachDeckSsmlChunks(markdown, speechMarkup);
    const selection = planReachDeckSsmlSelectionChunks(markdown, speechMarkup, {
      from: 20,
      to: 280,
    });

    for (const chunks of [fullDocument, selection]) {
      expect(chunks.length).toBeGreaterThan(1);
      expect(
        chunks.every(
          (chunk) =>
            [...chunk.ssml].length <= REACH_DECK_SSML_MAX_CHARACTERS &&
            chunk.ssml.startsWith(
              '<speak bgm="https://cdn.example.com/music.mp3" backgroundMusicVolume="25" effect="office_ambiance">',
            ),
        ),
      ).toBe(true);
    }
    expect(fullDocument.map((chunk) => chunk.alignmentTranscript).join('')).toBe(markdown);
    expect(selection.map((chunk) => chunk.alignmentTranscript).join('')).toBe(
      markdown.slice(20, 280),
    );
  });

  it('rejects an indivisible span or formula that cannot fit one envelope', () => {
    const longSpan = '甲'.repeat(130);
    expect(() =>
      planReachDeckSsmlChunks(
        longSpan,
        markup([{ type: 'sub', from: 0, to: longSpan.length, alias: '简称' }]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'chunk-unit-limit' }));

    const longFormula = `\\(${'x'.repeat(135)}\\)`;
    expect(() => planReachDeckSsmlChunks(longFormula)).toThrowError(
      expect.objectContaining({ code: 'chunk-unit-limit' }),
    );
  });

  it('never emits a break-only alignment chunk at the character boundary', () => {
    const markdown = '甲'.repeat(130);
    const chunks = planReachDeckSsmlChunks(
      markdown,
      markup([{ type: 'break', at: markdown.length, durationMs: 200 }]),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.alignmentTranscript.trim().length > 0)).toBe(true);
    expect(chunks.map((chunk) => chunk.alignmentTranscript).join('')).toBe(markdown);
    expect(chunks.at(-1)?.ssml).toContain('<break time="200ms"/>');
  });

  it('rejects a leading break that cannot share a chunk with its indivisible span', () => {
    const markdown = '甲'.repeat(110);

    expect(() =>
      planReachDeckSsmlChunks(
        markdown,
        markup([
          { type: 'break', at: 0, durationMs: 200 },
          { type: 'sub', from: 0, to: markdown.length, alias: '简称' },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'chunk-unit-limit' }));
  });
});

describe('native narration and digest compatibility', () => {
  it('keeps the no-mark digest input byte-compatible and changes identity for mark semantics', () => {
    const markdown = '测试 SSML';
    expect(reachDeckNarrationSpeechContentDigestInput(markdown)).toBe(
      reachDeckNarrationContentDigestInput(markdown),
    );
    expect(
      reachDeckNarrationSpeechContentDigestInput(
        markdown,
        markup([{ type: 'sub', ...rangeOf(markdown, 'SSML'), alias: '语音标记' }]),
      ),
    ).not.toBe(reachDeckNarrationContentDigestInput(markdown));
  });

  it('accepts old narration and strictly validates optional speechMarkup on native slides', () => {
    expect(parseReachDeckNativeSlideV2(nativeSlide({ markdown: '旧讲稿' }))).toBeTruthy();
    const speechMarkup = markup([{ type: 'break', at: 1, durationMs: 100 }]);
    expect(
      parseReachDeckNativeSlideV2(nativeSlide({ markdown: '新讲稿', speechMarkup })),
    ).toBeTruthy();
    expect(() =>
      parseReachDeckNativeSlideV2(
        nativeSlide({
          segments: [{ text: '旧讲稿' }],
          speechMarkup,
        } as never),
      ),
    ).toThrow(/requires authoritative markdown/u);
  });

  it('preserves structured sound events and speak settings in strict native narration', () => {
    const markdown = '新讲稿';
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [{ type: 'soundEvent', at: 1, src: 'https://cdn.example.com/chime.mp3' }],
      speak: {
        bgm: 'https://cdn.example.com/music.mp3',
        backgroundMusicVolume: 20,
        effect: 'speech_dialogue',
      },
    };

    expect(
      parseReachDeckNativeSlideV2(nativeSlide({ markdown, speechMarkup })).narration,
    ).toMatchObject({ markdown, speechMarkup });
    expect(reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup)).not.toBe(
      reachDeckNarrationContentDigestInput(markdown),
    );
  });

  it('preserves marks through invalidation and generation without sharing mutable mark objects', () => {
    const markdown = '新讲稿';
    const speechMarkup = markup([{ type: 'break', at: 1, durationMs: 100 }]);
    const invalidated = invalidateReachDeckNativeSlideNarration(
      nativeSlide({ markdown: '旧讲稿' }),
      markdown,
      speechMarkup,
    );
    expect(invalidated.narration).toEqual({ markdown, speechMarkup });
    expect(invalidated.narration?.speechMarkup).not.toBe(speechMarkup);

    const generated = applyReachDeckNarrationToNativeSlide(invalidated, {
      segments: [{ text: markdown, start: 0, end: 1 }],
      audioResourceId: 'audio-1',
      duration: 2,
    }).slide;
    expect(generated.narration?.speechMarkup).toEqual(speechMarkup);
    expect(() => parseReachDeckNativeSlideV2(generated)).not.toThrow();
  });
});
