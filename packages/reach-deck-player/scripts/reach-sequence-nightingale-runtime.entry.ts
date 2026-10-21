import NightingaleSequence from '@nightingale-elements/nightingale-sequence';

import { fillTarget, frozenController, registerScienceKit } from './science-kit-runtime.shared';

const MINIMUM_ZOOM = 1;
const MAXIMUM_ZOOM = 4;
const ZOOM_STEP = 0.25;

type SequenceState = { zoom: number; scrollLeft: number; selectedFeatureIds: string[] };

registerScienceKit('sequence-nightingale', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const interaction = spec.interaction as { zoom: boolean; pan: boolean; selectable: boolean };
  const sequenceValue = String(spec.sequence);
  const tracks = spec.tracks as Array<Record<string, unknown>>;
  const featureIds = new Set(
    tracks.flatMap((track) =>
      (track.features as Array<Record<string, unknown>>).map((feature) => String(feature.id)),
    ),
  );
  const selectedFeatureIds = new Set<string>();
  const initialZoom = interaction.zoom ? 1.5 : 1;
  let zoom = initialZoom;
  let resizeFrame = 0;
  let drag: { pointerId: number; startX: number; startScrollLeft: number } | undefined;

  const shell = document.createElement('div');
  Object.assign(shell.style, {
    display: 'grid',
    gridTemplateRows: interaction.zoom ? '52px minmax(0, 1fr)' : 'minmax(0, 1fr)',
    width: '100%',
    height: '100%',
    minHeight: '0',
  });
  const toolbar = document.createElement('div');
  Object.assign(toolbar.style, {
    display: interaction.zoom ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '4px 12px',
    borderBottom: '1px solid #e2e8f0',
  });
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.textContent = '-';
  zoomOut.title = 'Zoom out';
  zoomOut.setAttribute('aria-label', 'Zoom out');
  zoomOut.setAttribute('data-reach-sequence-zoom-out', '');
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.textContent = '+';
  zoomIn.title = 'Zoom in';
  zoomIn.setAttribute('aria-label', 'Zoom in');
  zoomIn.setAttribute('data-reach-sequence-zoom-in', '');
  for (const button of [zoomOut, zoomIn]) {
    Object.assign(button.style, {
      width: '44px',
      height: '44px',
      border: '1px solid #cbd5e1',
      background: '#ffffff',
      color: '#172033',
      fontSize: '20px',
      lineHeight: '1',
      cursor: 'pointer',
    });
  }
  toolbar.append(zoomOut, zoomIn);

  const viewport = document.createElement('div');
  viewport.setAttribute('data-reach-sequence-viewport', '');
  viewport.setAttribute('tabindex', interaction.pan ? '0' : '-1');
  viewport.setAttribute('aria-label', String(spec.ariaLabel));
  Object.assign(viewport.style, {
    width: '100%',
    height: '100%',
    minHeight: '0',
    overflowX: interaction.pan ? 'auto' : 'hidden',
    overflowY: 'hidden',
    cursor: interaction.pan ? 'grab' : 'default',
    touchAction: interaction.pan ? 'none' : 'auto',
    overscrollBehavior: 'contain',
  });
  const content = document.createElement('div');
  content.setAttribute('data-reach-sequence-content', '');
  Object.assign(content.style, {
    minHeight: '100%',
    padding: '8px 16px 12px',
    boxSizing: 'border-box',
  });
  viewport.append(content);
  shell.append(toolbar, viewport);
  target.append(shell);

  const dispatch = (detail: Record<string, unknown>) => {
    target.dispatchEvent(new CustomEvent('reach-science-kit-change', { detail }));
  };
  const updateDiagnostics = () => {
    target.dataset.reachScienceKitSequenceZoom = String(zoom);
    target.dataset.reachScienceKitSequenceScrollLeft = String(Math.round(viewport.scrollLeft));
    target.dataset.reachScienceKitSelectedFeatures = [...selectedFeatureIds].join(',');
  };
  const contentWidth = () => {
    const minimum = interaction.pan || interaction.zoom ? 640 : viewport.clientWidth;
    return Math.max(viewport.clientWidth, minimum) * zoom;
  };
  const render = (restoredScrollLeft?: number) => {
    const previousMaximum = Math.max(1, content.scrollWidth - viewport.clientWidth);
    const scrollRatio = viewport.scrollLeft / previousMaximum;
    content.replaceChildren();
    content.style.width = `${contentWidth()}px`;

    const sequence = new NightingaleSequence();
    sequence.setAttribute('sequence', sequenceValue);
    sequence.setAttribute('length', String(sequenceValue.length));
    sequence.setAttribute('display-start', '1');
    sequence.setAttribute('display-end', String(sequenceValue.length));
    sequence.setAttribute('width', String(Math.max(320, contentWidth() - 32)));
    sequence.setAttribute('height', '84');
    sequence.setAttribute('aria-label', String(spec.ariaLabel));
    content.append(sequence);

    for (const track of tracks) {
      const row = document.createElement('div');
      row.setAttribute('role', 'list');
      row.style.position = 'relative';
      row.style.height = '44px';
      row.style.margin = '8px 0';
      row.style.background = '#f1f5f9';
      row.setAttribute('aria-label', String(track.label));
      for (const feature of track.features as Array<Record<string, unknown>>) {
        const start = Number(feature.start ?? feature.position);
        const end = Number(feature.end ?? feature.position);
        const featureId = String(feature.id);
        const node = document.createElement(interaction.selectable ? 'button' : 'div');
        node.textContent = String(feature.label);
        node.title = String(feature.label);
        node.setAttribute('data-reach-sequence-feature', featureId);
        Object.assign((node as HTMLElement).style, {
          position: 'absolute',
          left: `${((start - 1) / sequenceValue.length) * 100}%`,
          width: `${Math.max(0.8, ((end - start + 1) / sequenceValue.length) * 100)}%`,
          minWidth: '44px',
          height: '100%',
          border: selectedFeatureIds.has(featureId) ? '3px solid #f59e0b' : '0',
          background: selectedFeatureIds.has(featureId) ? '#15803d' : '#2563eb',
          color: 'white',
          overflow: 'hidden',
          cursor: interaction.selectable ? 'pointer' : 'default',
          boxSizing: 'border-box',
        });
        if (node instanceof HTMLButtonElement) {
          node.type = 'button';
          node.setAttribute('aria-pressed', String(selectedFeatureIds.has(featureId)));
          node.addEventListener('click', () => {
            selectedFeatureIds.add(featureId);
            updateDiagnostics();
            render();
            dispatch({
              kind: 'feature-selected',
              trackId: track.id,
              featureId,
              start,
              end,
              selectedFeatureIds: [...selectedFeatureIds],
            });
          });
        }
        row.append(node);
      }
      content.append(row);
    }
    if (restoredScrollLeft !== undefined) {
      viewport.scrollLeft = restoredScrollLeft;
      updateDiagnostics();
    }
    requestAnimationFrame(() => {
      const nextMaximum = Math.max(0, content.scrollWidth - viewport.clientWidth);
      viewport.scrollLeft = restoredScrollLeft ?? scrollRatio * nextMaximum;
      updateDiagnostics();
    });
  };
  const setZoom = (nextZoom: number) => {
    if (!interaction.zoom) return;
    const bounded = Math.max(MINIMUM_ZOOM, Math.min(MAXIMUM_ZOOM, nextZoom));
    if (bounded === zoom) return;
    zoom = bounded;
    render();
    dispatch({ kind: 'zoom', zoom });
  };
  zoomIn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  zoomOut.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  if (interaction.pan) {
    viewport.addEventListener('pointerdown', (event) => {
      if ((event.target as Element).closest('button')) return;
      event.preventDefault();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: viewport.scrollLeft,
      };
      viewport.setPointerCapture(event.pointerId);
      viewport.style.cursor = 'grabbing';
    });
    viewport.addEventListener('pointermove', (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      viewport.scrollLeft = drag.startScrollLeft - (event.clientX - drag.startX);
      updateDiagnostics();
      dispatch({ kind: 'pan', scrollLeft: viewport.scrollLeft, zoom });
    });
    const endDrag = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = undefined;
      viewport.style.cursor = 'grab';
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      viewport.scrollLeft += event.key === 'ArrowRight' ? 80 : -80;
      updateDiagnostics();
      dispatch({ kind: 'pan', scrollLeft: viewport.scrollLeft, zoom });
    });
  }
  viewport.addEventListener('scroll', updateDiagnostics, { passive: true });
  const resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(render);
  });
  resizeObserver.observe(target);
  render();

  return frozenController(
    () => {
      zoom = initialZoom;
      selectedFeatureIds.clear();
      viewport.scrollLeft = 0;
      render();
    },
    () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      target.replaceChildren();
    },
    (): SequenceState => ({
      zoom,
      scrollLeft: viewport.scrollLeft,
      selectedFeatureIds: [...selectedFeatureIds],
    }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const candidate = state as Partial<SequenceState>;
      if (
        !Number.isFinite(candidate.zoom) ||
        candidate.zoom! < MINIMUM_ZOOM ||
        candidate.zoom! > MAXIMUM_ZOOM ||
        !Number.isFinite(candidate.scrollLeft) ||
        candidate.scrollLeft! < 0 ||
        !Array.isArray(candidate.selectedFeatureIds) ||
        !candidate.selectedFeatureIds.every((id) => typeof id === 'string' && featureIds.has(id))
      )
        return false;
      zoom = interaction.zoom ? candidate.zoom! : initialZoom;
      selectedFeatureIds.clear();
      if (interaction.selectable) {
        for (const featureId of candidate.selectedFeatureIds) selectedFeatureIds.add(featureId);
      }
      render(candidate.scrollLeft!);
      return true;
    },
  );
});
