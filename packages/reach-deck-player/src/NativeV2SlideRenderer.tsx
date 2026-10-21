'use client';

import { useMediaStallRecovery } from './useMediaStallRecovery.js';

import type {
  ImgHTMLAttributes,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  parseReachDeckNativeSlideV2,
  resolveNativeV2PlaybackStates,
  type NativeV2ElementPlaybackState,
  type ReachDeckCategoricalChartElementV2,
  type ReachDeckColorV2,
  type ReachDeckEffectsV2,
  type ReachDeckElementStyleV2,
  type ReachDeckFillV2,
  type ReachDeckGeometryV2,
  type ReachDeckGeometrySubpathV2,
  type ReachDeckNativeElementV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckStrokeV2,
  type ReachDeckTextFrameV2,
  type ReachDeckTransformV2,
} from '@reachany/reach-deck-dsl';

import { AnimatedGif } from './AnimatedGif.js';
import { NativeV2Media } from './NativeV2Media.js';
import { NativeV2TextFrame } from './NativeV2TextFrame.js';
import {
  ScientificVisualPlayer,
  type ScientificVisualResourceResolver,
} from './ScientificVisualPlayer.js';
import {
  NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES,
  isSvgPathPresetGeometry,
  presetGeometrySvgPath,
  roundRectCornerRadius,
} from './nativeV2PresetGeometry.js';
import {
  collectSnapLines,
  snapMovingBox,
  snapRotation,
  roundedStageValue,
  EMPTY_GUIDES,
  type AlignmentGuides,
} from './canvasSnapping.js';
import { resolveReachScientificDependency } from './scientificDependencyRegistry.generated.js';

export interface NativeV2SlideRendererProps {
  slide: ReachDeckNativeSlideV2;
  stage: { width: number; height: number };
  resourceUrlsById: Readonly<Record<string, string>>;
  mediaScopeKey?: string;
  onMediaError?: (resourceId: string, failedSrc: string) => void;
  onMediaLoaded?: (resourceId: string, src: string) => void;
  onMediaPlayingChange?: (resourceId: string, playing: boolean) => void;
  resourceMimeTypesById?: Readonly<Record<string, string>>;
  trustedAnimatedGifResourceIds?: ReadonlySet<string>;
  animationControlLabel?: (action: 'play' | 'pause' | 'unavailable') => string;
  themeColors?: Readonly<Record<string, string>>;
  className?: string;
  /** 限制画布宽度并水平居中，不改变舞台坐标系。 */
  maxWidth?: number;
  /** Fit the viewport while keeping the outer renderer available for host measurement. */
  viewportMaxWidth?: number;
  selectedElementId?: string;
  onElementSelect?: (elementId: string | undefined) => void;
  /**
   * Enables direct canvas manipulation (drag / corner resize / rotate) of the
   * selected top-level element, matching the native editor transform overlay.
   */
  onElementTransformChange?: (elementId: string, transform: ReachDeckTransformV2) => void;
  onElementTransformStart?: (elementId: string) => void;
  onElementTransformEnd?: (elementId: string) => void;
  /** Double-click on the selected element's overlay (text-bearing elements only). */
  onTextFrameDoubleClick?: (elementId: string, cellId?: string) => void;
  /** Double-click on native stage background, reported in unscaled stage coordinates. */
  onBlankCanvasDoubleClick?: (point: { x: number; y: number }) => void;
  /** Element currently in inline text editing; its overlay hides and content is swapped. */
  editingElementId?: string;
  editingCellId?: string;
  /** Host-supplied inline editor rendered inside the editing element's text frame. */
  renderEditingTextFrame?: (
    element: Extract<ReachDeckNativeElementV2, { type: 'shape' | 'textFrame' | 'table' }>,
  ) => ReactNode;
  /** Hide the read-only fidelity diagnostics panel (e.g. in thumbnails). */
  hideDiagnostics?: boolean;
  /** Host-localized accessible label for standalone audio controls. */
  audioControlLabel?: (title: string) => string;
  /** Optional host-localized media labels; audioControlLabel remains supported. */
  mediaControlLabel?: (title: string, kind: 'audio' | 'video') => string;
  /** Render silent, noninteractive media placeholders (for thumbnails). */
  passiveMedia?: boolean;
  /**
   * 播放头时刻（秒）。提供时按页动画时间轴推导各元素的可见性 / 透明度 / 变换
   * （"讲到即出现"的入场动画运行时）；缺省时渲染静态终态（编辑器画布、缩略图）。
   */
  currentTime?: number;
  playing?: boolean;
  playbackRate?: number;
  effectiveDuration?: number;
  activeNarrationSegmentId?: string;
  scientificStaticMode?: boolean;
  reducedMotion?: boolean;
  scientificSourceRevision?: number;
  scientificDependencyBaseUrl?: string;
  resolveScientificResource?: ScientificVisualResourceResolver;
  /**
   * 宿主叠加层：渲染在舞台坐标系内（随舞台一起缩放），位于所有元素与变换框之上；
   * 容器不接收指针事件，内部需要交互的节点自行开启。CSS 变量 `--native-v2-stage-scale`
   * 给出当前缩放比，便于宿主让徽标、描边保持屏幕尺寸。
   */
  stageOverlay?: ReactNode;
}

export type NativeV2RendererDiagnosticCode =
  | 'UNSUPPORTED_ELEMENT'
  | 'UNSUPPORTED_CUSTOM_GEOMETRY'
  | 'UNSUPPORTED_PRESET_GEOMETRY'
  | 'UNSUPPORTED_FILL'
  | 'UNSUPPORTED_STYLE'
  | 'UNSUPPORTED_LINE'
  | 'UNSUPPORTED_IMAGE_CROP'
  | 'UNSUPPORTED_TEXT_AUTOFIT'
  | 'UNSUPPORTED_TEXT_ALIGNMENT'
  | 'UNRESOLVED_RESOURCE'
  | 'UNRESOLVED_THEME_COLOR'
  | 'UNSUPPORTED_SCIENTIFIC_DEPENDENCY'
  | 'UNSUPPORTED_THEME_COLOR_MODIFIER'
  | 'UNSUPPORTED_ANIMATION'
  | 'UNSUPPORTED_TRANSITION';

export interface NativeV2RendererDiagnostic {
  code: NativeV2RendererDiagnosticCode;
  path: string;
  elementId?: string;
  message: string;
  /**
   * Advisory diagnostics record detail loss (stroke caps, autofit metadata)
   * while the element itself still renders faithfully. Only non-advisory
   * diagnostics replace the element with a visible read-only fallback.
   */
  advisory?: boolean;
}

