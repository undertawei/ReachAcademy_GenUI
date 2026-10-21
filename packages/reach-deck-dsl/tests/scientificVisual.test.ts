import { describe, expect, it } from 'vitest';

import {
  parseReachScientificVisualPayloadV1,
  REACH_SCIENTIFIC_VISUAL_LIMITS,
} from '../src/scientificVisual.js';
import { scientificVisualPayloadFixture } from './scientificVisualFixtures.js';

describe('scientific visual durable payload', () => {
  it('strictly parses the exact manifest and remains byte-stable', () => {
    const payload = scientificVisualPayloadFixture();
    const parsed = parseReachScientificVisualPayloadV1(payload);
    expect(parsed).toEqual(payload);
    expect(JSON.stringify(parseReachScientificVisualPayloadV1(structuredClone(parsed)))).toBe(
      JSON.stringify(parsed),
    );
    expect(() =>
      parseReachScientificVisualPayloadV1({ ...payload, generatedUrl: 'https://example.test' }),
    ).toThrow(/unsupported fields/i);
  });

  it('enforces unique anchor, dependency, and media identities', () => {
    const payload = scientificVisualPayloadFixture();
    expect(() =>
      parseReachScientificVisualPayloadV1({
        ...payload,
        manifest: {
          ...payload.manifest,
          anchors: [payload.manifest.anchors[0]!, payload.manifest.anchors[0]!],
        },
      }),
    ).toThrow(/anchors ids must be unique/i);
    expect(() =>
      parseReachScientificVisualPayloadV1({
        ...payload,
        manifest: {
          ...payload.manifest,
          dependencies: [payload.manifest.dependencies[0]!, payload.manifest.dependencies[0]!],
        },
      }),
    ).toThrow(/dependencies ids must be unique/i);
    expect(() =>
      parseReachScientificVisualPayloadV1({
        ...payload,
        mediaResources: [payload.mediaResources[0]!, payload.mediaResources[0]!],
      }),
    ).toThrow(/mediaResources ids must be unique/i);
  });

  it('measures generated HTML in UTF-8 bytes', () => {
    const payload = scientificVisualPayloadFixture();
    const oversized = '测'.repeat(
      Math.floor(REACH_SCIENTIFIC_VISUAL_LIMITS.documentHtmlBytes / 3) + 1,
    );
    expect(oversized.length).toBeLessThan(REACH_SCIENTIFIC_VISUAL_LIMITS.documentHtmlBytes);
    expect(() =>
      parseReachScientificVisualPayloadV1({ ...payload, documentHtml: oversized }),
    ).toThrow(/UTF-8 byte limit/i);
  });

  it('rejects unknown and unreferenced resources', () => {
    const payload = scientificVisualPayloadFixture();

    expect(() =>
      parseReachScientificVisualPayloadV1({
        ...payload,
        manifest: { ...payload.manifest, resourceIds: ['missingResource'] },
      }),
    ).toThrow(/unknown media resource/i);
    expect(() =>
      parseReachScientificVisualPayloadV1({
        ...payload,
        manifest: { ...payload.manifest, resourceIds: [] },
      }),
    ).toThrow(/unreferenced media resource/i);
  });
});
