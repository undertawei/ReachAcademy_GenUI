// @vitest-environment jsdom

import scenario from '../../reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

import type { GeometryAuthoringEditProposal } from '../src/geometryAuthoring.js';
import { geometryEnvelopeFingerprint, inspectGeometryAuthoring } from '../src/geometryAuthoring.js';
import { createEditorDocument } from './fixture.js';

const player = vi.hoisted(() => ({
  proposal: undefined as GeometryAuthoringEditProposal | undefined,
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@reachany/reach-deck-player', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reachany/reach-deck-player')>();
  return {
    ...actual,
    ReachDeckPlayer: (props: Record<string, unknown>) => {
      player.props = props;
      return (
        <button
          data-testid="geometry-proposal"
          onClick={() =>
            player.proposal &&
            (
              props.onGeometryEditProposal as
                | ((proposal: GeometryAuthoringEditProposal) => void)
                | undefined
            )?.(player.proposal)
          }
          type="button"
        >
          geometry
        </button>
      );
    },
  };
});

import { ReachDeckEditor } from '../src/ReachDeckEditor.js';

function geometryDocument(withBindings = true): ReachDeckDocument {
  const envelope = structuredClone(scenario.envelope) as Record<string, any>;
  if (!withBindings) delete envelope.spec.authoring;
  const base = createEditorDocument();
  return {
    ...base,
    pages: [
      {
        pageId: 'page-1',
        order: 1,
        revision: 1,
        sceneType: 'interactive',
        title: 'Geometry',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'page-1',
          title: 'Geometry',
          sceneType: 'interactive',
          documentHtml: `<!doctype html><html><head></head><body><script type="application/json" data-reach-science-kit="geometry-main">${JSON.stringify(envelope)}</script><div data-reach-science-kit-target="geometry-main"></div></body></html>`,
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          runtimeDependencies: [{ id: 'geometry-euclidean-2d-v2', version: '1.0.0' }],
        },
      },
    ],
    nativeSlides: [],
  };
}

const emptyAuxiliary = {
  objects: [],
  measurements: [],
  relations: [],
  freedoms: [],
  presentation: { objects: [], measurements: [], relations: [] },
};

function proposal(
  document: ReachDeckDocument,
  patch: { auxiliary?: unknown; camera?: unknown; parameters?: Record<string, number> } = {},
): GeometryAuthoringEditProposal {
  const page = document.pages[0]!;
  if (page.sceneType !== 'interactive') throw new Error('expected interactive page');
  const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
  return {
    schemaVersion: 'reach-geometry-edit-proposal/v1',
    pageId: page.pageId,
    sourceRevision: page.revision,
    instanceId: instance.instanceId,
    fingerprint: instance.fingerprint,
    envelope: instance.envelope,
    wireSequence: 2,
    state: {
      schemaVersion: 'reach-geometry-state/v2',
      instanceId: instance.instanceId,
      fingerprint: geometryEnvelopeFingerprint(instance.envelope),
      inputs: { parameters: patch.parameters ?? {}, freedoms: {} },
      auxiliary: patch.auxiliary ?? emptyAuxiliary,
      hiddenAuxiliary: [],
      selection: null,
      visibleGroups: [],
      camera: patch.camera ?? instance.envelope.spec.presentation.camera,
    },
  };
}

function click(container: HTMLElement, matcher: (button: HTMLButtonElement) => boolean): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(matcher);
  if (button === undefined) throw new Error('button not found');
  act(() => button.click());
}