/** Native-v2 renderer used by the document player and editing previews. */
export function NativeV2SlideRenderer({
  slide: inputSlide,
  stage,
  resourceUrlsById: latestResourceUrlsById,
  mediaScopeKey,
  onMediaError,
  onMediaLoaded,
  onMediaPlayingChange,
  resourceMimeTypesById,
  trustedAnimatedGifResourceIds,
  animationControlLabel = (action) => action,
  themeColors = {},
  className,
  maxWidth,
  viewportMaxWidth,
  selectedElementId,
  onElementSelect,
  onElementTransformChange,
  onElementTransformStart,
  onElementTransformEnd,
  onTextFrameDoubleClick,
  onBlankCanvasDoubleClick,
  editingElementId,
  editingCellId,
  renderEditingTextFrame,
  hideDiagnostics = false,
  audioControlLabel = (title) => title,
  mediaControlLabel,
  passiveMedia = false,
  currentTime,
  playing,
  playbackRate,
  effectiveDuration,
  activeNarrationSegmentId,
  scientificStaticMode = currentTime === undefined,
  reducedMotion = false,
  scientificSourceRevision,
  scientificDependencyBaseUrl,
  resolveScientificResource,
  stageOverlay,
}: NativeV2SlideRendererProps) {
  const retentionScope = (mediaScopeKey ?? '') + ':' + inputSlide.id;
  const [heldState, setHeldState] = useState<{ scope: string; urls: Record<string, string> }>({
    scope: retentionScope,
    urls: {},
  });
  const heldUrls = heldState.scope === retentionScope ? heldState.urls : {};
  const setHeldUrls = (update: (current: Record<string, string>) => Record<string, string>) =>
    setHeldState((current) => ({
      scope: retentionScope,
      urls: update(current.scope === retentionScope ? current.urls : {}),
    }));
  const playingResourcesRef = useRef(new Set<string>());
  const mediaPlayingCallbackRef = useRef(onMediaPlayingChange);
  mediaPlayingCallbackRef.current = onMediaPlayingChange;
  useEffect(
    () => () => {
      for (const id of playingResourcesRef.current) mediaPlayingCallbackRef.current?.(id, false);
      playingResourcesRef.current.clear();
    },
    [retentionScope],
  );
  const resourceUrlsById = Object.fromEntries(
    Object.entries(latestResourceUrlsById).map(([id, src]) => [
      id,
      onMediaError ? (heldUrls[id] ?? src) : src,
    ]),
  );
  const resourceFor = (target: EventTarget | null) => {
    if (!(target instanceof HTMLImageElement || target instanceof HTMLMediaElement)) return;
    const src = target.getAttribute('src') ?? target.currentSrc;
    const id = Object.keys(resourceUrlsById).find((id) => resourceUrlsById[id] === src);
    return id === undefined ? undefined : { id, src };
  };
  const release = (id: string) =>
    setHeldUrls((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  const stallRecovery = useMediaStallRecovery(
    (media) => {
      if (!onMediaError) return;
      const resource = resourceFor(media);
      if (!resource) return;
      release(resource.id);
      onMediaError?.(resource.id, resource.src);
    },
    retentionScope + JSON.stringify(resourceUrlsById),
  );
  const [activeMediaOverlay, setActiveMediaOverlay] = useState<string>();
  const slide = useMemo(() => parseReachDeckNativeSlideV2(inputSlide), [inputSlide]);
  const diagnostics = useMemo(
    () => collectNativeV2RendererDiagnosticsFromParsed(slide, resourceUrlsById, themeColors),
    [resourceUrlsById, slide, themeColors],
  );
  const playbackByElementId =
    currentTime === undefined ? undefined : resolveNativeV2PlaybackStates(slide, currentTime);
  const color = (value: ReachDeckColorV2) => resolveColor(value, themeColors);
  const background = fillBackground(slide.background, color);
  const backgroundImage =
    slide.background.kind === 'image'
      ? backgroundImageStyle(slide.background, resourceUrlsById)
      : undefined;
  // Fit the fixed-size stage into whichever responsive container hosts the renderer.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const update = () => {
      const width = viewport.clientWidth;
      setScale(width > 0 ? width / stage.width : 1);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [stage.width]);

  const transformCleanupRef = useRef<(() => void) | undefined>(undefined);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides>(EMPTY_GUIDES);
  useEffect(() => () => transformCleanupRef.current?.(), []);

  const toStagePoint = (clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (viewport === null) return { x: clientX, y: clientY };
    const bounds = viewport.getBoundingClientRect();
    const factor = viewport.clientWidth > 0 ? viewport.clientWidth / stage.width : 1;
    return { x: (clientX - bounds.left) / factor, y: (clientY - bounds.top) / factor };
  };

  const beginElementTransform = (
    event: ReactPointerEvent,
    element: ReachDeckNativeElementV2,
    mode: 'move' | 'resize' | 'rotate',
    corner?: NativeTransformCorner,
  ) => {
    if (onElementTransformChange === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    transformCleanupRef.current?.();
    onElementTransformStart?.(element.id);
    const start = toStagePoint(event.clientX, event.clientY);
    const initial = { ...element.transform };
    const center = { x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 };
    const initialPointerAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const snapLines = collectSnapLines(
      slide.elements.map((candidate) => ({ id: candidate.id, box: candidate.transform })),
      new Set([element.id]),
      stage.width,
      stage.height,
    );

    const move = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      const point = toStagePoint(pointerEvent.clientX, pointerEvent.clientY);
      let next: ReachDeckTransformV2;
      if (mode === 'move') {
        const maximumX = Math.max(0, stage.width - initial.width);
        const maximumY = Math.max(0, stage.height - initial.height);
        const clampX = (value: number) => Math.max(0, Math.min(maximumX, value));
        const clampY = (value: number) => Math.max(0, Math.min(maximumY, value));
        const rawX = clampX(initial.x + point.x - start.x);
        const rawY = clampY(initial.y + point.y - start.y);
        const snap = snapMovingBox(
          { x: rawX, y: rawY, width: initial.width, height: initial.height },
          snapLines,
        );
        setAlignmentGuides(snap.guides);
        next = {
          ...initial,
          x: roundedStageValue(clampX(rawX + snap.dx)),
          y: roundedStageValue(clampY(rawY + snap.dy)),
        };
      } else if (mode === 'resize' && corner !== undefined) {
        next = resizedTransform(initial, corner, point);
      } else {
        const nextPointerAngle = Math.atan2(point.y - center.y, point.x - center.x);
        const rawRotation =
          (initial.rotation ?? 0) + ((nextPointerAngle - initialPointerAngle) * 180) / Math.PI;
        const snap = snapRotation(rawRotation);
        setAlignmentGuides(
          snap.axis === 'horizontal'
            ? { vertical: [], horizontal: [center.y] }
            : snap.axis === 'vertical'
              ? { vertical: [center.x], horizontal: [] }
              : EMPTY_GUIDES,
        );
        next = { ...initial, rotation: snap.rotation };
      }
      onElementTransformChange(element.id, next);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      transformCleanupRef.current = undefined;
      setAlignmentGuides(EMPTY_GUIDES);
      onElementTransformEnd?.(element.id);
    };
    transformCleanupRef.current = finish;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  // Direct manipulation only targets top-level elements: children live in the
  // parent group's coordinate space, so their group moves as one unit. The
  // overlay yields entirely while its element is in inline text editing.
  const transformTarget =
    onElementTransformChange === undefined ||
    selectedElementId === undefined ||
    selectedElementId === editingElementId
      ? undefined
      : slide.elements.find((element) => element.id === selectedElementId);
  return (
    <section
      key={onMediaError ? retentionScope : undefined}
      className={className}
      data-native-v2-slide-id={slide.id}
      data-native-v2-slide-renderer
      onErrorCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.cancel(event.target);
        const resource = resourceFor(event.target);
        if (!resource) return;
        release(resource.id);
        onMediaError?.(resource.id, resource.src);
      }}
      onLoadCapture={(event) => {
        const resource = resourceFor(event.target);
        if (!resource) return;
        setHeldUrls((current) =>
          current[resource.id] === resource.src
            ? current
            : { ...current, [resource.id]: resource.src },
        );
        onMediaLoaded?.(resource.id, resource.src);
      }}
      onCanPlayCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.cancel(event.target);
        const resource = resourceFor(event.target);
        if (resource) onMediaLoaded?.(resource.id, resource.src);
      }}
      onPlayCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.cancel(event.target);
        const resource = resourceFor(event.target);
        if (!resource) return;
        setHeldUrls((current) => ({ ...current, [resource.id]: resource.src }));
        playingResourcesRef.current.add(resource.id);
        onMediaPlayingChange?.(resource.id, true);
      }}
      onPauseCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.cancel(event.target);
        const resource = resourceFor(event.target);
        if (!resource) return;
        release(resource.id);
        playingResourcesRef.current.delete(resource.id);
        onMediaPlayingChange?.(resource.id, false);
      }}
      onEndedCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.cancel(event.target);
        const resource = resourceFor(event.target);
        if (!resource) return;
        release(resource.id);
        onMediaPlayingChange?.(resource.id, false);
      }}
      onPlayingCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.cancel(event.target);
      }}
      onWaitingCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.arm(event.target);
      }}
      onStalledCapture={(event) => {
        if (event.target instanceof HTMLMediaElement) stallRecovery.arm(event.target);
      }}
      onClick={() => onElementSelect?.(undefined)}
      style={{ width: '100%', maxWidth, marginInline: maxWidth === undefined ? undefined : 'auto' }}
    >
      <div
        data-native-v2-viewport
        ref={viewportRef}
        style={{
          aspectRatio: `${stage.width} / ${stage.height}`,
          overflow: 'hidden',
          position: 'relative',
          width: '100%',
          maxWidth: viewportMaxWidth,
          marginInline: viewportMaxWidth === undefined ? undefined : 'auto',
        }}
      >
        <div
          aria-label={slide.title}
          data-native-v2-stage
          onDoubleClick={(event) => {
            if (onBlankCanvasDoubleClick === undefined || event.target !== event.currentTarget) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onBlankCanvasDoubleClick(toStagePoint(event.clientX, event.clientY));
          }}
          style={{
            background,
            ...backgroundImage,
            height: stage.height,
            left: 0,
            overflow: 'hidden',
            position: 'absolute',
            top: 0,
            transform: `scale(${scale})`,
            transformOrigin: 'left top',
            width: stage.width,
          }}
        >
          {slide.elements.map((element, index) =>
            renderElement({
              element,
              path: `$.elements[${index}]`,
              diagnostics,
              resourceUrlsById,
              resourceMimeTypesById,
              trustedAnimatedGifResourceIds,
              animationControlLabel,
              resolveColor: color,
              selectedElementId,
              onElementSelect,
              editingElementId,
              editingCellId,
              onTextFrameDoubleClick,
              renderEditingTextFrame,
              audioControlLabel,
              mediaControlLabel,
              passiveMedia,
              activeMediaOverlay,
              playbackByElementId,
              pptxTextCompat: slide.textCompatibility !== 'native',
              scientific: {
                slide,
                currentTime,
                playing,
                playbackRate,
                effectiveDuration,
                activeNarrationSegmentId,
                staticMode: scientificStaticMode,
                reducedMotion,
                sourceRevision: scientificSourceRevision,
                dependencyBaseUrl: scientificDependencyBaseUrl,
                resolveResource: resolveScientificResource,
                stageScale: scale,
              },
            }),
          )}
          {transformTarget === undefined ? null : (
            <div
              aria-label={`移动原生元素 ${transformTarget.id}`}
              className="deck-transform-overlay"
              data-native-v2-transform-overlay={transformTarget.id}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                if (transformTarget.type === 'table' && onTextFrameDoubleClick !== undefined) {
                  const cell = document
                    .elementsFromPoint(event.clientX, event.clientY)
                    .map((node) => node.closest('[data-native-v2-table-cell]'))
                    .find(
                      (node) =>
                        node
                          ?.closest('[data-native-v2-element-id]')
                          ?.getAttribute('data-native-v2-element-id') === transformTarget.id,
                    );
                  const cellId = cell?.getAttribute('data-native-v2-table-cell');
                  if (cellId) {
                    event.preventDefault();
                    event.stopPropagation();
                    onTextFrameDoubleClick(transformTarget.id, cellId);
                  }
                  return;
                }
                if (
                  onTextFrameDoubleClick === undefined ||
                  (transformTarget.type !== 'shape' && transformTarget.type !== 'textFrame') ||
                  transformTarget.text === undefined ||
                  (event.target as HTMLElement).closest(
                    '[data-resize-corner], [data-rotate-handle]',
                  ) !== null
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                onTextFrameDoubleClick(transformTarget.id);
              }}
              onKeyDown={(event) => {
                const delta = event.shiftKey ? 1 : 10;
                const offsets: Partial<Record<string, [number, number]>> = {
                  ArrowLeft: [-delta, 0],
                  ArrowRight: [delta, 0],
                  ArrowUp: [0, -delta],
                  ArrowDown: [0, delta],
                };
                const offset = offsets[event.key];
                if (offset === undefined || onElementTransformChange === undefined) return;
                event.preventDefault();
                const current = transformTarget.transform;
                onElementTransformChange(transformTarget.id, {
                  ...current,
                  x: Math.max(0, Math.min(stage.width - current.width, current.x + offset[0])),
                  y: Math.max(0, Math.min(stage.height - current.height, current.y + offset[1])),
                });
              }}
              onMouseEnter={() => setActiveMediaOverlay(transformTarget.id)}
              onMouseLeave={() => setActiveMediaOverlay(undefined)}
              onFocus={() => setActiveMediaOverlay(transformTarget.id)}
              onBlur={() => setActiveMediaOverlay(undefined)}
              onPointerDown={(event) => beginElementTransform(event, transformTarget, 'move')}
              role="button"
              style={{
                ...elementBoxStyle(transformTarget.transform, 10_000 + transformTarget.zIndex),
                opacity: undefined,
              }}
              tabIndex={0}
            >
              {supportsCornerResize(transformTarget) ? (
                <>
                  {nativeTransformCorners.map((corner) => (
                    <span
                      aria-label={`从${corner}角缩放 ${transformTarget.id}`}
                      className={`deck-transform-handle is-${corner}`}
                      data-resize-corner={corner}
                      key={corner}
                      onPointerDown={(event) =>
                        beginElementTransform(event, transformTarget, 'resize', corner)
                      }
                      role="button"
                      tabIndex={0}
                    />
                  ))}
                  <span className="deck-rotate-stem" />
                  <span
                    aria-label={`旋转 ${transformTarget.id}`}
                    className="deck-rotate-handle"
                    data-rotate-handle="true"
                    onPointerDown={(event) =>
                      beginElementTransform(event, transformTarget, 'rotate')
                    }
                    role="button"
                    tabIndex={0}
                  />
                </>
              ) : null}
            </div>
          )}
          {alignmentGuides.vertical.map((x) => (
            <span
              className="deck-align-guide is-vertical"
              data-deck-align-guide="vertical"
              key={`guide-v-${x}`}
              style={{ height: stage.height, left: x, position: 'absolute' }}
            />
          ))}
          {alignmentGuides.horizontal.map((y) => (
            <span
              className="deck-align-guide is-horizontal"
              data-deck-align-guide="horizontal"
              key={`guide-h-${y}`}
              style={{ position: 'absolute', top: y, width: stage.width }}
            />
          ))}
          {stageOverlay === undefined || stageOverlay === null ? null : (
            <div
              data-native-v2-stage-overlay
              style={
                {
                  '--native-v2-stage-scale': scale,
                  inset: 0,
                  pointerEvents: 'none',
                  position: 'absolute',
                  zIndex: STAGE_OVERLAY_Z_INDEX,
                } as CSSProperties
              }
            >
              {stageOverlay}
            </div>
          )}
        </div>
      </div>
      {hideDiagnostics || diagnostics.length === 0 ? null : (
        <DiagnosticPanel diagnostics={diagnostics} />
      )}
    </section>
  );
}

/** 宿主叠加层位于所有元素（含选中元素的 10_000 + zIndex 变换框）之上。 */
const STAGE_OVERLAY_Z_INDEX = 1_000_000;

export function collectNativeV2RendererDiagnostics({
  slide: inputSlide,
  resourceUrlsById,
  themeColors = {},
}: Pick<
  NativeV2SlideRendererProps,
  'slide' | 'resourceUrlsById' | 'themeColors'
>): NativeV2RendererDiagnostic[] {
  const slide = parseReachDeckNativeSlideV2(inputSlide);
  return collectNativeV2RendererDiagnosticsFromParsed(slide, resourceUrlsById, themeColors);
}

function collectNativeV2RendererDiagnosticsFromParsed(
  slide: ReachDeckNativeSlideV2,
  resourceUrlsById: Readonly<Record<string, string>>,
  themeColors: Readonly<Record<string, string>>,
): NativeV2RendererDiagnostic[] {
  const diagnostics: NativeV2RendererDiagnostic[] = [];
  if (slide.background.kind === 'image') {
    // Image backgrounds render via CSS background-image; only an unresolved
    // resource URL keeps the page from painting.
    if (!hasResolvedResource(resourceUrlsById, slide.background.resourceId)) {
      diagnostics.push({
        code: 'UNRESOLVED_RESOURCE',
        path: '$.background.resourceId',
        message: `Background resource ${slide.background.resourceId} has no explicit display URL.`,
      });
    }
  } else {
    collectFillDiagnostics(slide.background, '$.background', undefined, themeColors, diagnostics);
  }
  slide.elements.forEach((element, index) =>
    collectElementDiagnostics(
      element,
      `$.elements[${index}]`,
      resourceUrlsById,
      themeColors,
      diagnostics,
    ),
  );
  if (slide.transition !== undefined) {
    diagnostics.push({
      code: 'UNSUPPORTED_TRANSITION',
      path: '$.transition',
      message: `Transition ${slide.transition.type} is represented but not rendered.`,
    });
  }
  return diagnostics;
}

