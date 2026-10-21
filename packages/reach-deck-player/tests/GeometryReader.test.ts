import scenarios from '../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json';
import boundaries from '../../reach-deck-dsl/fixtures/euclidean-geometry/boundaries.json';
import { JSDOM } from 'jsdom';
import type { InteractiveRuntimeId } from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT as contract,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import { buildInteractiveSrcDoc, MAX_INTERACTIVE_SRCDOC_BYTES } from '../src/interactiveBridge.js';
import { resolveGeometryMessages } from '../src/geometryMessages.js';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../src/interactiveExternalRuntimes.generated.js';

const fixtures = (file: string): Array<{ id: string; envelope: GeometryEnvelope }> =>
  (file === 'scenarios' ? scenarios : boundaries) as unknown as Array<{
    id: string;
    envelope: GeometryEnvelope;
  }>;
const planar = fixtures('scenarios')[0]!.envelope;
const html = (envelopes: GeometryEnvelope[]) =>
  `<!doctype html><html><head></head><body>${envelopes
    .map(
      (envelope, i) =>
        `<div data-reach-science-kit-target="g${i}"></div><script type="application/json" data-reach-science-kit="g${i}">${JSON.stringify(envelope).replaceAll('<', '\\u003c')}</script>`,
    )
    .join('')}</body></html>`;
const source = (
  envelopes = [planar],
  extra: Partial<Parameters<typeof buildInteractiveSrcDoc>[0]> = {},
) =>
  buildInteractiveSrcDoc({
    documentHtml: html(envelopes),
    nonce: '0123456789abcdef',
    allowReset: true,
    eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
    runtimeDependencies: [...new Set(envelopes.map((e) => contract.kits[e.kitId].runtimeId))].map(
      (id) => ({ id: id as InteractiveRuntimeId, version: '1.0.0' }),
    ),
    dependencyBaseUrl: 'https://student.example',
    ...extra,
  });

