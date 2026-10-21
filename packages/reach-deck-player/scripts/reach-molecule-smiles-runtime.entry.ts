import SmilesDrawer from 'smiles-drawer';

import { fillTarget, frozenController, registerScienceKit } from './science-kit-runtime.shared';

type SmilesVertex = {
  id: number;
  neighbours: number[];
  position: { x: number; y: number };
  value: { element: string };
};

type SmilesEdge = {
  id: number;
  sourceId: number;
  targetId: number;
  weight: number;
};

type SmilesGraph = { vertices: SmilesVertex[]; edges: SmilesEdge[] };
type AtomChoice = {
  key: string;
  kind: 'atom-selected';
  moleculeId: string;
  atomId: number;
  element: string;
  neighborCount: number;
  carbonNeighborCount: number;
};
type BondChoice = {
  key: string;
  kind: 'bond-selected';
  moleculeId: string;
  bondId: number;
  sourceAtomId: number;
  targetAtomId: number;
  sourceElement: string;
  targetElement: string;
  bondOrder: number;
};
type MoleculeChoice = AtomChoice | BondChoice;
type MoleculeState = { selectionMode: string; selections: string[] };

registerScienceKit('molecule-smiles', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  let resizeFrame = 0;
  const molecules = spec.molecules as Array<Record<string, unknown>>;
  const selectionMode = String(spec.selectionMode);
  const selectedChoices = new Map<string, MoleculeChoice>();
  const selectionCatalog = new Map<string, MoleculeChoice>();

  const updateDiagnostics = () => {
    target.dataset.reachScienceKitSelectionMode = selectionMode;
    target.dataset.reachScienceKitSelectionCount = String(selectedChoices.size);
    target.dataset.reachScienceKitSelections = [...selectedChoices.values()]
      .map(({ key }) => key)
      .join(',');
  };
  const selectChoice = (choice: MoleculeChoice) => {
    selectedChoices.set(choice.moleculeId, choice);
    updateDiagnostics();
    target.dispatchEvent(
      new CustomEvent('reach-science-kit-change', {
        detail: {
          ...choice,
          key: undefined,
          selectedCount: selectedChoices.size,
          total: molecules.length,
        },
      }),
    );
    render();
  };
  const bindKeyboardSelection = (node: SVGElement, select: () => void) => {
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
  };
  const render = () => {
    target.replaceChildren();
    selectionCatalog.clear();
    const compactComparison =
      spec.layout !== 'single' &&
      target.clientWidth < 500 &&
      target.clientHeight >= Math.max(260, molecules.length * 120);
    const columns = spec.layout === 'single' || compactComparison ? 1 : molecules.length;
    const rows = compactComparison ? molecules.length : 1;
    const gap = 12;
    const statusHeight = selectionMode === 'none' ? 0 : 30;
    const drawingWidth = Math.max(
      120,
      Math.floor((target.clientWidth - gap * (columns - 1)) / columns),
    );
    const drawingHeight = Math.max(
      72,
      Math.floor((target.clientHeight - statusHeight - gap * (rows - 1)) / rows) - 24,
    );

    const shell = document.createElement('div');
    Object.assign(shell.style, {
      display: 'grid',
      gridTemplateRows: selectionMode === 'none' ? 'minmax(0, 1fr)' : '30px minmax(0, 1fr)',
      gap: selectionMode === 'none' ? '0' : '4px',
      width: '100%',
      height: '100%',
      minHeight: '0',
    });
    if (selectionMode !== 'none') {
      const status = document.createElement('div');
      status.setAttribute('data-reach-molecule-selection-status', '');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = `${selectedChoices.size} / ${molecules.length}`;
      Object.assign(status.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        color: '#64748b',
        fontSize: '15px',
        fontWeight: '700',
      });
      shell.append(status);
    }

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      gap: `${gap}px`,
      width: '100%',
      alignSelf: 'stretch',
      minHeight: '0',
    });
    for (const molecule of molecules) {
      const moleculeId = String(molecule.id);
      const moleculeLabel = String(molecule.label ?? molecule.id);
      const figure = document.createElement('figure');
      Object.assign(figure.style, {
        display: 'grid',
        gridTemplateRows: 'minmax(0, 1fr) auto',
        margin: '0',
        minHeight: '0',
        minWidth: '0',
        overflow: 'hidden',
        background: selectedChoices.has(moleculeId) ? '#e8f5f1' : '#ffffff',
        boxShadow: selectedChoices.has(moleculeId) ? 'inset 0 0 0 3px #15803d' : 'none',
      });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(drawingHeight));
      Object.assign(svg.style, { display: 'block', height: '100%', width: '100%' });
      const caption = document.createElement('figcaption');
      caption.textContent = moleculeLabel;
      const drawer = new SmilesDrawer.SmiDrawer({ width: drawingWidth, height: drawingHeight });
      drawer.draw(String(molecule.smiles), svg, 'light', null, (error: unknown) => {
        throw error;
      });
      const graph = (drawer as unknown as { drawer: { preprocessor: { graph: SmilesGraph } } })
        .drawer.preprocessor.graph;

      if (selectionMode === 'atom') {
        for (const vertex of graph.vertices) {
          const key = `${moleculeId}:atom:${vertex.id}`;
          const choice: AtomChoice = {
            key,
            kind: 'atom-selected',
            moleculeId,
            atomId: vertex.id,
            element: vertex.value.element,
            neighborCount: vertex.neighbours.length,
            carbonNeighborCount: vertex.neighbours.filter(
              (neighborId) => graph.vertices[neighborId]?.value.element === 'C',
            ).length,
          };
          selectionCatalog.set(key, choice);
          if (selectedChoices.get(moleculeId)?.key === key) {
            const highlight = document.createElementNS(svg.namespaceURI, 'circle');
            highlight.setAttribute('cx', String(vertex.position.x));
            highlight.setAttribute('cy', String(vertex.position.y));
            highlight.setAttribute('r', '16');
            highlight.setAttribute('fill', '#22c55e55');
            highlight.setAttribute('stroke', '#15803d');
            highlight.setAttribute('stroke-width', '3');
            highlight.setAttribute('pointer-events', 'none');
            svg.append(highlight);
          }
          const hitTarget = document.createElementNS(svg.namespaceURI, 'circle');
          hitTarget.setAttribute('cx', String(vertex.position.x));
          hitTarget.setAttribute('cy', String(vertex.position.y));
          hitTarget.setAttribute('r', '22');
          hitTarget.setAttribute('fill', 'transparent');
          hitTarget.setAttribute('role', 'button');
          hitTarget.setAttribute('tabindex', '0');
          hitTarget.setAttribute('aria-label', `${moleculeLabel} ${vertex.value.element}`);
          hitTarget.setAttribute('data-reach-molecule-atom-choice', key);
          hitTarget.setAttribute('data-reach-molecule-element', vertex.value.element);
          hitTarget.style.cursor = 'pointer';
          const select = () => selectChoice(choice);
          hitTarget.addEventListener('click', select);
          bindKeyboardSelection(hitTarget, select);
          svg.append(hitTarget);
        }
      } else if (selectionMode === 'bond') {
        for (const edge of graph.edges) {
          const source = graph.vertices[edge.sourceId]!;
          const destination = graph.vertices[edge.targetId]!;
          const key = `${moleculeId}:bond:${edge.id}`;
          const choice: BondChoice = {
            key,
            kind: 'bond-selected',
            moleculeId,
            bondId: edge.id,
            sourceAtomId: edge.sourceId,
            targetAtomId: edge.targetId,
            sourceElement: source.value.element,
            targetElement: destination.value.element,
            bondOrder: edge.weight,
          };
          selectionCatalog.set(key, choice);
          if (selectedChoices.get(moleculeId)?.key === key) {
            const highlight = document.createElementNS(svg.namespaceURI, 'line');
            highlight.setAttribute('x1', String(source.position.x));
            highlight.setAttribute('y1', String(source.position.y));
            highlight.setAttribute('x2', String(destination.position.x));
            highlight.setAttribute('y2', String(destination.position.y));
            highlight.setAttribute('stroke', '#22c55e99');
            highlight.setAttribute('stroke-width', '12');
            highlight.setAttribute('stroke-linecap', 'round');
            highlight.setAttribute('pointer-events', 'none');
            svg.append(highlight);
          }
          const hitTarget = document.createElementNS(svg.namespaceURI, 'line');
          hitTarget.setAttribute('x1', String(source.position.x));
          hitTarget.setAttribute('y1', String(source.position.y));
          hitTarget.setAttribute('x2', String(destination.position.x));
          hitTarget.setAttribute('y2', String(destination.position.y));
          hitTarget.setAttribute('stroke', 'transparent');
          hitTarget.setAttribute('stroke-width', '44');
          hitTarget.setAttribute('stroke-linecap', 'round');
          hitTarget.setAttribute('pointer-events', 'stroke');
          hitTarget.setAttribute('role', 'button');
          hitTarget.setAttribute('tabindex', '0');
          hitTarget.setAttribute(
            'aria-label',
            `${moleculeLabel} ${source.value.element}-${destination.value.element}`,
          );
          hitTarget.setAttribute('data-reach-molecule-bond-choice', key);
          hitTarget.style.cursor = 'pointer';
          const select = () => selectChoice(choice);
          hitTarget.addEventListener('click', select);
          bindKeyboardSelection(hitTarget, select);
          svg.append(hitTarget);
        }
      }
      figure.append(svg, caption);
      grid.append(figure);
    }
    shell.append(grid);
    target.append(shell);
    updateDiagnostics();
  };

  render();
  const resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(render);
  });
  resizeObserver.observe(target);
  return frozenController(
    () => {
      selectedChoices.clear();
      render();
    },
    () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      target.replaceChildren();
    },
    (): MoleculeState => ({
      selectionMode,
      selections: [...selectedChoices.values()].map(({ key }) => key),
    }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const candidate = state as Partial<MoleculeState>;
      if (
        candidate.selectionMode !== selectionMode ||
        !Array.isArray(candidate.selections) ||
        !candidate.selections.every((key) => typeof key === 'string' && selectionCatalog.has(key))
      )
        return false;
      const restored = candidate.selections.map((key) => selectionCatalog.get(key)!);
      if (new Set(restored.map(({ moleculeId }) => moleculeId)).size !== restored.length)
        return false;
      selectedChoices.clear();
      for (const choice of restored) selectedChoices.set(choice.moleculeId, choice);
      render();
      return true;
    },
  );
});
