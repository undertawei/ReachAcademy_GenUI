import { beforeAll, describe, expect, it, vi } from 'vitest';

const models: Array<{
  selectedAtoms: ReturnType<typeof vi.fn>;
  setStyle: ReturnType<typeof vi.fn>;
}> = [];

const createViewer = vi.fn(() => {
  const model = {
    selectedAtoms: vi.fn(() => [
      { index: 0, elem: 'O', bonds: [1] },
      { index: 1, elem: 'H', bonds: [0] },
    ]),
    setStyle: vi.fn(),
  };
  models.push(model);
  return {
    addModel: vi.fn(() => model),
    clear: vi.fn(),
    getView: vi.fn(() => [0, 0, 0, 1]),
    render: vi.fn(),
    resize: vi.fn(),
    setView: vi.fn(),
    zoom: vi.fn(),
    zoomTo: vi.fn(),
  };
});

vi.mock('3dmol', () => ({ createViewer }));

const baseSpec = {
  ariaLabel: 'Water molecule',
  structures: [{ id: 'water', format: 'pdb', data: 'ATOM' }],
};

beforeAll(async () => {
  await import('../scripts/reach-molecule-3dmol-runtime.entry');
});

const mount = (styles: string[]) => {
  const target = document.createElement('div');
  window.__reachScienceKitFacades!['molecule-3dmol']!.mount(target, {
    ...baseSpec,
    representations: styles.map((style, index) => ({
      id: `representation_${index}`,
      structureId: 'water',
      style,
    })),
  });
  return models.at(-1)!;
};

describe('molecule-3d 3Dmol runtime', () => {
  it('uses one scale so 3Dmol element radii determine relative atom sizes', () => {
    const model = mount(['stick', 'sphere']);

    expect(model.setStyle).toHaveBeenNthCalledWith(
      1,
      {},
      {
        sphere: { scale: 0.24 },
        stick: { radius: 0.13 },
      },
    );
    expect(model.setStyle).toHaveBeenNthCalledWith(
      2,
      { elem: 'H' },
      {
        sphere: { color: '#cbd5e1' },
        stick: { color: '#94a3b8' },
      },
      true,
    );
  });

  it('does not inject sphere or stick into a line-only representation', () => {
    const model = mount(['line']);

    expect(model.setStyle).toHaveBeenNthCalledWith(1, {}, { line: {} });
    expect(model.setStyle).toHaveBeenNthCalledWith(
      2,
      { elem: 'H' },
      { line: { color: '#94a3b8' } },
      true,
    );
  });
});