describe('geometry Player reader', () => {
  it('provides messages for every contract geometry undefined reason', () => {
    const messages = resolveGeometryMessages();
    for (const reason of contract.geometryUndefinedReasons)
      expect(messages[`reachDeck.geometry.reason.${reason}`]).toBeTruthy();
  });

  it('loads the exact reader assets with existing SRI and sandbox policy', () => {
    const output = source();
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      (e) => e.id === 'geometry-euclidean-2d',
    )!;
    expect(output).toContain(entry.integrity);
    expect(output).toContain(`https://student.example${entry.scriptPath}`);
    expect(output).toContain("worker-src 'none'");
    expect(output).not.toContain('allow-same-origin');
    expect(() => source([planar], { runtimeDependencies: [] })).toThrow(/exactly match/);
  });

  it('exposes cloned immutable computed DTOs and commands only for the matching instance', () => {
    const dom = new JSDOM(source(), { runScripts: 'outside-only', url: 'https://student.example' });
    const applyCommand = vi.fn((_command: unknown) => ({ ok: true, changed: true, revision: 1 }));
    const mount = vi.fn((_target: HTMLElement, _spec: unknown, _context: unknown) => ({
      reset: vi.fn(),
      destroy: vi.fn(),
      getState: () => ({}),
      setState: () => true,
      getComputedState: () => ({ revision: 1, objects: { A: { coordinates: [0, 1] } } }),
      applyCommand,
    }));
    Object.assign(dom.window, {
      structuredClone,
      __reachScienceKitFacades: { 'geometry-euclidean-2d': { mount } },
    });
    dom.window.eval(
      dom.window.document.querySelector('[data-reach-science-kit-install]')!.textContent!,
    );
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const api = (
      dom.window as unknown as {
        ReachScienceKits: {
          getComputedState(id: string): { objects?: { A: { coordinates: number[] } } };
          applyCommand(id: string, value: unknown): unknown;
        };
      }
    ).ReachScienceKits;
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.getComputedState('g0').objects!.A.coordinates)).toBe(true);
    expect(api.getComputedState('unknown')).toEqual({ ok: false, code: 'unsupported' });
    const command = { schemaVersion: 'reach-geometry-command/v1', kind: 'reset' };
    expect(api.applyCommand('g0', command)).toEqual({ ok: true, changed: true, revision: 1 });
    expect(applyCommand.mock.calls[0]![0]).not.toBe(command);
    expect(mount.mock.calls[0]![2]).toMatchObject({ instanceId: 'g0', locale: 'en-US' });
    dom.window.close();
  });

  it('serializes translated messages safely inside the assembled budget', () => {
    const translated = resolveGeometryMessages((key) =>
      key === 'reachDeck.geometry.reset' ? '</script><img src=x onerror=alert(1)>' : key,
    );
    const output = source([planar], { locale: 'zh-CN', geometryMessages: translated });
    const parsed = new DOMParser().parseFromString(output, 'text/html');
    expect(parsed.querySelector('img')).toBeNull();
    expect(parsed.querySelector('[data-reach-science-kit-install]')!.textContent).toContain(
      '\\u003c/script',
    );
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_INTERACTIVE_SRCDOC_BYTES);
  });

  it('attributes mixed-page mount failures to the failing instance and disposes prior mounts', () => {
    const legacy = {
      schemaVersion: 'reach-science-kit/v1',
      kitId: 'geometry-board',
      kitVersion: 1,
      spec: {
        schemaVersion: 'reach-geometry-board/v1',
        ariaLabel: 'Triangle',
        viewport: { x: [-5, 5], y: [-5, 5], grid: true },
        points: [
          { id: 'A', x: 0, y: 0, draggable: true },
          { id: 'B', x: 1, y: 0, draggable: true },
        ],
        shapes: [{ id: 'AB', kind: 'segment', from: 'A', to: 'B', colorToken: 'accent' }],
        measurements: [],
      },
    };
    const documentHtml = html([planar]).replace(
      '</body>',
      `<div data-reach-science-kit-target="old"></div><script type="application/json" data-reach-science-kit="old">${JSON.stringify(legacy)}</script></body>`,
    );
    const output = source([planar], {
      documentHtml,
      runtimeDependencies: [
        { id: 'geometry-euclidean-2d', version: '1.0.0' },
        { id: 'geometry-mathigon', version: '1.0.0' },
      ],
    });
    for (const failingGeometry of [false, true]) {
      const dom = new JSDOM(output, { runScripts: 'outside-only', url: 'https://student.example' });
      Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' });
      const error = vi.fn();
      const destroy = vi.fn();
      const failure = new Error('mount failure');
      Object.assign(dom.window, {
        structuredClone,
        ReachInteractive: { error },
        __reachScienceKitFacades: {
          'geometry-euclidean-2d': {
            mount: () => {
              if (failingGeometry) throw failure;
              return { destroy };
            },
          },
          'geometry-mathigon': {
            mount: () => {
              throw failure;
            },
          },
        },
      });
      const install = () =>
        dom.window.eval(
          dom.window.document.querySelector('[data-reach-science-kit-install]')!.textContent!,
        );
      if (failingGeometry) {
        expect(install).not.toThrow();
        expect(error).toHaveBeenCalledWith({ code: 'geometry_mount_failed' });
      } else {
        expect(install).toThrow(failure);
        expect(error).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
      }
      dom.window.close();
    }
  });

  it('measures four exact 64KiB markers including duplicated envelopes and messages', () => {
    const boundary = fixtures('boundaries').find(
      (f) => f.id === 'numeric-unicode-bytes-65536',
    )!.envelope;
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(65536);
    const output = source(Array(4).fill(boundary));
    expect(Buffer.byteLength(output)).toBeGreaterThan(4 * 65536);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_INTERACTIVE_SRCDOC_BYTES);
    expect(
      new DOMParser()
        .parseFromString(output, 'text/html')
        .querySelectorAll('[data-reach-science-kit]'),
    ).toHaveLength(4);
  });

  it('rejects escape expansion above the assembled cap and mixed heavy kits', () => {
    const boundary = structuredClone(
      fixtures('boundaries').find((f) => f.id === 'numeric-unicode-bytes-65536')!.envelope,
    );
    for (const item of boundary.spec.presentation.objects as unknown as Array<{ label?: string }>)
      item.label = '<'.repeat(160);
    const envelopes = Array(4).fill(boundary);
    const rawHtml = html(envelopes).replaceAll('\\u003c', '<');
    expect(Buffer.byteLength(rawHtml)).toBeLessThan(512 * 1024);
    expect(() => source(envelopes, { documentHtml: rawHtml })).toThrow(/srcdoc/);
    const spatial = fixtures('scenarios').find((f) => f.envelope.spec.dimension === 3)!.envelope;
    expect(() => source([spatial, spatial])).toThrow(/one heavy/);
  });
});
