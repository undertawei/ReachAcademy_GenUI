import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createGeometryPlayerHarnessFixture } from './geometry-player-fixtures.js';

import {
  buildReachDeckMediaResourceForObjectKey,
  parseReachDeckDocumentV2,
  parseReachFunctionPlotSpecValue,
  richTextFromPlainText,
  type ReachDeckDocumentV2,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

export type ReachDeckPlayerHarnessFixtureKind = 'scientific' | 'mixed' | 'geometry';
/** Short alias used by the CLI boundary. */
export type PlayerHarnessFixtureKind = ReachDeckPlayerHarnessFixtureKind;

export interface PlayerHarnessDeclaredAsset {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface ReachDeckPlayerHarnessFixture {
  document: ReachDeckDocumentV2;
  /**
   * Exact bytes behind every fixture-owned media resource. A preview server can use this map both
   * to serve media and to verify byte size, MIME type and SHA-256 before exposing a resource URL.
   */
  assetsByResourceId: Map<string, PlayerHarnessDeclaredAsset>;
}

export const PLAYER_HARNESS_PREVIEW_ANIMATION_ID_PREFIX = 'harness-preview:';

export interface UniformPlayerHarnessTimingEvidence {
  mode: 'uniform-preview';
  /** Uniform preview windows exercise Player behavior; they are not evidence of TTS alignment. */
  validatesTtsAlignment: false;
  secondsPerSegment: number;
  slides: Array<{
    pageId: string;
    durationSeconds: number;
    segmentCount: number;
    animationIds: string[];
  }>;
}

export interface UniformPlayerHarnessTimingResult {
  document: ReachDeckDocumentV2;
  evidence: UniformPlayerHarnessTimingEvidence;
}

const FIXTURE_GENERATED_AT = '2026-08-24T00:00:00.000Z';
const PREVIEW_SEGMENT_COUNT = 3;
const PREVIEW_SECONDS_PER_SEGMENT = 3;
const REFERENCE_OBJECT_KEY = 'harness/reach-deck/scientific/oscillation-reference.png';

const THEME = {
  name: 'Reach Harness',
  background: '#f8fafc',
  surface: '#ffffff',
  ink: '#172024',
  muted: '#647178',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
  fontDisplay: 'Inter',
  fontBody: 'Inter',
} as const;

const themeResources = () => ({
  themes: [
    {
      id: 'harness-theme',
      name: THEME.name,
      colors: {
        background: THEME.background,
        surface: THEME.surface,
        ink: THEME.ink,
        muted: THEME.muted,
        accent: THEME.accent,
        success: THEME.success,
        warning: THEME.warning,
      },
      fonts: { display: THEME.fontDisplay, body: THEME.fontBody },
    },
  ],
  masters: [],
  layouts: [],
});

const textFrame = (text: string) => ({
  margins: { left: 12, top: 8, right: 12, bottom: 8 },
  verticalAlignment: 'middle' as const,
  wrap: true,
  autofit: { mode: 'shrink-text' as const, fontScale: 1, lineSpacingReduction: 0 },
  doc: richTextFromPlainText(text),
  fontSubstitutions: [],
});

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typeBytes = Buffer.from(type, 'ascii');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBytes, data]))
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
};

const rasterPng = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): Uint8Array => {
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      scanlines[row + 1 + x * 3] = red;
      scanlines[row + 2 + x * 3] = green;
      scanlines[row + 3 + x * 3] = blue;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(scanlines)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
};

const referenceDot = (): Uint8Array =>
  rasterPng(32, 32, (x, y) =>
    Math.hypot(x - 15.5, y - 15.5) <= 11 ? [239, 68, 68] : [255, 255, 255],
  );

