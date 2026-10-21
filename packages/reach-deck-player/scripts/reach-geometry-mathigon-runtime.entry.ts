import { Point } from '@mathigon/euclid';

import {
  COLORS,
  color,
  fillTarget,
  frozenController,
  registerScienceKit,
} from './science-kit-runtime.shared';

type KitPoint = { id: string; label?: string; x: number; y: number; draggable: boolean };

registerScienceKit('geometry-mathigon', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const points = structuredClone(spec.points as KitPoint[]);
  const initial = structuredClone(points);
  const viewport = spec.viewport as { x: [number, number]; y: [number, number]; grid: boolean };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 800 480`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  target.append(svg);
  let activePoint: KitPoint | undefined;
  const project = (point: KitPoint) => ({
    x: ((point.x - viewport.x[0]) / (viewport.x[1] - viewport.x[0])) * 800,
    y: 480 - ((point.y - viewport.y[0]) / (viewport.y[1] - viewport.y[0])) * 480,
  });
  const pointById = (id: string) => points.find((point) => point.id === id)!;
  const dispatchPoint = (point: KitPoint, x: number, y: number) => {
    point.x = Math.max(viewport.x[0], Math.min(viewport.x[1], x));
    point.y = Math.max(viewport.y[0], Math.min(viewport.y[1], y));
    render();
    target.dispatchEvent(
      new CustomEvent('reach-science-kit-change', {
        detail: { kind: 'point-moved', pointId: point.id, x: point.x, y: point.y },
      }),
    );
  };
  const render = () => {
    svg.replaceChildren();
    if (viewport.grid) {
      const pattern = document.createElementNS(svg.namespaceURI, 'pattern');
      pattern.id = 'reach-grid';
      pattern.setAttribute('width', '40');
      pattern.setAttribute('height', '40');
      pattern.setAttribute('patternUnits', 'userSpaceOnUse');
      pattern.innerHTML =
        '<path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e2e8f0" stroke-width="1"/>';
      const defs = document.createElementNS(svg.namespaceURI, 'defs');
      defs.append(pattern);
      const grid = document.createElementNS(svg.namespaceURI, 'rect');
      grid.setAttribute('width', '800');
      grid.setAttribute('height', '480');
      grid.setAttribute('fill', 'url(#reach-grid)');
      svg.append(defs, grid);
    }
    for (const raw of spec.shapes as Array<Record<string, unknown>>) {
      const node = document.createElementNS(
        svg.namespaceURI,
        raw.kind === 'circle' ? 'circle' : raw.kind === 'polygon' ? 'polygon' : 'line',
      );
      node.setAttribute('stroke', color(raw.colorToken));
      node.setAttribute('stroke-width', '3');
      node.setAttribute('fill', raw.kind === 'polygon' ? `${color(raw.colorToken)}22` : 'none');
      if (raw.kind === 'circle') {
        const center = pointById(String(raw.center));
        const through = pointById(String(raw.through));
        const c = project(center);
        const radius = Point.distance(
          new Point(center.x, center.y),
          new Point(through.x, through.y),
        );
        node.setAttribute('cx', String(c.x));
        node.setAttribute('cy', String(c.y));
        node.setAttribute('r', String((radius / (viewport.x[1] - viewport.x[0])) * 800));
      } else if (raw.kind === 'polygon') {
        node.setAttribute(
          'points',
          (raw.pointIds as string[])
            .map((id) => {
              const p = project(pointById(id));
              return `${p.x},${p.y}`;
            })
            .join(' '),
        );
      } else {
        const from = project(pointById(String(raw.from)));
        const to = project(pointById(String(raw.to)));
        node.setAttribute('x1', String(from.x));
        node.setAttribute('y1', String(from.y));
        node.setAttribute('x2', String(to.x));
        node.setAttribute('y2', String(to.y));
      }
      svg.append(node);
    }
    for (const point of points) {
      const projected = project(point);
      const group = document.createElementNS(svg.namespaceURI, 'g');
      const circle = document.createElementNS(svg.namespaceURI, 'circle');
      circle.setAttribute('cx', String(projected.x));
      circle.setAttribute('cy', String(projected.y));
      circle.setAttribute('r', '8');
      circle.setAttribute('fill', COLORS.accent);
      circle.style.cursor = point.draggable ? 'grab' : 'default';
      const hitTarget = document.createElementNS(svg.namespaceURI, 'circle');
      hitTarget.setAttribute('cx', String(projected.x));
      hitTarget.setAttribute('cy', String(projected.y));
      hitTarget.setAttribute('r', '24');
      hitTarget.setAttribute('fill', 'transparent');
      hitTarget.style.cursor = point.draggable ? 'grab' : 'default';
      if (point.draggable) hitTarget.setAttribute('data-reach-point-draggable', point.id);
      if (point.draggable) {
        hitTarget.setAttribute('role', 'button');
        hitTarget.setAttribute('tabindex', '0');
        hitTarget.setAttribute('aria-label', point.label ?? point.id);
      }
      const label = document.createElementNS(svg.namespaceURI, 'text');
      label.setAttribute('x', String(projected.x + 12));
      label.setAttribute('y', String(projected.y - 10));
      label.textContent = point.label ?? point.id;
      label.setAttribute('font-size', '18');
      group.append(circle, label, hitTarget);
      svg.append(group);
      if (point.draggable) {
        hitTarget.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          activePoint = point;
          svg.setPointerCapture(event.pointerId);
        });
        hitTarget.addEventListener('keydown', (event) => {
          const stepX = (viewport.x[1] - viewport.x[0]) / 40;
          const stepY = (viewport.y[1] - viewport.y[0]) / 40;
          const delta = {
            ArrowLeft: [-stepX, 0],
            ArrowRight: [stepX, 0],
            ArrowUp: [0, stepY],
            ArrowDown: [0, -stepY],
          }[event.key];
          if (delta === undefined) return;
          event.preventDefault();
          dispatchPoint(point, point.x + delta[0], point.y + delta[1]);
        });
      }
    }
  };
  const movePoint = (event: PointerEvent) => {
    if (!activePoint) return;
    const rect = svg.getBoundingClientRect();
    dispatchPoint(
      activePoint,
      viewport.x[0] + ((event.clientX - rect.left) / rect.width) * (viewport.x[1] - viewport.x[0]),
      viewport.y[1] - ((event.clientY - rect.top) / rect.height) * (viewport.y[1] - viewport.y[0]),
    );
  };
  svg.addEventListener('pointermove', movePoint);
  svg.addEventListener('pointerup', () => {
    activePoint = undefined;
  });
  svg.addEventListener('pointercancel', () => {
    activePoint = undefined;
  });
  svg.style.touchAction = 'none';
  render();
  return frozenController(
    () => {
      points.splice(0, points.length, ...structuredClone(initial));
      render();
    },
    () => target.replaceChildren(),
    () => ({ points: points.map(({ id, x, y }) => ({ id, x, y })) }),
    (state) => {
      if (
        typeof state !== 'object' ||
        state === null ||
        !Array.isArray((state as { points?: unknown }).points)
      )
        return false;
      const restored = (state as { points: unknown[] }).points;
      if (restored.length !== points.length) return false;
      const byId = new Map(
        restored.flatMap((candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          typeof (candidate as { id?: unknown }).id === 'string' &&
          Number.isFinite((candidate as { x?: unknown }).x) &&
          Number.isFinite((candidate as { y?: unknown }).y)
            ? [
                [
                  (candidate as { id: string }).id,
                  candidate as { id: string; x: number; y: number },
                ] as const,
              ]
            : [],
        ),
      );
      if (byId.size !== points.length || points.some(({ id }) => !byId.has(id))) return false;
      for (const point of points) {
        const candidate = byId.get(point.id)!;
        point.x = Math.max(viewport.x[0], Math.min(viewport.x[1], candidate.x));
        point.y = Math.max(viewport.y[0], Math.min(viewport.y[1], candidate.y));
      }
      render();
      return true;
    },
  );
});