function renderElement(input: {
  element: ReachDeckNativeElementV2;
  path: string;
  diagnostics: NativeV2RendererDiagnostic[];
  resourceUrlsById: Readonly<Record<string, string>>;
  resourceMimeTypesById?: Readonly<Record<string, string>>;
  trustedAnimatedGifResourceIds?: ReadonlySet<string>;
  animationControlLabel?: (action: 'play' | 'pause' | 'unavailable') => string;
  resolveColor: (color: ReachDeckColorV2) => string | undefined;
  selectedElementId?: string;
  onElementSelect?: (elementId: string | undefined) => void;
  editingElementId?: string;
  editingCellId?: string;
  onTextFrameDoubleClick?: NativeV2SlideRendererProps['onTextFrameDoubleClick'];
  renderEditingTextFrame?: NativeV2SlideRendererProps['renderEditingTextFrame'];
  audioControlLabel: NonNullable<NativeV2SlideRendererProps['audioControlLabel']>;
  mediaControlLabel?: NativeV2SlideRendererProps['mediaControlLabel'];
  passiveMedia: boolean;
  activeMediaOverlay?: string;
  playbackByElementId?: ReadonlyMap<string, NativeV2ElementPlaybackState>;
  pptxTextCompat: boolean;
  /** 祖先组合累计镜像（翻转次数为奇数）时为 true，用于文字层的翻转补偿。 */
  ancestorMirrored?: boolean;
  scientific?: {
    slide: ReachDeckNativeSlideV2;
    currentTime?: number;
    playing?: boolean;
    playbackRate?: number;
    effectiveDuration?: number;
    activeNarrationSegmentId?: string;
    staticMode: boolean;
    reducedMotion: boolean;
    sourceRevision?: number;
    dependencyBaseUrl?: string;
    resolveResource?: ScientificVisualResourceResolver;
    stageScale: number;
  };
}): ReactNode {
  const {
    element,
    path,
    diagnostics,
    resourceUrlsById,
    resourceMimeTypesById,
    trustedAnimatedGifResourceIds,
    animationControlLabel,
    resolveColor,
    selectedElementId,
    onElementSelect,
    editingElementId,
    editingCellId,
    onTextFrameDoubleClick,
    renderEditingTextFrame,
    audioControlLabel,
    mediaControlLabel,
    passiveMedia,
    activeMediaOverlay,
    playbackByElementId,
    pptxTextCompat,
    ancestorMirrored = false,
    scientific,
  } = input;
  const playback = playbackByElementId?.get(element.id);
  const mirrored = isMirrored(element.transform, ancestorMirrored);
  /** 元素盒样式 + 播放态叠加：透明度相乘、transform 片段串接。 */
  const playbackBoxStyle = (
    transform: ReachDeckTransformV2,
    zIndex: number,
    opacity = 1,
  ): CSSProperties => applyElementPlayback(elementBoxStyle(transform, zIndex, opacity), playback);
  const directDiagnostics = diagnostics.filter(
    (diagnostic) =>
      diagnostic.advisory !== true &&
      (diagnostic.path === path ||
        (diagnostic.path.startsWith(`${path}.`) &&
          !diagnostic.path.startsWith(`${path}.children[`))),
  );
  if (element.hidden) return null;
  const unresolvedShapeImageFill =
    element.type === 'shape' &&
    element.style.fill?.kind === 'image' &&
    directDiagnostics.length > 0 &&
    directDiagnostics.every((diagnostic) => diagnostic.code === 'UNRESOLVED_RESOURCE');
  if (directDiagnostics.length > 0 && !unresolvedShapeImageFill) {
    return <ElementDiagnostic diagnostics={directDiagnostics} element={element} key={element.id} />;
  }
  switch (element.type) {
    case 'shape': {
      const geometry = element.geometry;
      const svgGeometry =
        geometry.kind === 'custom'
          ? {
              source: 'custom' as const,
              viewBox: geometry.viewBox,
              path: geometry.path,
              subpaths: geometry.subpaths ?? [{ path: geometry.path }],
            }
          : shapePresetSvgGeometry(geometry, element.transform);
      return (
        <div
          aria-label={element.ariaLabel}
          data-native-v2-element-id={element.id}
          data-native-v2-preset={element.geometry.kind === 'preset' ? element.geometry.preset : ''}
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
            // SVG geometry paints fill/stroke through its path; the CSS box
            // style would double-draw a rectangular background behind it.
            ...(svgGeometry === undefined
              ? shapeStyle(element.style, resolveColor, element.transform, resourceUrlsById)
              : {}),
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            outlineOffset: selectedElementId === element.id ? 2 : undefined,
            borderRadius: shapeBorderRadius(geometry, element.transform),
          }}
        >
          {unresolvedShapeImageFill ? (
            <ImageFillPlaceholder
              elementId={element.id}
              geometry={svgGeometry}
              borderRadius={shapeBorderRadius(geometry, element.transform)}
            />
          ) : null}
          {svgGeometry === undefined ? null : (
            <GeometrySvg
              elementId={element.id}
              geometry={svgGeometry}
              resolveColor={resolveColor}
              resourceUrlsById={resourceUrlsById}
              style={element.style}
              transform={element.transform}
            />
          )}
          {element.text === undefined ? null : (
            <div
              style={{
                position: 'relative',
                height: '100%',
                width: '100%',
                transform: textFlipCompensation(mirrored),
              }}
            >
              <NativeV2TextFrame
                animationTextColor={playback?.textColor}
                text={element.text}
                pptxTextCompat={pptxTextCompat}
              >
                {element.id === editingElementId && renderEditingTextFrame !== undefined
                  ? renderEditingTextFrame(element)
                  : undefined}
              </NativeV2TextFrame>
            </div>
          )}
        </div>
      );
    }
    case 'textFrame':
      return (
        <div
          aria-label={element.ariaLabel}
          data-native-v2-element-id={element.id}
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
            ...(element.style === undefined
              ? {}
              : shapeStyle(
                  element.fillSizing === 'content'
                    ? { ...element.style, fill: { kind: 'none' } }
                    : element.style,
                  resolveColor,
                  element.transform,
                  resourceUrlsById,
                )),
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            outlineOffset: selectedElementId === element.id ? 2 : undefined,
          }}
        >
          <NativeV2TextFrame
            compensationTransform={textFlipCompensation(mirrored)}
            contentBackgroundStyle={
              element.fillSizing === 'content' && element.style?.fill !== undefined
                ? shapeStyle(
                    { fill: element.style.fill },
                    resolveColor,
                    element.transform,
                    resourceUrlsById,
                  )
                : undefined
            }
            animationTextColor={playback?.textColor}
            text={element.text}
            pptxTextCompat={pptxTextCompat}
          >
            {element.id === editingElementId && renderEditingTextFrame !== undefined
              ? renderEditingTextFrame(element)
              : undefined}
          </NativeV2TextFrame>
        </div>
      );
    case 'line': {
      const elbowPath = element.routing === 'elbow' ? elbowLinePath(element) : undefined;
      const lineBox = paddedLineBox(element.transform);
      return (
        <svg
          aria-label={element.ariaLabel}
          data-native-v2-element-id={element.id}
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          preserveAspectRatio="none"
          style={{
            ...playbackBoxStyle(lineBox.transform, element.zIndex, element.opacity),
            // Flat/thin line boxes would otherwise clip the stroke and arrow
            // markers that extend beyond the geometric bounding box.
            overflow: 'visible',
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
          }}
          viewBox={lineBox.viewBox}
        >
          <defs>
            {(['start', 'end'] as const).map((endpoint) => {
              const marker = element[endpoint].marker;
              if (!hasVisibleLineMarker(marker)) return null;
              const id = `native-v2-marker-${element.id}-${endpoint}`;
              const fill = resolveColor(element.stroke.fill);
              const { markerSize, markerAnchor } = element[endpoint];
              return (
                <marker
                  id={id}
                  key={id}
                  markerHeight={markerSize ?? 8}
                  markerUnits="strokeWidth"
                  markerWidth={markerSize ?? 8}
                  orient={endpoint === 'start' ? 'auto-start-reverse' : 'auto'}
                  refX={
                    markerAnchor === 'center'
                      ? 4
                      : markerAnchor === 'tip'
                        ? 7
                        : marker === 'oval' || marker === 'diamond'
                          ? 4
                          : 6.5
                  }
                  refY={4}
                  viewBox={markerSize === undefined ? '0 0 8 8' : '1 1 6 6'}
                >
                  {marker === 'oval' ? (
                    <circle cx={4} cy={4} fill={fill} r={3} />
                  ) : marker === 'diamond' ? (
                    <path d="M4 1 7 4 4 7 1 4Z" fill={fill} />
                  ) : (
                    <path d="M1 1 7 4 1 7Z" fill={fill} />
                  )}
                </marker>
              );
            })}
          </defs>
          {elbowPath === undefined ? (
            <line
              markerEnd={
                hasVisibleLineMarker(element.end.marker)
                  ? `url(#native-v2-marker-${element.id}-end)`
                  : undefined
              }
              markerStart={
                hasVisibleLineMarker(element.start.marker)
                  ? `url(#native-v2-marker-${element.id}-start)`
                  : undefined
              }
              stroke={resolveColor(element.stroke.fill)}
              strokeDasharray={lineDash(element.stroke)}
              strokeLinecap={lineCap(element.stroke.cap)}
              strokeLinejoin={element.stroke.join}
              strokeWidth={clampedStrokeWidth(element.stroke.width, element.transform)}
              x1={element.start.x}
              x2={element.end.x}
              y1={element.start.y}
              y2={element.end.y}
            />
          ) : (
            <path
              d={elbowPath}
              fill="none"
              markerEnd={
                hasVisibleLineMarker(element.end.marker)
                  ? `url(#native-v2-marker-${element.id}-end)`
                  : undefined
              }
              markerStart={
                hasVisibleLineMarker(element.start.marker)
                  ? `url(#native-v2-marker-${element.id}-start)`
                  : undefined
              }
              stroke={resolveColor(element.stroke.fill)}
              strokeDasharray={lineDash(element.stroke)}
              strokeLinecap={lineCap(element.stroke.cap)}
              strokeLinejoin={element.stroke.join}
              strokeWidth={clampedStrokeWidth(element.stroke.width, element.transform)}
            />
          )}
        </svg>
      );
    }
    case 'group':
      return (
        <div
          aria-label={element.ariaLabel}
          data-native-v2-element-id={element.id}
          data-native-v2-group
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
            filter: effectsFilter(element.effects, resolveColor),
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
          }}
        >
          {element.children.map((child, index) =>
            renderElement({
              element: child,
              path: `${path}.children[${index}]`,
              diagnostics,
              resourceUrlsById,
              resolveColor,
              selectedElementId,
              onElementSelect,
              audioControlLabel,
              mediaControlLabel,
              passiveMedia,
              activeMediaOverlay,
              playbackByElementId,
              pptxTextCompat,
              ancestorMirrored: mirrored,
              scientific,
              resourceMimeTypesById,
              trustedAnimatedGifResourceIds,
              animationControlLabel,
            }),
          )}
        </div>
      );
    case 'image': {
      const source = resourceUrlsById[element.resourceId];
      const crop = element.crop;
      const adjustments = (['brightness', 'contrast', 'saturate'] as const)
        .flatMap((name) => {
          const value = element.filters?.[name];
          return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10
            ? [`${name}(${value})`]
            : [];
        })
        .join(' ');
      const imageFilter =
        [adjustments, effectsFilter(element.effects, resolveColor)].filter(Boolean).join(' ') ||
        undefined;
      // PPT 图片边框(a:ln)与形状一致走 CSS border,border-box 保持帧尺寸。
      const imageStrokeStyle: CSSProperties =
        element.stroke === undefined
          ? {}
          : {
              borderColor: resolveColor(element.stroke.fill),
              borderStyle: shapeBorderStyle(element.stroke.dash),
              borderWidth: clampedStrokeWidth(element.stroke.width, element.transform),
              boxSizing: 'border-box',
            };
      if (
        source &&
        trustedAnimatedGifResourceIds?.has(element.resourceId) === true &&
        (resourceMimeTypesById?.[element.resourceId] === 'image/gif' ||
          /^data:image\/gif[;,]/i.test(source))
      ) {
        return (
          <AnimatedGif
            key={(scientific?.slide.id ?? 'slide') + ':' + element.id}
            src={source}
            alt={element.alt ?? ''}
            elementId={element.id}
            resourceId={element.resourceId}
            fit={element.fit}
            visible={playback?.visible !== false && (playback?.opacity ?? 1) > 0}
            playing={scientific?.playing === true}
            staticMode={scientific?.staticMode ?? true}
            reducedMotion={scientific?.reducedMotion ?? false}
            controlLabel={animationControlLabel ?? ((action) => action)}
            onClick={(event) => {
              event.stopPropagation();
              onElementSelect?.(element.id);
            }}
            style={{
              ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
              ...imageStrokeStyle,
              filter: imageFilter,
              overflow: 'hidden',
              outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            }}
          />
        );
      }
      if (crop !== undefined && element.fit === 'stretch') {
        // PPTX srcRect: the crop window of the source bitmap is stretched to
        // fill the element box. Oversize the img by the inverse of the visible
        // fraction and shift it so only the window remains inside the clip.
        const visibleWidth = Math.max(1 - crop.left - crop.right, 0.01);
        const visibleHeight = Math.max(1 - crop.top - crop.bottom, 0.01);
        return (
          <div
            data-native-v2-element-id={element.id}
            data-native-v2-resource-id={element.resourceId}
            key={element.id}
            onClick={(event) => {
              event.stopPropagation();
              onElementSelect?.(element.id);
            }}
            style={{
              ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
              ...imageStrokeStyle,
              overflow: 'hidden',
              // filter applies after the crop clip, so the shadow follows the
              // visible window instead of the oversized source bitmap.
              filter: imageFilter,
              outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            }}
          >
            <ResilientImage
              alt={element.alt}
              src={source}
              style={{
                position: 'absolute',
                width: `${(1 / visibleWidth) * 100}%`,
                height: `${(1 / visibleHeight) * 100}%`,
                left: `${-(crop.left / visibleWidth) * 100}%`,
                top: `${-(crop.top / visibleHeight) * 100}%`,
                maxWidth: 'none',
              }}
            />
          </div>
        );
      }
      return (
        <ResilientImage
          alt={element.alt}
          data-native-v2-element-id={element.id}
          data-native-v2-resource-id={element.resourceId}
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          src={source}
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
            ...imageStrokeStyle,
            objectFit: element.fit === 'stretch' ? 'fill' : element.fit,
            filter: imageFilter,
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
          }}
        />
      );
    }
    case 'table': {
      const totalWidth = element.columnWidths.reduce((sum, width) => sum + width, 0);
      const totalHeight = element.rowHeights.reduce((sum, height) => sum + height, 0);
      // The stored grid should span the frame; scaling keeps imported tables
      // whose row heights are PowerPoint minimums aligned with the box.
      const scaleX = totalWidth === 0 ? 1 : element.transform.width / totalWidth;
      const scaleY = totalHeight === 0 ? 1 : element.transform.height / totalHeight;
      const columnOffsets = [0];
      for (const width of element.columnWidths) {
        columnOffsets.push(columnOffsets[columnOffsets.length - 1]! + width);
      }
      const rowOffsets = [0];
      for (const height of element.rowHeights) {
        rowOffsets.push(rowOffsets[rowOffsets.length - 1]! + height);
      }
      const columnCount = element.columnWidths.length;
      const rowCount = element.rowHeights.length;
      const occupied = element.rowHeights.map(() => element.columnWidths.map(() => false));
      const cellNodes: ReactNode[] = [];
      element.rows.forEach((row, rowIndex) => {
        if (rowIndex >= rowCount) return;
        let column = 0;
        for (const cell of row.cells) {
          while (column < columnCount && occupied[rowIndex]![column]) column += 1;
          if (column >= columnCount) break;
          const columnSpan = Math.min(cell.columnSpan, columnCount - column);
          const rowSpan = Math.min(cell.rowSpan, rowCount - rowIndex);
          for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
            for (let c = column; c < column + columnSpan; c += 1) {
              occupied[r]![c] = true;
            }
          }
          const box = {
            x: columnOffsets[column]! * scaleX,
            y: rowOffsets[rowIndex]! * scaleY,
            width: (columnOffsets[column + columnSpan]! - columnOffsets[column]!) * scaleX,
            height: (rowOffsets[rowIndex + rowSpan]! - rowOffsets[rowIndex]!) * scaleY,
          };
          cellNodes.push(
            <div
              data-native-v2-table-cell={cell.id}
              key={cell.id}
              onDoubleClick={
                onTextFrameDoubleClick === undefined
                  ? undefined
                  : (event) => {
                      event.stopPropagation();
                      onTextFrameDoubleClick(element.id, cell.id);
                    }
              }
              style={{
                ...shapeStyle(
                  cell.style,
                  resolveColor,
                  { x: box.x, y: box.y, width: box.width, height: box.height },
                  resourceUrlsById,
                ),
                position: 'absolute',
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              }}
            >
              {element.id === editingElementId &&
              cell.id === editingCellId &&
              renderEditingTextFrame !== undefined ? (
                renderEditingTextFrame(element)
              ) : (
                <NativeV2TextFrame text={cell.text} pptxTextCompat={pptxTextCompat} />
              )}
            </div>,
          );
          column += columnSpan;
        }
      });
      return (
        <div
          aria-label={element.ariaLabel}
          data-native-v2-element-id={element.id}
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            outlineOffset: selectedElementId === element.id ? 2 : undefined,
          }}
        >
          {cellNodes}
        </div>
      );
    }
    case 'audio':
    case 'video': {
      return (
        <NativeV2Media
          key={element.id}
          element={element}
          source={resourceUrlsById[element.resourceId]}
          poster={
            element.type === 'video' && element.posterResourceId
              ? resourceUrlsById[element.posterResourceId]
              : undefined
          }
          label={
            mediaControlLabel?.(element.title, element.type) ??
            (element.type === 'audio' ? audioControlLabel(element.title) : element.title)
          }
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex, element.opacity),
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            outlineOffset: selectedElementId === element.id ? 2 : undefined,
          }}
          editable={onElementSelect !== undefined}
          passive={passiveMedia}
          autoplayAllowed={
            onElementSelect === undefined &&
            scientific?.currentTime !== undefined &&
            scientific.playing === true
          }
          overlayActive={activeMediaOverlay === element.id}
          onSelect={onElementSelect}
        />
      );
    }
    case 'scientificVisual': {
      if (scientific === undefined) {
        return (
          <ElementDiagnostic diagnostics={directDiagnostics} element={element} key={element.id} />
        );
      }
      return (
        <div
          data-native-v2-element-id={element.id}
          key={element.id}
          onClick={(event) => {
            event.stopPropagation();
            onElementSelect?.(element.id);
          }}
          style={{
            ...playbackBoxStyle(element.transform, element.zIndex),
            outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
            outlineOffset: selectedElementId === element.id ? 2 : undefined,
          }}
        >
          <ScientificVisualPlayer
            activeNarrationSegmentId={scientific.activeNarrationSegmentId}
            currentTime={scientific.currentTime}
            dependencyBaseUrl={scientific.dependencyBaseUrl}
            effectiveDuration={scientific.effectiveDuration}
            element={element}
            logicalHeight={element.transform.height}
            logicalWidth={element.transform.width}
            playbackRate={scientific.playbackRate}
            playing={scientific.playing}
            reducedMotion={scientific.reducedMotion}
            resolveResource={scientific.resolveResource}
            slide={scientific.slide}
            sourceRevision={scientific.sourceRevision}
            stageScale={scientific.stageScale}
            staticMode={scientific.staticMode}
          />
        </div>
      );
    }
    case 'chart':
      if (element.chartType === 'scatter' || element.chartType === 'bubble') {
        return (
          <ElementDiagnostic diagnostics={directDiagnostics} element={element} key={element.id} />
        );
      }
      if (element.chartType === 'unsupported') {
        return (
          <ElementDiagnostic diagnostics={directDiagnostics} element={element} key={element.id} />
        );
      }
      return (
        <CategoricalChart
          boxStyle={playbackBoxStyle(element.transform, element.zIndex, element.opacity)}
          element={element}
          key={element.id}
          onElementSelect={onElementSelect}
          resolveColor={resolveColor}
          selectedElementId={selectedElementId}
        />
      );
    case 'formula':
    case 'diagram':
      return (
        <ElementDiagnostic diagnostics={directDiagnostics} element={element} key={element.id} />
      );
  }
}