const buildDeclaredRasterAsset = (
  fileName: string,
  bytes: Uint8Array,
): PlayerHarnessDeclaredAsset => {
  return {
    bytes,
    contentType: 'image/png',
    fileName,
    sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

const functionPlotSpec = parseReachFunctionPlotSpecValue({
  schemaVersion: 'reach-function-plot/v1',
  ariaLabel: '简谐振动位移随相位变化的函数图',
  viewport: { x: [-6.28, 6.28], y: [-1.5, 1.5] },
  axes: { grid: true, xLabel: 'x', yLabel: '位移' },
  series: [
    {
      id: 'oscillation',
      expression: 'sin(x + phase)',
      colorToken: 'accent',
    },
  ],
  parameters: [
    {
      id: 'phase',
      label: '相位',
      minimum: 0,
      maximum: 6.28,
      step: 0.01,
      initial: 0,
    },
  ],
  markers: [],
  intersections: [],
});

const scientificDocumentHtml = (referenceResourceId: string): string => `<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; color: #172024; font-family: Inter, sans-serif; }
      [data-reach-scientific-root] { box-sizing: border-box; display: grid; grid-template-rows: 1fr auto; gap: 8px; width: 100%; height: 100%; padding: 12px; background: #ffffff; }
      #plot { min-height: 220px; }
      #status { display: flex; align-items: center; gap: 10px; min-height: 28px; color: #475569; font-size: 14px; }
      #reference { width: 14px; height: 14px; border-radius: 50%; }
    </style>
  </head>
  <body>
    <main data-reach-scientific-root>
      <div id="plot"></div>
      <div id="status"><img id="reference" alt="托管参考媒体"><span id="time"></span><span id="anchors"></span></div>
    </main>
    <script type="application/json" data-reach-function-plot="oscillation-plot">${JSON.stringify(functionPlotSpec)}</script>
    <script>
      ReachScientificVisual.register(({ dependencies, resources }) => {
        const facade = dependencies.get('function-plot');
        const plotController = facade.mount(
          document.getElementById('plot'),
          facade.config('oscillation-plot')
        );
        const time = document.getElementById('time');
        const anchors = document.getElementById('anchors');
        const reference = document.getElementById('reference');
        resources.resolve('${referenceResourceId}').then((url) => { reference.src = url; });
        return {
          present(frame) {
            const normalized = Math.max(0, Math.min(1, frame.currentTime / frame.effectiveDuration));
            plotController.setParameters({ phase: normalized * 6.28 });
            time.textContent = 't=' + frame.currentTime.toFixed(2) + 's';
            anchors.textContent = frame.anchors.map((anchor) => anchor.id + ':' + anchor.state).join(' · ');
            // Harness-only observability. Production generation rejects parent/postMessage access.
            window.parent.postMessage({
              type: 'harness_scientific_present',
              currentTime: frame.currentTime,
              anchors: frame.anchors,
              playing: frame.playing,
              dependencyReady: true
            }, '*');
          },
          resize() {},
          suspend() {},
          resume() {},
          dispose() { plotController.destroy(); }
        };
      });
    </script>
  </body>
</html>`;

const interactiveDocumentHtml = `<!doctype html>
<html>
  <head>
    <style>
      html, body { min-height: 100%; margin: 0; font-family: Inter, sans-serif; background: #eff6ff; color: #172024; }
      main { box-sizing: border-box; display: grid; place-content: center; gap: 18px; min-height: 100vh; padding: 32px; text-align: center; }
      button { border: 0; border-radius: 12px; padding: 14px 20px; color: #ffffff; background: #2563eb; font: inherit; cursor: pointer; }
      output { font-size: 30px; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>学习者互动桥测试</h1>
      <p>点击按钮会提交 parameter_adjusted 学习事件并显式完成活动。</p>
      <output id="value">20</output>
      <button id="adjust-and-complete" type="button">调整参数并完成</button>
    </main>
    <script>
      const output = document.getElementById('value');
      const button = document.getElementById('adjust-and-complete');
      let value = 20;
      button.addEventListener('click', () => {
        value = value >= 80 ? 20 : value + 20;
        output.textContent = String(value);
        ReachInteractive.learningEvent('parameter_adjusted', { value });
        ReachInteractive.complete({ value });
      });
      ReachInteractive.ready();
    </script>
  </body>
</html>`;

const scientificNativeSlide = (referenceResourceId: string): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'harness-scientific-slide',
  title: '简谐振动：Player 驱动的科学可视化',
  background: { kind: 'solid', color: { kind: 'srgb', value: '#f8fafc' } },
  duration: 9,
  elements: [
    {
      id: 'harness-title',
      type: 'textFrame',
      transform: { x: 90, y: 48, width: 1420, height: 94 },
      zIndex: 1,
      text: textFrame('简谐振动：Player playhead → Hook present(frame)'),
      style: { fill: { kind: 'none' } },
    },
    {
      id: 'harness-scientific-visual',
      type: 'scientificVisual',
      transform: { x: 170, y: 170, width: 1260, height: 600 },
      zIndex: 2,
      name: 'Oscillation scientific visual',
      locked: true,
      ariaLabel: '简谐振动位移与相位的动态科学可视化',
      documentHtml: scientificDocumentHtml(referenceResourceId),
      manifest: {
        schemaVersion: 'reach-scientific-visual-manifest/v2',
        hooksVersion: 'reach-scientific-visual-hooks/v1',
        anchors: [
          { id: 'departure', description: '振子从平衡位置出发。' },
          { id: 'turningPoint', description: '振子到达位移极值。' },
          { id: 'return', description: '振子返回平衡位置。' },
        ],
        dependencies: [{ id: 'function-plot', version: '1.25.4' }],
        resourceIds: [referenceResourceId],
        ariaLabel: '简谐振动位移与相位的动态科学可视化',
        textAlternative: '函数图的相位由幻灯片播放时间推进，并依次经过出发、极值和返回锚点。',
      },
    },
    {
      id: 'harness-caption',
      type: 'shape',
      transform: { x: 320, y: 800, width: 960, height: 58 },
      zIndex: 3,
      geometry: { kind: 'preset', preset: 'roundRect' },
      style: {
        fill: { kind: 'solid', color: { kind: 'srgb', value: '#dbeafe' } },
        stroke: { width: 1, fill: { kind: 'srgb', value: '#93c5fd' } },
      },
      text: textFrame('无音频：Player 以匀速时间轴驱动动画和科学 Hook'),
    },
  ],
  animations: [
    {
      id: 'fixture-title-entrance',
      targetId: 'harness-title',
      trigger: 'on-enter',
      effect: 'fade',
      start: 0,
      duration: 0.6,
      easing: 'ease-out',
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
  ],
});

const slidePage = () => ({
  pageId: 'harness-scientific-page',
  order: 1,
  revision: 1,
  sceneType: 'slide' as const,
  title: '简谐振动科学可视化',
});

const interactivePage = () => ({
  pageId: 'harness-interactive-page',
  order: 2,
  revision: 1,
  sceneType: 'interactive' as const,
  title: '互动 Bridge 注入测试',
  scene: {
    schemaVersion: 'reach-interactive-scene/v2' as const,
    id: 'harness-interactive-page',
    title: '互动 Bridge 注入测试',
    sceneType: 'interactive' as const,
    documentHtml: interactiveDocumentHtml,
    bridgeVersion: 'reach-interactive-bridge/v1' as const,
    runtimePolicy: {
      completionMode: 'explicit' as const,
      allowReset: true,
      maximumDurationSeconds: 120,
    },
    eventManifest: {
      schemaVersion: 'reach-interactive-event-manifest/v1' as const,
      events: [
        {
          name: 'parameter_adjusted',
          eventVersion: 1 as const,
          meaning: '学习者调整了演示参数。',
          payloadFields: [
            {
              name: 'value',
              type: 'number' as const,
              required: true,
              minimum: 0,
              maximum: 100,
            },
          ],
          delivery: { mode: 'immediate' as const },
        },
      ],
    },
  },
});

export function createReachDeckPlayerHarnessFixture(
  kind: ReachDeckPlayerHarnessFixtureKind,
): ReachDeckPlayerHarnessFixture {
  if (kind === 'geometry') return createGeometryPlayerHarnessFixture();
  const reference = buildReachDeckMediaResourceForObjectKey(REFERENCE_OBJECT_KEY);
  const pages = kind === 'mixed' ? [slidePage(), interactivePage()] : [slidePage()];
  const document = parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: `reach-deck-player-harness-${kind}`,
    title: kind === 'mixed' ? 'Reach Deck Player 混合场景 Harness' : '科学可视化 Player Harness',
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme: { ...THEME },
    defaultThemeId: 'harness-theme',
    resources: {
      ...themeResources(),
      media: [reference],
    },
    metadata: {
      source: 'editor',
      language: 'zh-CN',
      generatedAt: FIXTURE_GENERATED_AT,
      contentDigest: `harness:${kind}:scientific-player:v1`,
    },
    revisions: [],
    pages,
    nativeSlides: [
      {
        pageId: 'harness-scientific-page',
        slide: scientificNativeSlide(reference.id),
      },
    ],
  });
  return {
    document,
    assetsByResourceId: new Map([
      [reference.id, buildDeclaredRasterAsset('oscillation-reference.png', referenceDot())],
    ]),
  };
}

