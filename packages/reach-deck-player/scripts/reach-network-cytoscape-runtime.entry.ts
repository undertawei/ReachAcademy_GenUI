import cytoscape from 'cytoscape';

import {
  color,
  fillTarget,
  frozenController,
  registerScienceKit,
} from './science-kit-runtime.shared';

registerScienceKit('network-cytoscape', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  target.style.minHeight = '0';
  const interaction = spec.interaction as Record<string, boolean>;
  const nodes = spec.nodes as Array<Record<string, unknown>>;
  const edges = spec.edges as Array<Record<string, unknown>>;
  let restoring = false;
  const elements = [
    ...nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label,
        group: node.group,
        color: color(node.colorToken),
      },
    })),
    ...edges.map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        color: color(edge.colorToken),
        directed: edge.relation === 'undirected' ? 'false' : 'true',
      },
    })),
  ];
  const layoutOptions = (name = String(spec.layout)) => ({
    name,
    animate: false,
    fit: true,
    padding: 52,
    avoidOverlap: true,
    minNodeSpacing: 84,
    spacingFactor: 1.8,
    ...(name === 'grid' ? { rows: 2 } : {}),
  });

  const shell = document.createElement('div');
  Object.assign(shell.style, {
    display: 'grid',
    gridTemplateRows: interaction.selectable ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)',
    width: '100%',
    height: '100%',
    minHeight: '0',
  });
  const controls = document.createElement('div');
  controls.setAttribute('data-reach-network-controls', '');
  Object.assign(controls.style, {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 8px',
    borderBottom: '1px solid #e2e8f0',
  });
  const graphHost = document.createElement('div');
  graphHost.setAttribute('data-reach-network-graph', '');
  Object.assign(graphHost.style, { width: '100%', height: '100%', minHeight: '0' });
  if (interaction.selectable) shell.append(controls);
  shell.append(graphHost);
  target.append(shell);

  const graph = cytoscape({
    container: graphHost,
    elements,
    layout: layoutOptions(),
    userZoomingEnabled: Boolean(interaction.zoomable),
    userPanningEnabled: Boolean(interaction.zoomable),
    autoungrabify: !interaction.draggable,
    autounselectify: !interaction.selectable,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'background-color': 'data(color)',
          color: '#172033',
          'text-valign': 'bottom',
          'text-margin-y': 10,
          'font-size': 16,
          width: 48,
          height: 48,
          'text-background-color': '#f8fafc',
          'text-background-opacity': 0.88,
          'text-background-padding': 3,
        },
      },
      {
        selector: 'edge',
        style: {
          label: 'data(label)',
          width: 2,
          'line-color': 'data(color)',
          'target-arrow-shape': 'none',
        },
      },
      {
        selector: 'edge[directed = "true"]',
        style: {
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
        },
      },
      { selector: ':selected', style: { 'border-width': 4, 'border-color': '#f59e0b' } },
    ],
  });

  const choiceButtons = new Map<string, HTMLButtonElement>();
  for (const node of interaction.selectable ? nodes : []) {
    const nodeId = String(node.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(node.label);
    button.setAttribute('data-reach-network-node-choice', nodeId);
    button.setAttribute('aria-pressed', 'false');
    Object.assign(button.style, {
      minHeight: '44px',
      minWidth: '44px',
      padding: '8px 12px',
      border: '1px solid #cbd5e1',
      background: '#ffffff',
      color: '#172033',
      cursor: 'pointer',
    });
    button.addEventListener('click', () => {
      const graphNode = graph.getElementById(nodeId);
      if (graphNode.selected()) graphNode.unselect();
      else graphNode.select();
    });
    choiceButtons.set(nodeId, button);
    controls.append(button);
  }

  const directedRelationIds = (nodeId: string, direction: 'incoming' | 'outgoing') => [
    ...new Set(
      edges.flatMap((edge) => {
        const source = String(edge.source);
        const destination = String(edge.target);
        if (edge.relation === 'undirected') return [];
        if (direction === 'incoming' && destination === nodeId) return [source];
        if (direction === 'outgoing' && source === nodeId) return [destination];
        return [];
      }),
    ),
  ];
  const undirectedRelationIds = (nodeId: string) => [
    ...new Set(
      edges.flatMap((edge) => {
        if (edge.relation !== 'undirected') return [];
        const source = String(edge.source);
        const destination = String(edge.target);
        if (source === nodeId) return [destination];
        if (destination === nodeId) return [source];
        return [];
      }),
    ),
  ];
  const updateSelectionDiagnostics = () => {
    const selectedIds = graph.$('node:selected').map((node) => node.id());
    target.dataset.reachScienceKitSelectedNodes = selectedIds.join(',');
    for (const [nodeId, button] of choiceButtons) {
      const selected = selectedIds.includes(nodeId);
      button.setAttribute('aria-pressed', String(selected));
      button.style.background = selected ? '#fef3c7' : '#ffffff';
      button.style.borderColor = selected ? '#d97706' : '#cbd5e1';
    }
  };
  graph.on('select unselect', 'node', (event) => {
    updateSelectionDiagnostics();
    if (restoring) return;
    const nodeId = event.target.id();
    target.dispatchEvent(
      new CustomEvent('reach-science-kit-change', {
        detail: {
          kind: event.type === 'select' ? 'node-selected' : 'node-unselected',
          nodeId,
          selected: event.target.selected(),
          incomingIds: directedRelationIds(nodeId, 'incoming'),
          outgoingIds: directedRelationIds(nodeId, 'outgoing'),
          undirectedIds: undirectedRelationIds(nodeId),
        },
      }),
    );
  });
  graph.on('dragfree', 'node', (event) => {
    if (restoring) return;
    const position = event.target.position();
    target.dispatchEvent(
      new CustomEvent('reach-science-kit-change', {
        detail: { kind: 'node-moved', nodeId: event.target.id(), x: position.x, y: position.y },
      }),
    );
  });

  let resizeFrame = 0;
  let compactLayout: boolean | undefined;
  const fitToContainer = () => {
    graph.resize();
    const compact = graphHost.clientHeight < 220 || graphHost.clientWidth < 420;
    if (compact !== compactLayout) {
      graph.nodes().style({
        width: compact ? 30 : 48,
        height: compact ? 30 : 48,
        'font-size': compact ? 10 : 16,
        'text-margin-y': compact ? 5 : 10,
      });
      graph.layout(layoutOptions(compact ? 'grid' : String(spec.layout))).run();
      compactLayout = compact;
    }
    graph.fit(undefined, Math.max(8, Math.min(32, graphHost.clientHeight * 0.08)));
    const bounds = graph.elements().renderedBoundingBox();
    target.dataset.reachScienceKitGraphViewport = `${graph.width()}x${graph.height()}`;
    target.dataset.reachScienceKitGraphBounds = `${bounds.x1},${bounds.y1},${bounds.x2},${bounds.y2}`;
    target.dataset.reachScienceKitGraphZoom = String(graph.zoom());
  };
  const refit = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fitToContainer);
  };
  const resizeObserver = new ResizeObserver(refit);
  resizeObserver.observe(target);
  updateSelectionDiagnostics();
  fitToContainer();
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = requestAnimationFrame(fitToContainer);
  });
  const initialPositions = new Map(
    graph.nodes().map((node) => [node.id(), { ...node.position() }] as const),
  );
  const reset = () => {
    restoring = true;
    graph.elements().unselect();
    for (const [nodeId, position] of initialPositions)
      graph.getElementById(nodeId).position(position);
    restoring = false;
    compactLayout = undefined;
    updateSelectionDiagnostics();
    fitToContainer();
  };
  return frozenController(
    reset,
    () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      graph.destroy();
      target.replaceChildren();
    },
    () => ({
      selectedNodeIds: graph.$('node:selected').map((node) => node.id()),
      positions: graph.nodes().map((node) => ({ id: node.id(), ...node.position() })),
    }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const candidate = state as {
        selectedNodeIds?: unknown;
        positions?: unknown;
      };
      const knownIds = new Set(nodes.map(({ id }) => String(id)));
      if (
        !Array.isArray(candidate.selectedNodeIds) ||
        !candidate.selectedNodeIds.every((id) => typeof id === 'string' && knownIds.has(id)) ||
        !Array.isArray(candidate.positions) ||
        candidate.positions.length !== knownIds.size ||
        !candidate.positions.every(
          (position) =>
            typeof position === 'object' &&
            position !== null &&
            typeof (position as { id?: unknown }).id === 'string' &&
            knownIds.has((position as { id: string }).id) &&
            Number.isFinite((position as { x?: unknown }).x) &&
            Number.isFinite((position as { y?: unknown }).y),
        )
      )
        return false;
      const positions = new Map(
        candidate.positions.map((position) => {
          const value = position as { id: string; x: number; y: number };
          return [value.id, { x: value.x, y: value.y }] as const;
        }),
      );
      if (positions.size !== knownIds.size) return false;
      restoring = true;
      graph.elements().unselect();
      for (const [nodeId, position] of positions) graph.getElementById(nodeId).position(position);
      if (interaction.selectable) {
        for (const nodeId of candidate.selectedNodeIds as string[])
          graph.getElementById(nodeId).select();
      }
      restoring = false;
      updateSelectionDiagnostics();
      return true;
    },
  );
});
