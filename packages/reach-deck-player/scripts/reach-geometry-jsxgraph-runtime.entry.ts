import JXG from 'jsxgraph';

import {
  color,
  fillTarget,
  frozenController,
  registerScienceKit,
} from './science-kit-runtime.shared';

registerScienceKit('geometry-jsxgraph', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const boardElement = document.createElement('div');
  boardElement.id = `reach-jxg-${crypto.randomUUID()}`;
  boardElement.className = 'jxgbox';
  Object.assign(boardElement.style, {
    width: '100%',
    height: '100%',
    minHeight: '320px',
    position: 'relative',
  });
  target.append(boardElement);
  const boardSpec = spec.board as {
    boundingBox: [number, number, number, number];
    axes: boolean;
    grid: boolean;
    snapSize: number;
  };
  const board = JXG.JSXGraph.initBoard(boardElement.id, {
    boundingbox: boardSpec.boundingBox,
    axis: boardSpec.axes,
    grid: boardSpec.grid,
    showCopyright: false,
    showNavigation: false,
    pan: { enabled: false },
    zoom: { enabled: false },
  });
  const objects = new Map<string, any>();
  for (const point of spec.points as Array<Record<string, unknown>>) {
    const created = board.create('point', [Number(point.x), Number(point.y)], {
      name: point.label ?? point.id,
      fixed: point.mobility !== 'free',
      snapToGrid: point.mobility === 'free',
      snapSizeX: boardSpec.snapSize,
      snapSizeY: boardSpec.snapSize,
      fillColor: '#2563eb',
      strokeColor: '#ffffff',
    });
    created.on('drag', () =>
      target.dispatchEvent(
        new CustomEvent('reach-science-kit-change', {
          detail: { kind: 'point-moved', pointId: point.id, x: created.X(), y: created.Y() },
        }),
      ),
    );
    if (point.mobility === 'free' && created.rendNode instanceof SVGElement) {
      created.rendNode.setAttribute('data-reach-dynamic-point-draggable', String(point.id));
      created.rendNode.setAttribute('tabindex', '0');
      created.rendNode.setAttribute('role', 'slider');
      created.rendNode.setAttribute('aria-label', String(point.label ?? point.id));
      created.rendNode.addEventListener('keydown', (event: KeyboardEvent) => {
        const delta = boardSpec.snapSize || 0.25;
        const movement: Record<string, [number, number]> = {
          ArrowLeft: [-delta, 0],
          ArrowRight: [delta, 0],
          ArrowUp: [0, delta],
          ArrowDown: [0, -delta],
        };
        const offset = movement[event.key];
        if (!offset) return;
        event.preventDefault();
        created.setPosition(JXG.COORDS_BY_USER, [created.X() + offset[0], created.Y() + offset[1]]);
        board.update();
        target.dispatchEvent(
          new CustomEvent('reach-science-kit-change', {
            detail: { kind: 'point-moved', pointId: point.id, x: created.X(), y: created.Y() },
          }),
        );
      });
    }
    objects.set(String(point.id), created);
  }
  for (const item of spec.constructions as Array<Record<string, unknown>>) {
    const attrs = {
      strokeColor: color(item.colorToken),
      fillColor: `${color(item.colorToken)}22`,
      fixed: true,
      name: item.id,
    };
    let created: any;
    if (['segment', 'line', 'ray', 'vector'].includes(String(item.kind)))
      created = board.create(
        String(item.kind),
        [objects.get(String(item.from)), objects.get(String(item.to))],
        attrs,
      );
    else if (item.kind === 'circle')
      created = board.create(
        'circle',
        [objects.get(String(item.center)), objects.get(String(item.through))],
        attrs,
      );
    else if (item.kind === 'polygon')
      created = board.create(
        'polygon',
        (item.pointIds as string[]).map((id) => objects.get(id)),
        attrs,
      );
    else if (item.kind === 'midpoint')
      created = board.create(
        'midpoint',
        [objects.get(String(item.a)), objects.get(String(item.b))],
        attrs,
      );
    else if (item.kind === 'intersection')
      created = board.create(
        'intersection',
        [
          objects.get(String(item.firstObject)),
          objects.get(String(item.secondObject)),
          Number(item.branch),
        ],
        attrs,
      );
    else if (item.kind === 'parallel' || item.kind === 'perpendicular')
      created = board.create(
        String(item.kind),
        [objects.get(String(item.through)), objects.get(String(item.line))],
        attrs,
      );
    if (created) objects.set(String(item.id), created);
  }
  const initial = (spec.points as Array<Record<string, unknown>>).map((point) => ({
    id: String(point.id),
    mobility: String(point.mobility),
    x: Number(point.x),
    y: Number(point.y),
  }));
  const reset = () => {
    for (const point of initial)
      objects.get(point.id)?.setPosition(JXG.COORDS_BY_USER, [point.x, point.y]);
    board.update();
  };
  return frozenController(
    reset,
    () => {
      JXG.JSXGraph.freeBoard(board);
      target.replaceChildren();
    },
    () => ({
      points: initial.map(({ id }) => {
        const point = objects.get(id);
        return { id, x: point.X(), y: point.Y() };
      }),
    }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const points = (state as { points?: unknown }).points;
      if (!Array.isArray(points) || points.length !== initial.length) return false;
      const restored = new Map<string, { x: number; y: number }>();
      for (const point of points) {
        if (typeof point !== 'object' || point === null) return false;
        const value = point as { id?: unknown; x?: unknown; y?: unknown };
        if (
          typeof value.id !== 'string' ||
          restored.has(value.id) ||
          !initial.some(({ id }) => id === value.id) ||
          !Number.isFinite(value.x) ||
          !Number.isFinite(value.y)
        )
          return false;
        restored.set(value.id, { x: Number(value.x), y: Number(value.y) });
      }
      for (const point of initial) {
        const position = restored.get(point.id)!;
        if (point.mobility !== 'free' && (position.x !== point.x || position.y !== point.y))
          return false;
      }
      for (const [id, position] of restored)
        objects.get(id)?.setPosition(JXG.COORDS_BY_USER, [position.x, position.y]);
      board.update();
      return true;
    },
  );
});