function collectElementDiagnostics(
  element: ReachDeckNativeElementV2,
  path: string,
  resourceUrlsById: Readonly<Record<string, string>>,
  themeColors: Readonly<Record<string, string>>,
  diagnostics: NativeV2RendererDiagnostic[],
): void {
  switch (element.type) {
    case 'shape':
      if (
        element.geometry.kind === 'preset' &&
        !supportedPresetGeometry.has(element.geometry.preset)
      ) {
        diagnostics.push({
          code: 'UNSUPPORTED_PRESET_GEOMETRY',
          path: `${path}.geometry`,
          elementId: element.id,
          message: `Preset geometry ${element.geometry.preset} is represented but not rendered.`,
        });
      }
      collectStyleDiagnostics(
        element.style,
        `${path}.style`,
        element.id,
        themeColors,
        diagnostics,
        // Custom geometry and SVG-path presets render through SVG, which
        // honours every stroke dash/cap/join the schema can express — unlike
        // the CSS border path.
        element.geometry.kind === 'custom' ||
          (element.geometry.kind === 'preset' && isSvgPathPresetGeometry(element.geometry.preset)),
        element.transform,
        resourceUrlsById,
      );
      if (element.text !== undefined) {
        collectTextDiagnostics(element.text, `${path}.text`, element.id, themeColors, diagnostics);
      }
      return;
    case 'textFrame':
      collectTextDiagnostics(element.text, `${path}.text`, element.id, themeColors, diagnostics);
      if (element.style !== undefined) {
        collectStyleDiagnostics(
          element.style,
          `${path}.style`,
          element.id,
          themeColors,
          diagnostics,
          false,
          element.transform,
          resourceUrlsById,
        );
      }
      return;
    case 'line':
      // Straight lines and elbow polylines render natively; only curved
      // routing still falls back to a straight segment.
      if (element.routing === 'curved') {
        diagnostics.push({
          code: 'UNSUPPORTED_LINE',
          path,
          elementId: element.id,
          message: `${element.routing} line routing is represented but not rendered.`,
        });
      }
      collectStrokeDiagnostics(
        element.stroke,
        `${path}.stroke`,
        element.id,
        themeColors,
        diagnostics,
        true,
        element.transform,
      );
      return;
    case 'group':
      if (element.effects !== undefined) {
        collectEffectsDiagnostics(
          element.effects,
          `${path}.effects`,
          element.id,
          themeColors,
          diagnostics,
        );
      }
      element.children.forEach((child, index) =>
        collectElementDiagnostics(
          child,
          `${path}.children[${index}]`,
          resourceUrlsById,
          themeColors,
          diagnostics,
        ),
      );
      return;
    case 'image':
      if (element.effects !== undefined) {
        collectEffectsDiagnostics(
          element.effects,
          `${path}.effects`,
          element.id,
          themeColors,
          diagnostics,
        );
      }
      if (element.crop !== undefined && element.fit !== 'stretch') {
        diagnostics.push({
          code: 'UNSUPPORTED_IMAGE_CROP',
          path: `${path}.crop`,
          elementId: element.id,
          message: `Image cropping with ${element.fit} fit is represented but not rendered.`,
        });
      }
      if (element.stroke !== undefined) {
        collectStrokeDiagnostics(
          element.stroke,
          `${path}.stroke`,
          element.id,
          themeColors,
          diagnostics,
          false,
          element.transform,
        );
      }
      if (!hasResolvedResource(resourceUrlsById, element.resourceId)) {
        diagnostics.push({
          code: 'UNRESOLVED_RESOURCE',
          path: `${path}.resourceId`,
          elementId: element.id,
          message: `Image resource ${element.resourceId} has no explicit display URL.`,
        });
      }
      return;
    case 'table':
      // Tables render natively; per-cell styles/text surface their own issues.
      element.rows.forEach((row, rowIndex) => {
        row.cells.forEach((cell, cellIndex) => {
          const cellPath = `${path}.rows[${rowIndex}].cells[${cellIndex}]`;
          collectStyleDiagnostics(
            cell.style,
            `${cellPath}.style`,
            element.id,
            themeColors,
            diagnostics,
            false,
            element.transform,
            resourceUrlsById,
          );
          collectTextDiagnostics(
            cell.text,
            `${cellPath}.text`,
            element.id,
            themeColors,
            diagnostics,
          );
        });
      });
      return;
    case 'audio':
    case 'video':
      if (!hasResolvedResource(resourceUrlsById, element.resourceId)) {
        diagnostics.push({
          code: 'UNRESOLVED_RESOURCE',
          path: `${path}.resourceId`,
          elementId: element.id,
          message: `${element.type === 'audio' ? 'Audio' : 'Video'} resource ${element.resourceId} has no explicit display URL.`,
        });
      }
      return;
    case 'scientificVisual':
      for (const dependency of element.manifest.dependencies) {
        if (
          resolveReachScientificDependency(
            dependency.id,
            dependency.version,
            element.manifest.hooksVersion,
          ) === undefined
        ) {
          diagnostics.push({
            code: 'UNSUPPORTED_SCIENTIFIC_DEPENDENCY',
            path: `${path}.manifest.dependencies`,
            elementId: element.id,
            message: `Scientific dependency ${dependency.id}@${dependency.version} is not approved.`,
          });
        }
      }
      return;
    case 'chart':
      if (
        element.chartType === 'scatter' ||
        element.chartType === 'bubble' ||
        element.chartType === 'unsupported'
      ) {
        diagnostics.push({
          code: 'UNSUPPORTED_ELEMENT',
          path,
          elementId: element.id,
          message:
            element.chartType === 'unsupported'
              ? `${element.sourceChartType} is retained as a read-only chart placeholder.`
              : `${element.chartType} chart is represented but not rendered.`,
        });
      }
      return;
    case 'formula':
    case 'diagram':
      diagnostics.push({
        code: 'UNSUPPORTED_ELEMENT',
        path,
        elementId: element.id,
        message: `${element.type} is represented but not rendered.`,
      });
  }
}

