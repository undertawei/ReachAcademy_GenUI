import {
  geoAzimuthalEqualArea,
  geoEqualEarth,
  geoGraticule10,
  geoMercator,
  geoOrthographic,
  geoPath,
} from 'd3-geo';
import { feature } from 'topojson-client';
import countries110m from 'world-atlas/countries-110m.json';

import {
  color,
  fillTarget,
  frozenController,
  registerScienceKit,
} from './science-kit-runtime.shared';

type GeoState = {
  center: [number, number];
  rotation: [number, number, number];
  scale: number;
};

registerScienceKit('geo-d3', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const interaction = spec.interaction as { pan: boolean; zoom: boolean; rotate: boolean };
  const projectionSpec = spec.projection as {
    kind: string;
    center: [number, number];
    rotate: [number, number, number];
  };
  const projectionFactory =
    {
      'equal-earth': geoEqualEarth,
      mercator: geoMercator,
      orthographic: geoOrthographic,
      'azimuthal-equal-area': geoAzimuthalEqualArea,
    }[projectionSpec.kind] ?? geoEqualEarth;
  const projection = projectionFactory()
    .center(projectionSpec.center)
    .rotate(projectionSpec.rotate)
    .fitExtent(
      [
        [16, 16],
        [784, 464],
      ],
      { type: 'Sphere' },
    );
  const path = geoPath(projection);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 480');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute(
    'tabindex',
    interaction.pan || interaction.rotate || interaction.zoom ? '0' : '-1',
  );
  svg.setAttribute('aria-label', String(spec.ariaLabel));
  target.append(svg);

  const initialCenter = [...projectionSpec.center] as [number, number];
  const initialRotation = [...projectionSpec.rotate] as [number, number, number];
  const initialScale = projection.scale();
  let center = [...initialCenter] as [number, number];
  let rotation = [...initialRotation] as [number, number, number];
  let drag: { x: number; y: number } | undefined;
  const render = () => {
    svg.replaceChildren();
    const ocean = document.createElementNS(svg.namespaceURI, 'path');
    ocean.setAttribute('d', path({ type: 'Sphere' }) ?? '');
    ocean.setAttribute('fill', '#e0f2fe');
    ocean.setAttribute('stroke', '#94a3b8');
    svg.append(ocean);
    const countries = feature(
      countries110m as never,
      (countries110m as unknown as { objects: { countries: never } }).objects.countries,
    );
    const land = document.createElementNS(svg.namespaceURI, 'path');
    land.setAttribute('d', path(countries as never) ?? '');
    land.setAttribute('fill', '#dcfce7');
    land.setAttribute('stroke', '#64748b');
    land.setAttribute('stroke-width', '.6');
    svg.append(land);
    for (const layer of spec.layers as Array<Record<string, unknown>>) {
      if (layer.kind === 'graticule') {
        const node = document.createElementNS(svg.namespaceURI, 'path');
        node.setAttribute('d', path(geoGraticule10()) ?? '');
        node.setAttribute('fill', 'none');
        node.setAttribute('stroke', '#cbd5e1');
        svg.append(node);
      } else if (layer.kind === 'path') {
        const node = document.createElementNS(svg.namespaceURI, 'path');
        node.setAttribute(
          'd',
          path({ type: 'LineString', coordinates: layer.coordinates } as never) ?? '',
        );
        node.setAttribute('fill', 'none');
        node.setAttribute('stroke', color(layer.colorToken));
        node.setAttribute('stroke-width', '3');
        svg.append(node);
      } else if (layer.kind === 'points') {
        for (const point of layer.points as Array<Record<string, unknown>>) {
          const coordinates = projection(point.coordinates as [number, number]);
          if (!coordinates) continue;
          const node = document.createElementNS(svg.namespaceURI, 'circle');
          node.setAttribute('cx', String(coordinates[0]));
          node.setAttribute('cy', String(coordinates[1]));
          node.setAttribute('r', '6');
          node.setAttribute('fill', color(point.colorToken));
          const title = document.createElementNS(svg.namespaceURI, 'title');
          title.textContent = String(point.label);
          node.append(title);
          svg.append(node);
        }
      }
    }
  };
  const dispatch = (detail: Record<string, unknown>) => {
    render();
    target.dispatchEvent(new CustomEvent('reach-science-kit-change', { detail }));
  };
  const changeScale = (scale: number) => {
    const bounded = Math.max(initialScale * 0.65, Math.min(initialScale * 2.5, scale));
    projection.scale(bounded);
    dispatch({ kind: 'zoom', scale: bounded });
  };
  const moveProjection = (deltaX: number, deltaY: number) => {
    if (interaction.rotate) {
      rotation = [
        rotation[0] + deltaX * 0.35,
        Math.max(-80, Math.min(80, rotation[1] - deltaY * 0.35)),
        rotation[2],
      ];
      projection.rotate(rotation);
      dispatch({ kind: 'rotation', rotation: [...rotation] });
    } else if (interaction.pan) {
      center = [center[0] - deltaX * 0.25, Math.max(-80, Math.min(80, center[1] + deltaY * 0.25))];
      projection.center(center);
      dispatch({ kind: 'pan', center: [...center] });
    }
  };

  svg.style.cursor = interaction.pan || interaction.rotate ? 'grab' : 'default';
  svg.style.touchAction = interaction.pan || interaction.rotate ? 'none' : 'auto';
  if (interaction.pan || interaction.rotate) {
    svg.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      drag = { x: event.clientX, y: event.clientY };
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
    });
    svg.addEventListener('pointermove', (event) => {
      if (!drag) return;
      moveProjection(event.clientX - drag.x, event.clientY - drag.y);
      drag = { x: event.clientX, y: event.clientY };
    });
    const endDrag = () => {
      drag = undefined;
      svg.style.cursor = 'grab';
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
  }
  if (interaction.zoom) {
    svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        changeScale(projection.scale() * Math.exp(-event.deltaY * 0.001));
      },
      { passive: false },
    );
  }
  svg.addEventListener('keydown', (event) => {
    const move = {
      ArrowLeft: [-12, 0],
      ArrowRight: [12, 0],
      ArrowUp: [0, -12],
      ArrowDown: [0, 12],
    }[event.key];
    if (move !== undefined && (interaction.pan || interaction.rotate)) {
      event.preventDefault();
      moveProjection(move[0], move[1]);
    } else if ((event.key === '+' || event.key === '=') && interaction.zoom) {
      event.preventDefault();
      changeScale(projection.scale() * 1.12);
    } else if (event.key === '-' && interaction.zoom) {
      event.preventDefault();
      changeScale(projection.scale() / 1.12);
    }
  });

  const reset = () => {
    center = [...initialCenter];
    rotation = [...initialRotation];
    projection.center(center).rotate(rotation).scale(initialScale);
    render();
  };
  render();
  return frozenController(
    reset,
    () => target.replaceChildren(),
    (): GeoState => ({ center: [...center], rotation: [...rotation], scale: projection.scale() }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const candidate = state as Partial<GeoState>;
      if (
        !Array.isArray(candidate.center) ||
        candidate.center.length !== 2 ||
        !candidate.center.every(Number.isFinite) ||
        !Array.isArray(candidate.rotation) ||
        candidate.rotation.length !== 3 ||
        !candidate.rotation.every(Number.isFinite) ||
        !Number.isFinite(candidate.scale) ||
        candidate.scale! < initialScale * 0.65 ||
        candidate.scale! > initialScale * 2.5
      )
        return false;
      center = [...candidate.center] as [number, number];
      rotation = [...candidate.rotation] as [number, number, number];
      projection.center(center).rotate(rotation).scale(candidate.scale!);
      render();
      return true;
    },
  );
});