/**
 * Clone a v2 document with an audio-free, uniformly spaced preview timeline.
 *
 * This deliberately omits audioResourceId and scientificAnchorBindings. The real Player advances
 * from performance time when no narration audio URL exists, while scientific anchors use their
 * production uniform fallback. Scientific visuals remain visible from time zero so their complete
 * internal timeline is observable; other elements receive staged entrance animations. The returned
 * evidence therefore cannot be mistaken for TTS timing acceptance.
 */
export function applyUniformPlayerHarnessTiming(
  input: ReachDeckDocumentV2,
): UniformPlayerHarnessTimingResult {
  const source = parseReachDeckDocumentV2(structuredClone(input));
  const evidenceSlides: UniformPlayerHarnessTimingEvidence['slides'] = [];
  const durationSeconds = PREVIEW_SEGMENT_COUNT * PREVIEW_SECONDS_PER_SEGMENT;
  const nativeSlides = source.nativeSlides.map((binding) => {
    const keptAnimations = binding.slide.animations.filter(
      ({ id }) => !id.startsWith(PLAYER_HARNESS_PREVIEW_ANIMATION_ID_PREFIX),
    );
    const alreadyAnimated = new Set(keptAnimations.map(({ targetId }) => targetId));
    const candidates = binding.slide.elements.filter(
      (element) => element.hidden !== true && !alreadyAnimated.has(element.id),
    );
    const previewAnimations = candidates.map((element, index) => ({
      id: `${PLAYER_HARNESS_PREVIEW_ANIMATION_ID_PREFIX}${binding.pageId}:${element.id}`,
      targetId: element.id,
      trigger: 'on-enter' as const,
      effect: 'fade' as const,
      start:
        element.type === 'scientificVisual'
          ? 0
          : Math.min(index + 1, PREVIEW_SEGMENT_COUNT - 1) * PREVIEW_SECONDS_PER_SEGMENT,
      duration: 0.6,
      easing: 'ease-out' as const,
      from: { opacity: 0 },
      to: { opacity: 1 },
    }));
    const animationIds = previewAnimations.map(({ id }) => id);
    evidenceSlides.push({
      pageId: binding.pageId,
      durationSeconds,
      segmentCount: PREVIEW_SEGMENT_COUNT,
      animationIds,
    });
    return {
      pageId: binding.pageId,
      slide: {
        ...binding.slide,
        duration: durationSeconds,
        animations: [...keptAnimations, ...previewAnimations],
        narration: {
          segments: Array.from({ length: PREVIEW_SEGMENT_COUNT }, (_, index) => ({
            text: `${binding.slide.title} · 匀速预览阶段 ${index + 1}`,
            start: index * PREVIEW_SECONDS_PER_SEGMENT,
            end: (index + 1) * PREVIEW_SECONDS_PER_SEGMENT,
          })),
        },
      },
    };
  });
  const document = parseReachDeckDocumentV2({
    ...source,
    nativeSlides,
  });
  return {
    document,
    evidence: {
      mode: 'uniform-preview',
      validatesTtsAlignment: false,
      secondsPerSegment: PREVIEW_SECONDS_PER_SEGMENT,
      slides: evidenceSlides,
    },
  };
}
