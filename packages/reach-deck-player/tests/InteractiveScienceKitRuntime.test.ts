import { describe, expect, it } from 'vitest';

import { buildInteractiveSrcDoc } from '../src/interactiveBridge.js';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../src/interactiveExternalRuntimes.generated.js';

const envelope = {
  schemaVersion: 'reach-science-kit/v1',
  kitId: 'geometry-board',
  kitVersion: 1,
  spec: {
    schemaVersion: 'reach-geometry-board/v1',
    ariaLabel: 'Triangle construction',
    viewport: { x: [-5, 5], y: [-5, 5], grid: true },
    points: [
      { id: 'A', x: -1, y: 0, draggable: true },
      { id: 'B', x: 1, y: 0, draggable: true },
    ],
    shapes: [{ id: 'AB', kind: 'segment', from: 'A', to: 'B', colorToken: 'accent' }],
    measurements: [],
  },
};
const html = `<!doctype html><html><head></head><body><div data-reach-science-kit-target="main"></div><script type="application/json" data-reach-science-kit="main">${JSON.stringify(envelope)}</script></body></html>`;

describe('Interactive science kit external runtime', () => {
  it('injects the exact content-addressed runtime with SRI and CSP URL', () => {
    const source = buildInteractiveSrcDoc({
      documentHtml: html,
      nonce: '1234567890abcdef',
      allowReset: true,
      eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
      runtimeDependencies: [{ id: 'geometry-mathigon', version: '1.0.0' }],
      dependencyBaseUrl: 'https://student.example/path',
    });
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      ({ id }) => id === 'geometry-mathigon',
    )!;
    expect(source).toContain(`src="https://student.example${entry.scriptPath}"`);
    expect(source).toContain(`integrity="${entry.integrity}"`);
    expect(source).toContain('crossorigin="anonymous"');
    expect(source).toContain(
      `script-src 'unsafe-inline' https://student.example${entry.scriptPath}`,
    );
    expect(source).not.toContain('Point.distance');
    expect(source).toContain("Object.defineProperty(window, 'ReachScienceKits'");
    expect(source).toContain('getState: (instanceId)');
    expect(source).toContain('setState: (instanceId, state)');
  });

  it('rejects missing, unused, and untrusted runtime declarations', () => {
    const base = {
      documentHtml: html,
      nonce: '1234567890abcdef',
      allowReset: true,
      eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
    };
    expect(() => buildInteractiveSrcDoc({ ...base, runtimeDependencies: [] })).toThrow(
      /do not exactly match/,
    );
    expect(() =>
      buildInteractiveSrcDoc({
        ...base,
        runtimeDependencies: [{ id: 'mechanics-matter', version: '1.0.0' }],
      }),
    ).toThrow(/do not exactly match/);
    expect(() =>
      buildInteractiveSrcDoc({
        ...base,
        runtimeDependencies: [{ id: 'geometry-mathigon', version: '1.0.0' }],
        dependencyBaseUrl: 'file:///tmp',
      }),
    ).toThrow(/base URL/);
  });
});