function collectTextDiagnostics(
  _text: ReachDeckTextFrameV2,
  _path: string,
  _elementId: string,
  _themeColors: Readonly<Record<string, string>>,
  _diagnostics: NativeV2RendererDiagnostic[],
): void {
  // resize-shape autofit renders adaptively: PowerPoint 导出时已把 ext 放大到
  // 容纳文本,渲染端配合 overflow: visible(与 PowerPoint 一致的不裁剪语义),
  // 浏览器排版差异不会截断内容,因此不再作为 advisory 上报。
  // The doc itself is the shared v1 rich-text contract and renders through the
  // shared renderer; there is no per-run resolution left to diagnose here.
}

function collectStyleDiagnostics(
  style: ReachDeckElementStyleV2,
  path: string,
  elementId: string,
  themeColors: Readonly<Record<string, string>>,
  diagnostics: NativeV2RendererDiagnostic[],
  svgRendered = false,
  transform?: ReachDeckTransformV2,
  resourceUrlsById?: Readonly<Record<string, string>>,
): void {
  if (style.fill !== undefined) {
    collectFillDiagnostics(
      style.fill,
      `${path}.fill`,
      elementId,
      themeColors,
      diagnostics,
      resourceUrlsById,
    );
  }
  if (style.stroke !== undefined) {
    collectStrokeDiagnostics(
      style.stroke,
      `${path}.stroke`,
      elementId,
      themeColors,
      diagnostics,
      svgRendered,
      transform,
    );
  }
  if (style.effects !== undefined) {
    collectEffectsDiagnostics(
      style.effects,
      `${path}.effects`,
      elementId,
      themeColors,
      diagnostics,
    );
  }
}

/**
 * Shadow/glow render natively (box-shadow or drop-shadow filters); only an
 * unresolvable effect color degrades, and then only as an advisory — the
 * element body always renders.
 */
function collectEffectsDiagnostics(
  effects: ReachDeckEffectsV2,
  path: string,
  elementId: string,
  themeColors: Readonly<Record<string, string>>,
  diagnostics: NativeV2RendererDiagnostic[],
): void {
  const entries = [
    ['shadow', effects.shadow?.color],
    ['glow', effects.glow?.color],
  ] as const;
  for (const [name, color] of entries) {
    if (color === undefined || color.kind !== 'theme') continue;
    if (
      color.tint !== undefined ||
      color.shade !== undefined ||
      !hasResolvedResource(themeColors, color.token)
    ) {
      diagnostics.push({
        advisory: true,
        code: 'UNSUPPORTED_STYLE',
        path: `${path}.${name}`,
        elementId,
        message: `Effect ${name} color could not be resolved; the ${name} is not rendered.`,
      });
    }
  }
}

function collectFillDiagnostics(
  fill: ReachDeckFillV2,
  path: string,
  elementId: string | undefined,
  themeColors: Readonly<Record<string, string>>,
  diagnostics: NativeV2RendererDiagnostic[],
  resourceUrlsById?: Readonly<Record<string, string>>,
): void {
  if (fill.kind === 'pattern') {
    diagnostics.push({
      code: 'UNSUPPORTED_FILL',
      path,
      ...(elementId === undefined ? {} : { elementId }),
      message: `${fill.kind} fill is represented but not rendered.`,
    });
    return;
  }
  if (fill.kind === 'image') {
    // Image fills render via CSS background-image or an SVG image clip; only
    // an unresolved resource URL keeps the fill from painting.
    if (!hasResolvedResource(resourceUrlsById ?? {}, fill.resourceId)) {
      diagnostics.push({
        code: 'UNRESOLVED_RESOURCE',
        path: `${path}.resourceId`,
        ...(elementId === undefined ? {} : { elementId }),
        message: `Fill resource ${fill.resourceId} has no explicit display URL.`,
      });
    }
    return;
  }
  if (fill.kind === 'solid') {
    collectColorDiagnostics(fill.color, `${path}.color`, elementId, themeColors, diagnostics);
  }
  if (fill.kind === 'gradient') {
    fill.stops.forEach((stop, index) =>
      collectColorDiagnostics(
        stop.color,
        `${path}.stops[${index}].color`,
        elementId,
        themeColors,
        diagnostics,
      ),
    );
  }
}

function collectStrokeDiagnostics(
  stroke: ReachDeckStrokeV2,
  path: string,
  elementId: string,
  themeColors: Readonly<Record<string, string>>,
  diagnostics: NativeV2RendererDiagnostic[],
  svgLine: boolean,
  transform?: ReachDeckTransformV2,
): void {
  collectColorDiagnostics(stroke.fill, `${path}.fill`, elementId, themeColors, diagnostics);
  if (transform !== undefined && clampedStrokeWidth(stroke.width, transform) !== stroke.width) {
    diagnostics.push({
      advisory: true,
      code: 'UNSUPPORTED_STYLE',
      path: `${path}.width`,
      elementId,
      message: `Stroke width ${stroke.width}pt exceeds the element bounds and is clamped at render time.`,
    });
  }
  if (!svgLine && stroke.dash !== undefined && !shapeDashStyles.has(stroke.dash)) {
    diagnostics.push({
      code: 'UNSUPPORTED_STYLE',
      path: `${path}.dash`,
      elementId,
      message: `Shape stroke dash ${stroke.dash} is represented but not rendered.`,
    });
  }
  if (!svgLine && (stroke.cap !== undefined || stroke.join !== undefined)) {
    diagnostics.push({
      advisory: true,
      code: 'UNSUPPORTED_STYLE',
      path,
      elementId,
      message: 'Shape stroke cap/join is represented but not rendered.',
    });
  }
}

function collectColorDiagnostics(
  color: ReachDeckColorV2,
  path: string,
  elementId: string | undefined,
  themeColors: Readonly<Record<string, string>>,
  diagnostics: NativeV2RendererDiagnostic[],
): void {
  if (color.kind !== 'theme') return;
  if (color.tint !== undefined || color.shade !== undefined) {
    diagnostics.push({
      code: 'UNSUPPORTED_THEME_COLOR_MODIFIER',
      path,
      ...(elementId === undefined ? {} : { elementId }),
      message: `Theme color ${color.token} tint/shade is represented but not rendered.`,
    });
    return;
  }
  if (!hasResolvedResource(themeColors, color.token)) {
    diagnostics.push({
      code: 'UNRESOLVED_THEME_COLOR',
      path,
      ...(elementId === undefined ? {} : { elementId }),
      message: `Theme color ${color.token} has no explicit color value.`,
    });
  }
}

function shapeStyle(
  style: ReachDeckElementStyleV2,
  resolveColorValue: (color: ReachDeckColorV2) => string | undefined,
  transform?: ReachDeckTransformV2,
  resourceUrlsById?: Readonly<Record<string, string>>,
): CSSProperties {
  const stroke = style.stroke;
  return {
    background:
      style.fill === undefined ? undefined : fillBackground(style.fill, resolveColorValue),
    ...(style.fill?.kind === 'image'
      ? (backgroundImageStyle(style.fill, resourceUrlsById, transform) ?? {})
      : {}),
    borderColor: stroke === undefined ? undefined : resolveColorValue(stroke.fill),
    borderStyle: stroke === undefined ? undefined : shapeBorderStyle(stroke.dash),
    borderWidth:
      stroke === undefined || transform === undefined
        ? stroke?.width
        : clampedStrokeWidth(stroke.width, transform),
    boxShadow: effectsBoxShadow(style.effects, resolveColorValue),
    boxSizing: 'border-box',
  };
}

/** PowerPoint 自身的线宽上限(pt);超过必是畸形数据。 */
const MAX_STROKE_WIDTH = 1584;

/**
 * Safety clamp for pathological stroke widths (e.g. documents written before
 * the group-space stroke-scaling fix): a stroke wider than the element box —
 * or PowerPoint's own 1584pt maximum — would paint over the whole page, so it
 * is capped at render time. Legitimate strokes are far below both limits.
 */
function clampedStrokeWidth(width: number, transform: ReachDeckTransformV2): number {
  const limit = Math.min(MAX_STROKE_WIDTH, Math.max(transform.width, transform.height, 1));
  return Math.min(width, limit);
}

const roundCss = (value: number) => Math.round(value * 1000) / 1000;

/**
 * DSL shadow angle is degrees clockwise from east with screen y growing
 * downward (the OOXML `dir` convention converted to degrees), so the CSS
 * offset is simply (cos·distance, sin·distance).
 */
function shadowOffset(shadow: NonNullable<ReachDeckEffectsV2['shadow']>): {
  dx: number;
  dy: number;
} {
  const radians = (shadow.angle * Math.PI) / 180;
  return {
    dx: roundCss(Math.cos(radians) * shadow.distance),
    dy: roundCss(Math.sin(radians) * shadow.distance),
  };
}

/** Shadow/glow as box-shadow layers for CSS-box rendered shapes and text frames. */
function effectsBoxShadow(
  effects: ReachDeckEffectsV2 | undefined,
  resolveColorValue: (color: ReachDeckColorV2) => string | undefined,
): string | undefined {
  if (effects === undefined) return undefined;
  const layers: string[] = [];
  if (effects.shadow !== undefined) {
    const color = resolveColorValue(effects.shadow.color);
    if (color !== undefined) {
      const { dx, dy } = shadowOffset(effects.shadow);
      layers.push(`${dx}px ${dy}px ${roundCss(effects.shadow.blur)}px ${color}`);
    }
  }
  if (effects.glow !== undefined) {
    const color = resolveColorValue(effects.glow.color);
    if (color !== undefined) {
      // 双层近似 PPT 光晕:实心内核 + 渐隐外缘。
      layers.push(`0 0 ${roundCss(effects.glow.radius)}px ${color}`);
      layers.push(`0 0 ${roundCss(effects.glow.radius * 2)}px ${color}`);
    }
  }
  return layers.length === 0 ? undefined : layers.join(', ');
}

/**
 * Shadow/glow as a drop-shadow filter chain for alpha-silhouette content:
 * SVG-path geometry, groups, and images.
 */