describe('ReachDeckEditor geometry authoring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    player.proposal = undefined;
    player.props = undefined;
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps an unbound v2 geometry read-only and points to Decksmith', () => {
    act(() => root.render(<ReachDeckEditor document={geometryDocument(false)} />));
    click(container, (button) => button.textContent === '属性');
    expect(container.textContent).toContain('此几何未声明直接编辑范围');
    expect(container.textContent).not.toContain('设为初始状态');
  });

  it('does not write ordinary input/camera proposals or trial changes', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    player.proposal = proposal(document, {
      camera: { kind: 'planar', bounds: [-20, -20, 20, 20] },
    });
    click(container, (button) => button.dataset.testid === 'geometry-proposal');
    expect(onChange).not.toHaveBeenCalled();

    click(container, (button) => button.textContent === '试用');
    expect(player.props?.geometryHostMode).toBe('authoring-trial');
    click(container, (button) => button.dataset.testid === 'geometry-proposal');
    expect(onChange).not.toHaveBeenCalled();

    click(container, (button) => button.textContent === '编辑');
    expect(player.props?.geometryHostMode).toBe('authoring-edit');
  });

  it('keeps disabled geometry in trial mode without an edit callback', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor disabled document={document} onChange={onChange} />));

    expect(player.props?.geometryHostMode).toBe('authoring-trial');
    expect(player.props?.initialRuntimeByPageId).toBeUndefined();
    expect(player.props?.onGeometryEditProposal).toBeUndefined();
    const modeButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === '编辑' || button.textContent === '试用',
    );
    expect(modeButtons.length).toBeGreaterThan(0);
    expect(modeButtons.every((button) => button.disabled)).toBe(true);

    player.proposal = proposal(document, { auxiliary: scenario.auxiliary });
    click(container, (button) => button.dataset.testid === 'geometry-proposal');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects a stale geometry proposal callback after the page becomes locked', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const staleProposalCallback = player.props?.onGeometryEditProposal as
      | ((value: GeometryAuthoringEditProposal) => void)
      | undefined;
    expect(staleProposalCallback).toBeTypeOf('function');

    act(() =>
      root.render(
        <ReachDeckEditor document={document} lockedPageIds={['page-1']} onChange={onChange} />,
      ),
    );
    expect(player.props?.geometryHostMode).toBe('authoring-trial');
    expect(player.props?.initialRuntimeByPageId).toBeUndefined();
    expect(player.props?.onGeometryEditProposal).toBeUndefined();
    const modeButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === '编辑' || button.textContent === '试用',
    );
    expect(modeButtons.length).toBeGreaterThan(0);
    expect(modeButtons.every((button) => button.disabled)).toBe(true);

    act(() => staleProposalCallback?.(proposal(document, { auxiliary: scenario.auxiliary })));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects a stale geometry proposal callback while page generation is pending', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onChange={onChange}
          onGeneratePage={() => new Promise<undefined>(() => {})}
        />,
      ),
    );
    const staleProposalCallback = player.props?.onGeometryEditProposal as
      | ((value: GeometryAuthoringEditProposal) => void)
      | undefined;
    expect(staleProposalCallback).toBeTypeOf('function');

    click(container, (button) => button.textContent === '生成当前页');
    expect(player.props?.geometryHostMode).toBe('authoring-trial');
    expect(player.props?.initialRuntimeByPageId).toBeUndefined();
    expect(player.props?.onGeometryEditProposal).toBeUndefined();

    act(() => staleProposalCallback?.(proposal(document, { auxiliary: scenario.auxiliary })));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('promotes an auxiliary graph without implicitly saving the earlier camera', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const movedCamera = { kind: 'planar', bounds: [-20, -20, 20, 20] };
    player.proposal = proposal(document, { camera: movedCamera });
    click(container, (button) => button.dataset.testid === 'geometry-proposal');
    player.proposal = proposal(document, { auxiliary: scenario.auxiliary, camera: movedCamera });
    click(container, (button) => button.dataset.testid === 'geometry-proposal');

    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0]![0] as ReachDeckDocument;
    const page = saved.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('expected interactive page');
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    expect(instance.envelope.spec.objects.map(({ id }) => id)).toContain('A_M');
    expect(instance.snapshot).toBeUndefined();
    expect(page.scene.documentHtml).not.toContain('data-reach-geometry-snapshot');
  });

  it('commits set-initial explicitly and routes the edit through editor undo', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    player.proposal = proposal(document, {
      camera: { kind: 'planar', bounds: [-4, -3, 10, 8] },
    });
    click(container, (button) => button.dataset.testid === 'geometry-proposal');
    click(container, (button) => button.textContent === '属性');
    click(container, (button) => button.textContent === '设为初始状态');
    expect(onChange).toHaveBeenCalledTimes(1);

    const saved = onChange.mock.calls[0]![0] as ReachDeckDocument;
    const savedPage = saved.pages[0]!;
    if (savedPage.sceneType !== 'interactive') throw new Error('expected interactive page');
    expect(
      inspectGeometryAuthoring(savedPage.scene.documentHtml).instances[0]!.snapshot?.camera,
    ).toEqual({ kind: 'planar', bounds: [-4, -3, 10, 8] });

    click(container, (button) => button.getAttribute('aria-label') === '撤销课件修改');
    expect(onChange).toHaveBeenCalledTimes(2);
    const undone = onChange.mock.calls[1]![0] as ReachDeckDocument;
    const undonePage = undone.pages[0]!;
    if (undonePage.sceneType !== 'interactive') throw new Error('expected interactive page');
    expect(undonePage.scene.documentHtml).not.toContain('data-reach-geometry-snapshot');
  });

  it('commits bound property and exploration policy edits', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    click(container, (button) => button.textContent === '属性');
    const item = container.querySelector<HTMLSelectElement>('select[aria-label="对象"]')!;
    act(() => {
      item.value = 'objects:AP';
      item.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const label = container.querySelector<HTMLInputElement>('input[aria-label="标签"]')!;
    act(() => {
      label.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(label, '辅助线');
      label.dispatchEvent(new Event('input', { bubbles: true }));
      label.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => label.blur());
    expect(onChange).toHaveBeenCalledTimes(1);

    const hidden = container.querySelector<HTMLSelectElement>('select[aria-label="反馈方式"]')!;
    act(() => {
      hidden.value = 'hidden';
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('uses the geometry contract measurement precision bounds', () => {
    const document = geometryDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    player.proposal = proposal(document, { auxiliary: scenario.auxiliary });
    click(container, (button) => button.dataset.testid === 'geometry-proposal');
    click(container, (button) => button.textContent === '属性');
    const item = container.querySelector<HTMLSelectElement>('select[aria-label="对象"]')!;
    act(() => {
      item.value = 'measurements:A_height';
      item.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const decimals = container.querySelector<HTMLInputElement>('input[aria-label="小数位"]')!;
    expect(decimals.min).toBe('0');
    expect(decimals.max).toBe('4');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(decimals, '5');
      decimals.dispatchEvent(new Event('input', { bubbles: true }));
      decimals.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('几何设置超出允许范围');
  });
});
