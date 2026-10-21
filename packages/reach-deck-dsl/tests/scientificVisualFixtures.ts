import { buildReachDeckMediaResourceForObjectKey } from '../src/compileToNativeV2.js';
import type {
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
} from '../src/nativeV2.js';
import type { ReachScientificVisualPayloadV1 } from '../src/scientificVisual.js';
import type { ScientificVisualElement } from '../src/types.js';

export const scientificVisualPayloadFixture = (): ReachScientificVisualPayloadV1 => {
  const data = buildReachDeckMediaResourceForObjectKey('reach-deck/scientific/motion.json');
  return {
    documentHtml:
      '<main id="visual"></main><script>ReachScientificVisual.register({present(){}})</script>',
    manifest: {
      schemaVersion: 'reach-scientific-visual-manifest/v2',
      hooksVersion: 'reach-scientific-visual-hooks/v1',
      anchors: [
        { id: 'launch', description: '物体开始运动' },
        { id: 'arrival', description: '物体到达终点' },
      ],
      dependencies: [{ id: 'functionPlot', version: '1.0.0' }],
      resourceIds: [data.id],
      ariaLabel: '匀速直线运动科学可视化',
      textAlternative: '一个物体沿直线从起点匀速移动到终点。',
    },
    mediaResources: [data],
  };
};

export const scientificVisualElementFixture = (): ScientificVisualElement => ({
  id: 'scientific-motion',
  type: 'scientificVisual',
  frame: { x: 160, y: 180, width: 960, height: 540 },
  layer: 3,
  ariaLabel: '匀速直线运动科学可视化',
  name: 'Motion visual',
  locked: true,
  ...scientificVisualPayloadFixture(),
});

export const scientificNativeElementFixture = (): ReachDeckScientificVisualElementV2 => {
  const payload = scientificVisualPayloadFixture();
  return {
    id: 'scientific-motion',
    type: 'scientificVisual',
    transform: { x: 160, y: 180, width: 960, height: 540 },
    zIndex: 3,
    ariaLabel: payload.manifest.ariaLabel,
    name: 'Motion visual',
    locked: true,
    documentHtml: payload.documentHtml,
    manifest: payload.manifest,
  };
};

export const scientificNativeSlideFixture = (): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'scientific-slide',
  title: '匀速直线运动',
  background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
  elements: [scientificNativeElementFixture()],
  animations: [],
});