function effectsFilter(
  effects: ReachDeckEffectsV2 | undefined,
  resolveColorValue: (color: ReachDeckColorV2) => string | undefined,
): string | undefined {
  if (effects === undefined) return undefined;
  const parts: string[] = [];
  if (effects.shadow !== undefined) {
    const color = resolveColorValue(effects.shadow.color);
    if (color !== undefined) {
      const { dx, dy } = shadowOffset(effects.shadow);
      parts.push(`drop-shadow(${dx}px ${dy}px ${roundCss(effects.shadow.blur)}px ${color})`);
    }
  }
  if (effects.glow !== undefined) {
    const color = resolveColorValue(effects.glow.color);
    if (color !== undefined) {
      const radius = roundCss(effects.glow.radius);
      // 双层 drop-shadow 近似光晕的向外渐隐。
      parts.push(`drop-shadow(0 0 ${radius}px ${color})`);
      parts.push(`drop-shadow(0 0 ${radius}px ${color})`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

function fillBackground(
  fill: ReachDeckFillV2,
  resolveColorValue: (color: ReachDeckColorV2) => string | undefined,
): string | undefined {
  switch (fill.kind) {
    case 'none':
      return 'transparent';
    case 'solid':
      return resolveColorValue(fill.color);
    case 'gradient':
      return `${fill.gradientType === 'radial' ? 'radial-gradient(ellipse 50% 50% at center' : `linear-gradient(${fill.angle}deg`}, ${fill.stops
        .map((stop) => `${resolveColorValue(stop.color)} ${stop.offset * 100}%`)
        .join(', ')})`;
    case 'pattern':
    case 'image':
      return undefined;
  }
}

function backgroundImageStyle(
  fill: Extract<ReachDeckFillV2, { kind: 'image' }>,
  resourceUrlsById: Readonly<Record<string, string>> | undefined,
  box?: { width: number; height: number },
): CSSProperties | undefined {
  const url = resourceUrlsById?.[fill.resourceId];
  if (url === undefined) return undefined;
  const insets = fill.mode === 'stretch' ? fill.insets : undefined;
  if (insets !== undefined) {
    // PPT stretch fillRect:图片拉伸到盒子的内缩/出血子矩形;负偏移的出血
    // 部分被元素盒天然裁剪。位置优先用盒 px(对混合符号偏移也精确)。
    const { left, top, right, bottom } = insets;
    const position =
      box === undefined
        ? `${roundCss(left + right === 0 ? 0 : (left / (left + right)) * 100)}% ${roundCss(
            top + bottom === 0 ? 0 : (top / (top + bottom)) * 100,
          )}%`
        : `${roundCss(left * box.width)}px ${roundCss(top * box.height)}px`;
    return {
      backgroundImage: `url(${JSON.stringify(url)})`,
      backgroundSize: `${roundCss((1 - left - right) * 100)}% ${roundCss((1 - top - bottom) * 100)}%`,
      backgroundRepeat: 'no-repeat',
      backgroundPosition: position,
    };
  }
  return {
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize:
      fill.mode === 'tile' ? 'auto' : fill.mode === 'stretch' ? '100% 100%' : fill.mode,
    backgroundRepeat: fill.mode === 'tile' ? 'repeat' : 'no-repeat',
    // PPT 恒等平铺自左上角展开(a:tile algn="tl");其余模式居中。
    backgroundPosition: fill.mode === 'tile' ? 'left top' : 'center',
  };
}

function resolveColor(
  color: ReachDeckColorV2,
  themeColors: Readonly<Record<string, string>>,
): string | undefined {
  if (color.kind === 'theme') {
    if (color.tint !== undefined || color.shade !== undefined) return undefined;
    const resolved = themeColors[color.token];
    return resolved === undefined ? undefined : withAlpha(resolved, color.alpha);
  }
  return withAlpha(color.value, color.alpha);
}

function withAlpha(color: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha === 1) return color;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return color;
  return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${alpha})`;
}

/**
 * 把播放态叠加到元素盒样式上：不可见 → 透明度归零（保留布局与已加载资源，避免
 * 元素反复挂载）；可见 → 透明度相乘、播放 transform 片段接在几何 transform 之后。
 */
function applyElementPlayback(
  style: CSSProperties,
  playback: NativeV2ElementPlaybackState | undefined,
): CSSProperties {
  if (playback === undefined) return style;
  const baseOpacity = typeof style.opacity === 'number' ? style.opacity : 1;
  if (!playback.visible) {
    return { ...style, opacity: 0, pointerEvents: 'none', visibility: 'hidden' };
  }
  const transform =
    playback.transform === undefined
      ? style.transform
      : style.transform === undefined
        ? playback.transform
        : `${style.transform} ${playback.transform}`;
  return {
    ...style,
    opacity: baseOpacity * playback.opacity,
    ...(transform === undefined ? {} : { transform }),
  };
}

/** 自身翻转与祖先组合翻转合计为奇数次时，元素内容在屏幕上呈镜像。 */
function isMirrored(transform: ReachDeckTransformV2, ancestorMirrored: boolean): boolean {
  const ownMirrored = (transform.flipHorizontal ?? false) !== (transform.flipVertical ?? false);
  return ancestorMirrored !== ownMirrored;
}

/**
 * PowerPoint 的翻转只镜像形状几何，文字不镜像：水平翻转时文字照常，垂直翻转时
 * 文字转 180°。元素盒的 CSS scaleX/scaleY(-1) 会连文字一起镜像，所以镜像时给
 * 文字层再补一次 scaleX(-1)：水平翻转抵消回正读，垂直翻转合成为 180° 旋转。
 */
function textFlipCompensation(mirrored: boolean): string | undefined {
  return mirrored ? 'scaleX(-1)' : undefined;
}

function elementBoxStyle(
  transform: ReachDeckTransformV2,
  zIndex: number,
  opacity = 1,
): CSSProperties {
  const transforms = [
    transform.rotation === undefined ? undefined : `rotate(${transform.rotation}deg)`,
    transform.flipHorizontal ? 'scaleX(-1)' : undefined,
    transform.flipVertical ? 'scaleY(-1)' : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    height: transform.height,
    left: transform.x,
    opacity,
    position: 'absolute',
    top: transform.y,
    transform: transforms.length === 0 ? undefined : transforms.join(' '),
    transformOrigin: 'center',
    width: transform.width,
    zIndex,
  };
}

function lineDash(stroke: ReachDeckStrokeV2): string | undefined {
  switch (stroke.dash) {
    case undefined:
    case 'solid':
      return undefined;
    case 'dot':
      return '1 2';
    case 'dash':
      return '6 4';
    case 'dashDot':
      return '6 3 1 3';
    case 'longDash':
      return '12 4';
    case 'custom':
      return stroke.customDash?.join(' ');
  }
}

function shapeBorderStyle(dash: ReachDeckStrokeV2['dash']): CSSProperties['borderStyle'] {
  if (dash === 'dot') return 'dotted';
  if (dash === 'dash') return 'dashed';
  return 'solid';
}

function lineCap(cap: ReachDeckStrokeV2['cap']): 'butt' | 'round' | 'square' | undefined {
  return cap === 'flat' ? 'butt' : cap;
}

/**
 * Orthogonal polyline for elbow-routed lines: the vertical segment sits at
 * `bend` (default 1 = corner elbow) of the horizontal start→end travel.
 * Consecutive duplicate points collapse so markers keep a real end direction.
 */
/** 细线盒的最小可渲染边长与单侧补边(画布单位)。 */
const MIN_LINE_BOX_EXTENT = 1;
const THIN_LINE_BOX_PADDING = 1;

/**
 * 水平/竖直线的盒子在细轴上可能只有 0.01(导入器的零尺寸兜底)。Chromium 布局按
 * 1/64px 取整，盒高被取成 0 后整个 SVG 视口不渲染，overflow: visible 也救不回来。
 * 细轴两侧对称补边并同步平移 viewBox：线条坐标与 1:1 比例不变，盒中心不变，
 * 旋转/翻转/播放动画的 transformOrigin 仍然以原中心为准。
 */
function paddedLineBox(transform: ReachDeckTransformV2): {
  transform: ReachDeckTransformV2;
  viewBox: string;
} {
  const padX = transform.width < MIN_LINE_BOX_EXTENT ? THIN_LINE_BOX_PADDING : 0;
  const padY = transform.height < MIN_LINE_BOX_EXTENT ? THIN_LINE_BOX_PADDING : 0;
  const width = transform.width + 2 * padX;
  const height = transform.height + 2 * padY;
  return {
    transform: {
      ...transform,
      x: transform.x - padX,
      y: transform.y - padY,
      width,
      height,
    },
    viewBox: `${-padX} ${-padY} ${width} ${height}`,
  };
}

function elbowLinePath(element: {
  start: { x: number; y: number };
  end: { x: number; y: number };
  bend?: number;
}): string {
  const { start, end } = element;
  const bendX = start.x + (element.bend ?? 1) * (end.x - start.x);
  const points = [start, { x: bendX, y: start.y }, { x: bendX, y: end.y }, end].filter(
    (point, index, all) => {
      const previous = all[index - 1];
      return previous === undefined || previous.x !== point.x || previous.y !== point.y;
    },
  );
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function hasVisibleLineMarker(
  marker: 'none' | 'arrow' | 'diamond' | 'oval' | 'triangle' | undefined,
) {
  return marker !== undefined && marker !== 'none';
}

/**
 * CSS `linear-gradient` angle (0deg = bottom→top, clockwise) expressed as
 * objectBoundingBox endpoints so SVG paints the same direction.
 */
function gradientEndpoints(angleDegrees: number): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const radians = (angleDegrees * Math.PI) / 180;
  const dx = Math.sin(radians) / 2;
  const dy = -Math.cos(radians) / 2;
  const round3 = (value: number) => Math.round(value * 1000) / 1000;
  return {
    x1: round3(0.5 - dx),
    y1: round3(0.5 - dy),
    x2: round3(0.5 + dx),
    y2: round3(0.5 + dy),
  };
}

function GeometrySvg({
  elementId,
  geometry,
  style,
  resolveColor,
  resourceUrlsById,
  transform,
}: {
  elementId: string;
  geometry: ShapeSvgGeometry;
  style: ReachDeckElementStyleV2;
  resolveColor: (color: ReachDeckColorV2) => string | undefined;
  resourceUrlsById?: Readonly<Record<string, string>>;
  transform: ReachDeckTransformV2;
}) {
  const fill = geometry.subpaths.every((subpath) => subpath.fillMode === 'none')
    ? undefined
    : style.fill;
  const gradient = fill?.kind === 'gradient' ? fill : undefined;
  const gradientId = `native-v2-custom-fill-${elementId}`;
  const Gradient = gradient?.gradientType === 'radial' ? 'radialGradient' : 'linearGradient';
  const imageUrl =
    fill?.kind === 'image' ? (resourceUrlsById?.[fill.resourceId] ?? undefined) : undefined;
  const imageInsets =
    fill?.kind === 'image' && fill.mode === 'stretch'
      ? (fill.insets ?? { left: 0, top: 0, right: 0, bottom: 0 })
      : { left: 0, top: 0, right: 0, bottom: 0 };
  const imageClipId = `native-v2-image-clip-${elementId}`;
  const fillValue =
    fill === undefined || fill.kind === 'none'
      ? 'none'
      : fill.kind === 'solid'
        ? (resolveColor(fill.color) ?? 'none')
        : fill.kind === 'gradient'
          ? `url(#${gradientId})`
          : 'none';
  const stroke = style.stroke;
  const strokeColor = stroke === undefined ? undefined : resolveColor(stroke.fill);
  return (
    <svg
      aria-hidden="true"
      preserveAspectRatio="none"
      {...(geometry.source === 'custom'
        ? { 'data-native-v2-custom-geometry': '' }
        : { 'data-native-v2-preset-geometry': '' })}
      style={{
        display: 'block',
        filter: effectsFilter(style.effects, resolveColor),
        height: '100%',
        left: 0,
        // Strokes on paths touching the box edges may paint slightly outside.
        overflow: 'visible',
        pointerEvents: 'none',
        position: 'absolute',
        top: 0,
        width: '100%',
      }}
      viewBox={`0 0 ${geometry.viewBox.width} ${geometry.viewBox.height}`}
    >
      {gradient === undefined ? null : (
        <defs>
          <Gradient
            id={gradientId}
            {...(gradient.gradientType === 'radial'
              ? { cx: '50%', cy: '50%', r: '50%' }
              : gradientEndpoints(gradient.angle))}
          >
            {gradient.stops.map((stop, index) => (
              <stop
                key={index}
                offset={`${stop.offset * 100}%`}
                stopColor={resolveColor(stop.color) ?? 'transparent'}
              />
            ))}
          </Gradient>
        </defs>
      )}
      {imageUrl === undefined ? null : (
        // 图片填充:按几何路径裁剪、拉伸铺满 viewBox(对应 a:stretch 语义);
        // fillRect insets 直接换算为 viewBox 坐标(负值出血被 clipPath 裁掉)。
        <>
          <defs>
            <clipPath id={imageClipId}>
              <path d={geometry.path} />
            </clipPath>
          </defs>
          <image
            clipPath={`url(#${imageClipId})`}
            height={geometry.viewBox.height * (1 - imageInsets.top - imageInsets.bottom)}
            href={imageUrl}
            preserveAspectRatio={
              fill?.kind === 'image' && fill.mode === 'cover'
                ? 'xMidYMid slice'
                : fill?.kind === 'image' && fill.mode === 'contain'
                  ? 'xMidYMid meet'
                  : 'none'
            }
            width={geometry.viewBox.width * (1 - imageInsets.left - imageInsets.right)}
            x={geometry.viewBox.width * imageInsets.left}
            y={geometry.viewBox.height * imageInsets.top}
          />
        </>
      )}
      {geometry.subpaths.map((subpath, index) => {
        const subpathStroke = subpath.stroked === false ? undefined : stroke;
        const subpathStrokeColor = subpath.stroked === false ? undefined : strokeColor;
        return (
          <path
            d={subpath.path}
            fill={subpath.fillMode === 'none' ? 'none' : fillValue}
            key={index}
            stroke={subpathStrokeColor ?? 'none'}
            strokeDasharray={subpathStroke === undefined ? undefined : lineDash(subpathStroke)}
            strokeLinecap={subpathStroke === undefined ? undefined : lineCap(subpathStroke.cap)}
            strokeLinejoin={subpathStroke?.join}
            strokeWidth={
              subpathStrokeColor === undefined || subpathStroke === undefined
                ? undefined
                : clampedStrokeWidth(subpathStroke.width, transform)
            }
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

const CHART_SERIES_COLORS = [
  '#2563EB',
  '#DC2626',
  '#16A34A',
  '#D97706',
  '#0891B2',
  '#7C3AED',
] as const;

function chartSeriesColor(
  series: ReachDeckCategoricalChartElementV2['series'][number],
  index: number,
  resolveColor: (color: ReachDeckColorV2) => string | undefined,
): string {
  return (
    (series.color === undefined ? undefined : resolveColor(series.color)) ??
    CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]!
  );
}

function chartLabel(value: string, maximum = 18): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}...`;
}

function chartValueLabel(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function chartLegendHeight(itemCount: number): number {
  return itemCount === 0 ? 0 : Math.ceil(itemCount / 3) * 18 + 8;
}

function ChartLegend({
  colors,
  height,
  labels,
  width,
}: {
  colors: readonly string[];
  height: number;
  labels: readonly string[];
  width: number;
}) {
  const columns = Math.max(1, Math.min(labels.length, 3));
  const columnWidth = Math.max(1, width / columns);
  const startY = height - chartLegendHeight(labels.length) + 14;
  return (
    <g data-native-v2-chart-legend>
      {labels.map((label, index) => {
        const x = (index % columns) * columnWidth + 8;
        const y = startY + Math.floor(index / columns) * 18;
        return (
          <g key={`${label}:${index}`} transform={`translate(${x} ${y})`}>
            <rect fill={colors[index]!} height={8} rx={1} width={8} x={0} y={-7} />
            <text fill="#334155" fontSize={10} x={12} y={0}>
              <title>{label}</title>
              {chartLabel(label, Math.max(4, Math.floor(columnWidth / 7) - 2))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function splitChartLineSegments(
  values: readonly (number | null)[],
  point: (value: number, index: number) => { x: number; y: number },
): Array<Array<{ x: number; y: number }>> {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push(point(value, index));
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

function CartesianChartMarks({
  element,
  height,
  legendHeight,
  resolveColor,
  titleHeight,
  width,
}: {
  element: ReachDeckCategoricalChartElementV2;
  height: number;
  legendHeight: number;
  resolveColor: (color: ReachDeckColorV2) => string | undefined;
  titleHeight: number;
  width: number;
}) {
  const horizontal = element.chartType === 'bar';
  const left = horizontal ? Math.min(Math.max(width * 0.24, 54), width * 0.4) : 42;
  const right = Math.max(left + 1, width - 12);
  const top = titleHeight + 10;
  const bottom = Math.max(top + 1, height - legendHeight - (horizontal ? 12 : 28));
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);
  const finiteValues = element.series.flatMap((series) =>
    series.values.filter((value): value is number => value !== null && Number.isFinite(value)),
  );
  let minimum = Math.min(0, ...finiteValues);
  let maximum = Math.max(0, ...finiteValues);
  if (minimum === maximum) maximum = minimum + 1;
  const range = maximum - minimum;
  const valueX = (value: number): number => left + ((value - minimum) / range) * plotWidth;
  const valueY = (value: number): number => top + ((maximum - value) / range) * plotHeight;
  const zeroX = valueX(0);
  const zeroY = valueY(0);
  const categoryCount = Math.max(1, element.categories.length);
  const categoryX = (index: number): number => left + ((index + 0.5) / categoryCount) * plotWidth;
  const categoryY = (index: number): number => top + ((index + 0.5) / categoryCount) * plotHeight;
  const colors = element.series.map((series, index) =>
    chartSeriesColor(series, index, resolveColor),
  );
  const marks: ReactNode[] = [];

  if (element.chartType === 'column' || element.chartType === 'bar') {
    const slot = (horizontal ? plotHeight : plotWidth) / categoryCount;
    const thickness = Math.max(0.5, (slot * 0.76) / Math.max(1, element.series.length));
    element.series.forEach((series, seriesIndex) => {
      series.values.forEach((value, categoryIndex) => {
        if (value === null || !Number.isFinite(value)) return;
        const x = horizontal
          ? Math.min(zeroX, valueX(value))
          : left + categoryIndex * slot + slot * 0.12 + seriesIndex * thickness;
        const y = horizontal
          ? top + categoryIndex * slot + slot * 0.12 + seriesIndex * thickness
          : Math.min(zeroY, valueY(value));
        const markWidth = horizontal ? Math.max(0, Math.abs(valueX(value) - zeroX)) : thickness;
        const markHeight = horizontal ? thickness : Math.max(0, Math.abs(valueY(value) - zeroY));
        marks.push(
          <rect
            data-native-v2-chart-mark={`${series.id}:${categoryIndex}`}
            fill={colors[seriesIndex]}
            height={markHeight}
            key={`${series.id}:${categoryIndex}:bar`}
            width={markWidth}
            x={x}
            y={y}
          />,
        );
        if (element.showDataLabels) {
          marks.push(
            <text
              data-native-v2-chart-data-label={`${series.id}:${categoryIndex}`}
              fill="#334155"
              fontSize={9}
              key={`${series.id}:${categoryIndex}:label`}
              textAnchor="middle"
              x={horizontal ? valueX(value) : x + markWidth / 2}
              y={horizontal ? y + markHeight / 2 + 3 : y - 3}
            >
              {chartValueLabel(value)}
            </text>,
          );
        }
      });
    });
  } else {
    element.series.forEach((series, seriesIndex) => {
      const segments = splitChartLineSegments(series.values, (value, pointIndex) => ({
        x: categoryX(pointIndex),
        y: valueY(value),
      }));
      segments.forEach((segment, segmentIndex) => {
        const line = segment
          .map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
          .join(' ');
        const path =
          element.chartType === 'area'
            ? `${line} L ${segment[segment.length - 1]!.x} ${zeroY} L ${segment[0]!.x} ${zeroY} Z`
            : line;
        marks.push(
          <path
            d={path}
            data-native-v2-chart-segment={`${series.id}:${segmentIndex}`}
            fill={element.chartType === 'area' ? colors[seriesIndex] : 'none'}
            fillOpacity={element.chartType === 'area' ? 0.2 : undefined}
            key={`${series.id}:${segmentIndex}`}
            stroke={colors[seriesIndex]}
            strokeLinejoin="round"
            strokeWidth={2}
          />,
        );
      });
      series.values.forEach((value, pointIndex) => {
        if (value === null || !Number.isFinite(value)) return;
        const x = categoryX(pointIndex);
        const y = valueY(value);
        marks.push(
          <circle
            cx={x}
            cy={y}
            data-native-v2-chart-mark={`${series.id}:${pointIndex}`}
            fill={colors[seriesIndex]}
            key={`${series.id}:${pointIndex}:point`}
            r={2.5}
          />,
        );
        if (element.showDataLabels) {
          marks.push(
            <text
              data-native-v2-chart-data-label={`${series.id}:${pointIndex}`}
              fill="#334155"
              fontSize={9}
              key={`${series.id}:${pointIndex}:label`}
              textAnchor="middle"
              x={x}
              y={y - 5}
            >
              {chartValueLabel(value)}
            </text>,
          );
        }
      });
    });
  }

  return (
    <>
      {Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        const x = left + plotWidth * ratio;
        const y = top + plotHeight * ratio;
        return horizontal ? (
          <line key={`grid:${index}`} stroke="#E2E8F0" x1={x} x2={x} y1={top} y2={bottom} />
        ) : (
          <line key={`grid:${index}`} stroke="#E2E8F0" x1={left} x2={right} y1={y} y2={y} />
        );
      })}
      <line
        stroke="#64748B"
        x1={horizontal ? zeroX : left}
        x2={horizontal ? zeroX : right}
        y1={horizontal ? top : zeroY}
        y2={horizontal ? bottom : zeroY}
      />
      {element.categories.map((category, index) => (
        <text
          data-native-v2-chart-category={index}
          fill="#475569"
          fontSize={10}
          key={`${category}:${index}`}
          textAnchor={horizontal ? 'end' : 'middle'}
          x={horizontal ? left - 6 : categoryX(index)}
          y={horizontal ? categoryY(index) + 3 : bottom + 15}
        >
          <title>{category}</title>
          {chartLabel(category, horizontal ? 14 : 12)}
        </text>
      ))}
      {marks}
    </>
  );
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

function chartSectorPath(
  cx: number,
  cy: number,
  radius: number,
  start: number,
  end: number,
  innerRadius: number,
): string {
  const outerStart = polarPoint(cx, cy, radius, start);
  const outerEnd = polarPoint(cx, cy, radius, end);
  const span = end - start;
  if (span >= Math.PI * 2 - 1e-6) {
    if (innerRadius <= 0) {
      return `M ${cx + radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy} Z`;
    }
    return `M ${cx + radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy} M ${cx + innerRadius} ${cy} A ${innerRadius} ${innerRadius} 0 1 0 ${cx - innerRadius} ${cy} A ${innerRadius} ${innerRadius} 0 1 0 ${cx + innerRadius} ${cy} Z`;
  }
  const largeArc = span > Math.PI ? 1 : 0;
  if (innerRadius <= 0) {
    return `M ${cx} ${cy} L ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} Z`;
  }
  const innerEnd = polarPoint(cx, cy, innerRadius, end);
  const innerStart = polarPoint(cx, cy, innerRadius, start);
  return `M ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`;
}

function PieChartMarks({
  element,
  height,
  legendHeight,
  titleHeight,
  width,
}: {
  element: ReachDeckCategoricalChartElementV2;
  height: number;
  legendHeight: number;
  titleHeight: number;
  width: number;
}) {
  const series = element.series[0]!;
  const values = series.values.map((value) =>
    value === null || !Number.isFinite(value) || value <= 0 ? 0 : value,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  const availableHeight = Math.max(1, height - titleHeight - legendHeight - 12);
  const radius = Math.max(1, Math.min(width * 0.32, availableHeight * 0.45));
  const cx = width / 2;
  const cy = titleHeight + availableHeight / 2 + 4;
  const innerRadius = element.chartType === 'doughnut' ? radius * 0.55 : 0;
  if (total <= 0) {
    return (
      <circle
        cx={cx}
        cy={cy}
        data-native-v2-chart-empty
        fill="none"
        r={radius}
        stroke="#CBD5E1"
        strokeWidth={Math.max(2, radius - innerRadius)}
      />
    );
  }
  let angle = -Math.PI / 2;
  return (
    <>
      {values.map((value, index) => {
        if (value <= 0) return null;
        const start = angle;
        const end = angle + (value / total) * Math.PI * 2;
        angle = end;
        const midpoint = (start + end) / 2;
        const labelPoint = polarPoint(cx, cy, (radius + innerRadius) / 2, midpoint);
        return (
          <g key={`${series.id}:${index}`}>
            <path
              d={chartSectorPath(cx, cy, radius, start, end, innerRadius)}
              data-native-v2-chart-mark={`${series.id}:${index}`}
              fill={CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]}
              fillRule="evenodd"
              stroke="#FFFFFF"
              strokeWidth={1}
            />
            {element.showDataLabels ? (
              <text
                data-native-v2-chart-data-label={`${series.id}:${index}`}
                fill="#0F172A"
                fontSize={9}
                textAnchor="middle"
                x={labelPoint.x}
                y={labelPoint.y + 3}
              >
                {chartValueLabel(value)}
              </text>
            ) : null}
          </g>
        );
      })}
    </>
  );
}

/**
 * Read-only is about the chart's *data*: there is no data table to edit and no
 * way to author a new series. Where it sits on the page is layout, not data, so
 * the chart selects, moves and resizes like any other element.
 */
function CategoricalChart({
  boxStyle,
  element,
  onElementSelect,
  resolveColor,
  selectedElementId,
}: {
  boxStyle: CSSProperties;
  element: ReachDeckCategoricalChartElementV2;
  onElementSelect?: (elementId: string | undefined) => void;
  resolveColor: (color: ReachDeckColorV2) => string | undefined;
  selectedElementId?: string;
}) {
  const width = Math.max(element.transform.width, 0.01);
  const height = Math.max(element.transform.height, 0.01);
  const pie = element.chartType === 'pie' || element.chartType === 'doughnut';
  const legendLabels = pie ? element.categories : element.series.map((series) => series.name);
  const legendColors = pie
    ? legendLabels.map((_, index) => CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]!)
    : element.series.map((series, index) => chartSeriesColor(series, index, resolveColor));
  const legendHeight = element.showLegend ? chartLegendHeight(legendLabels.length) : 0;
  const titleHeight = element.title === undefined ? 0 : 22;
  return (
    <svg
      aria-label={element.ariaLabel ?? element.title ?? element.name}
      data-native-v2-chart-type={element.chartType}
      data-native-v2-element-id={element.id}
      data-read-only="true"
      onClick={(event) => {
        event.stopPropagation();
        onElementSelect?.(element.id);
      }}
      preserveAspectRatio="none"
      role="img"
      style={{
        ...boxStyle,
        overflow: 'hidden',
        outline: selectedElementId === element.id ? '3px solid #2563eb' : undefined,
        outlineOffset: selectedElementId === element.id ? 2 : undefined,
      }}
      viewBox={`0 0 ${width} ${height}`}
    >
      {element.title === undefined ? null : (
        <text
          data-native-v2-chart-title
          fill="#0F172A"
          fontSize={14}
          fontWeight={600}
          textAnchor="middle"
          x={width / 2}
          y={16}
        >
          <title>{element.title}</title>
          {chartLabel(element.title, Math.max(8, Math.floor(width / 8)))}
        </text>
      )}
      {pie ? (
        <PieChartMarks
          element={element}
          height={height}
          legendHeight={legendHeight}
          titleHeight={titleHeight}
          width={width}
        />
      ) : (
        <CartesianChartMarks
          element={element}
          height={height}
          legendHeight={legendHeight}
          resolveColor={resolveColor}
          titleHeight={titleHeight}
          width={width}
        />
      )}
      {element.showLegend ? (
        <ChartLegend colors={legendColors} height={height} labels={legendLabels} width={width} />
      ) : null}
    </svg>
  );
}

/** 占位图标只负责图案，背景和裁剪由图片或形状容器提供。 */
function ImagePlaceholderGraphic() {
  return (
    <svg
      x="60"
      y="30"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      opacity="0.4"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 5-5 4 4 3-3 6 6" />
    </svg>
  );
}

/** 缺失的图片填充仍沿原形状边界绘制，描边、文字与交互继续走原形状路径。 */
function ImageFillPlaceholder({
  elementId,
  geometry,
  borderRadius,
}: {
  elementId: string;
  geometry?: ShapeSvgGeometry;
  borderRadius?: CSSProperties['borderRadius'];
}) {
  const box = geometry?.viewBox ?? { width: 160, height: 100 };
  const clipId = 'native-v2-placeholder-clip-' + elementId;
  return (
    <svg
      data-native-v2-image-fill-placeholder
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox={`0 0 ${box.width} ${box.height}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'hidden',
        borderRadius,
        color: 'var(--reachany-color-text-secondary)',
      }}
    >
      {geometry ? (
        <defs>
          <clipPath id={clipId}>
            <path d={geometry.path} />
          </clipPath>
        </defs>
      ) : null}
      <g clipPath={geometry ? 'url(#' + clipId + ')' : undefined}>
        <svg width={box.width} height={box.height} viewBox="0 0 160 100" preserveAspectRatio="none">
          <rect width="160" height="100" fill="var(--reachany-color-neutral-1)" />
          <ImagePlaceholderGraphic />
        </svg>
      </g>
    </svg>
  );
}

/** 画布对缺失媒体显示中性状态，技术细节保留在诊断面板。 */
function ResilientImage({ src, alt, style, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [failedSource, setFailedSource] = useState<string>();
  if (!src || failedSource === src)
    return (
      <svg
        role="img"
        aria-label={alt || undefined}
        {...(props as React.SVGProps<SVGSVGElement>)}
        style={{
          ...style,
          background: 'var(--reachany-color-neutral-1)',
          color: 'var(--reachany-color-text-secondary)',
        }}
        viewBox="0 0 160 100"
        preserveAspectRatio="none"
      >
        <ImagePlaceholderGraphic />
      </svg>
    );
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      style={style}
      onError={() => setFailedSource(String(src))}
    />
  );
}

function ElementDiagnostic({
  element,
  diagnostics,
}: {
  element: ReachDeckNativeElementV2;
  diagnostics: NativeV2RendererDiagnostic[];
}) {
  if (
    element.type === 'image' &&
    diagnostics.length > 0 &&
    diagnostics.every((diagnostic) => diagnostic.code === 'UNRESOLVED_RESOURCE')
  )
    return (
      <ResilientImage
        alt={element.alt}
        data-native-v2-element-id={element.id}
        style={elementBoxStyle(element.transform, element.zIndex, element.opacity)}
      />
    );
  return (
    <div
      data-native-v2-element-id={element.id}
      data-native-v2-unsupported-element={element.type}
      data-read-only="true"
      key={element.id}
      role="note"
      style={{
        ...elementBoxStyle(element.transform, element.zIndex, element.opacity),
        ...diagnosticStyle,
      }}
    >
      <strong>{element.type}</strong>
      {diagnostics.map((diagnostic) => (
        <span key={`${diagnostic.code}:${diagnostic.path}`}>{diagnostic.message}</span>
      ))}
    </div>
  );
}

function DiagnosticPanel({ diagnostics }: { diagnostics: NativeV2RendererDiagnostic[] }) {
  return (
    <aside
      data-native-v2-diagnostics
      data-read-only="true"
      style={{ ...diagnosticStyle, marginTop: 8 }}
    >
      <strong>Read-only fidelity diagnostics</strong>
      {diagnostics.map((diagnostic) => (
        <div data-diagnostic-code={diagnostic.code} key={`${diagnostic.code}:${diagnostic.path}`}>
          {diagnostic.path}: {diagnostic.message}
        </div>
      ))}
    </aside>
  );
}

function hasResolvedResource(values: Readonly<Record<string, string>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key) && values[key].trim().length > 0;
}

const supportedPresetGeometry = NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES;
const shapeDashStyles = new Set<ReachDeckStrokeV2['dash']>([undefined, 'solid', 'dot', 'dash']);

interface ShapeSvgGeometry {
  source: 'custom' | 'preset';
  viewBox: { width: number; height: number };
  /** The whole outline, used to clip image fills. */
  path: string;
  /** Painted in order; each subpath decides whether it takes fill and stroke. */
  subpaths: readonly ReachDeckGeometrySubpathV2[];
}

/** SVG geometry for preset shapes that CSS box styling cannot outline. */
function shapePresetSvgGeometry(
  geometry: Extract<ReachDeckGeometryV2, { kind: 'preset' }>,
  transform: ReachDeckTransformV2,
): ShapeSvgGeometry | undefined {
  if (!isSvgPathPresetGeometry(geometry.preset)) return undefined;
  const built = presetGeometrySvgPath(
    geometry.preset,
    transform.width,
    transform.height,
    geometry.adjustments,
  );
  if (built === undefined) return undefined;
  return {
    source: 'preset',
    viewBox: { width: transform.width, height: transform.height },
    path: built.path,
    subpaths: [{ path: built.path, fillMode: built.fillMode }],
  };
}

function shapeBorderRadius(
  geometry: ReachDeckGeometryV2,
  transform: ReachDeckTransformV2,
): string | number | undefined {
  if (geometry.kind !== 'preset') return undefined;
  if (geometry.preset === 'ellipse') return '50%';
  if (geometry.preset === 'roundRect') {
    return roundRectCornerRadius(transform.width, transform.height, geometry.adjustments);
  }
  return undefined;
}

type NativeTransformCorner = 'nw' | 'ne' | 'se' | 'sw';
const nativeTransformCorners: readonly NativeTransformCorner[] = ['nw', 'ne', 'se', 'sw'];

// Lines carry endpoint geometry and groups carry child coordinates that a bare
// transform resize would not rescale — those stay move-only. A chart lays its
// marks out from the box it is given, so it resizes cleanly even though its
// data stays read-only.
function supportsCornerResize(element: ReachDeckNativeElementV2): boolean {
  return (
    element.type === 'shape' ||
    element.type === 'textFrame' ||
    element.type === 'image' ||
    element.type === 'audio' ||
    element.type === 'video' ||
    element.type === 'scientificVisual' ||
    element.type === 'chart'
  );
}

const resizedTransform = (
  transform: ReachDeckTransformV2,
  corner: NativeTransformCorner,
  pointer: { x: number; y: number },
): ReachDeckTransformV2 => {
  const rotation = transform.rotation ?? 0;
  const radians = (rotation * Math.PI) / 180;
  const unitX = { x: Math.cos(radians), y: Math.sin(radians) };
  const unitY = { x: -Math.sin(radians), y: Math.cos(radians) };
  const signX = corner.endsWith('e') ? 1 : -1;
  const signY = corner.startsWith('s') ? 1 : -1;
  const center = { x: transform.x + transform.width / 2, y: transform.y + transform.height / 2 };
  const opposite = {
    x:
      center.x - signX * (transform.width / 2) * unitX.x - signY * (transform.height / 2) * unitY.x,
    y:
      center.y - signX * (transform.width / 2) * unitX.y - signY * (transform.height / 2) * unitY.y,
  };
  const delta = { x: pointer.x - opposite.x, y: pointer.y - opposite.y };
  const width = Math.max(8, signX * (delta.x * unitX.x + delta.y * unitX.y));
  const height = Math.max(8, signY * (delta.x * unitY.x + delta.y * unitY.y));
  const nextCenter = {
    x: opposite.x + signX * (width / 2) * unitX.x + signY * (height / 2) * unitY.x,
    y: opposite.y + signX * (width / 2) * unitX.y + signY * (height / 2) * unitY.y,
  };
  return {
    ...transform,
    x: roundedStageValue(nextCenter.x - width / 2),
    y: roundedStageValue(nextCenter.y - height / 2),
    width: roundedStageValue(width),
    height: roundedStageValue(height),
  };
};

const diagnosticStyle: CSSProperties = {
  background: '#fff4f4',
  border: '2px solid #b91c1c',
  boxSizing: 'border-box',
  color: '#7f1d1d',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'sans-serif',
  fontSize: 14,
  gap: 4,
  overflow: 'auto',
  padding: 8,
};
