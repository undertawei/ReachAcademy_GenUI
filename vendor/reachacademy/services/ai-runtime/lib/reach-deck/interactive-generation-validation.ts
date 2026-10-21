import { createHash } from 'node:crypto';

import { parse as parseJavaScript } from 'acorn';
import { transform } from 'esbuild';
import { Window } from 'happy-dom';
import { auditInteractiveTailwindAuthoringHtml } from '@reachany/importer/maic';
import {
  INTERACTIVE_RUNTIME_PINS,
  INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
  INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_TAILWIND_RUNTIME_ID,
  INTERACTIVE_TAILWIND_RUNTIME_VERSION,
  INTERACTIVE_EVENT_MAX_NUMBER,
  INTERACTIVE_EVENT_MAX_STRING_LENGTH,
  INTERACTIVE_EVENT_MIN_NUMBER,
  interactiveScienceKitRuntimeDependency,
  isInteractiveBlankDocument,
  parseInteractiveSceneValue,
  parseReachFunctionPlotSpecValue,
  type InteractiveRuntimeDependency,
  type InteractiveRuntimeId,
  type InteractiveScene,
  type InteractiveScienceKitId,
} from '@reachany/reach-deck-dsl';
import { Parser, type DefaultTreeAdapterMap, type ParserError } from 'parse5';
import {
  inspectScienceGenerationMarkers,
  isGeometryRuntime,
  type ScientificGenerationValidationOptions,
} from './geometry-generation-markers.js';
export type { ScientificGenerationValidationOptions } from './geometry-generation-markers.js';

/** Trusted task rubrics identify exactly which otherwise valid geometry instances violate intent. */
export class GeometryGenerationSemanticError extends Error {
  constructor(
    message: string,
    readonly instanceIds: readonly string[],
  ) {
    super(message);
  }
}

class GeometryGenerationContractError extends Error {
  readonly code = 'structure-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'GeometryGenerationContractError';
  }
}

type ScriptSourceType = 'module' | 'script';

interface InlineScript {
  readonly index: number;
  readonly source: string;
  readonly sourceType: ScriptSourceType;
}

interface InteractiveRepairInvariant {
  readonly id: string;
  readonly title: string;
  readonly runtimePolicy: string;
  readonly eventManifest: string;
  readonly runtimeDependencies: string;
  readonly narration: string;
  readonly nonScriptDocumentFingerprint: string;
  readonly inlineScripts: readonly InlineScript[];
}

interface InlineScriptSyntaxError {
  readonly index: number;
  readonly message: string;
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface TailwindMarkerSource {
  readonly tagName: string;
  readonly value: string;
  readonly range?: SourceRange;
}

interface TailwindSourceInspection {
  readonly authoredHtmlCount: number;
  readonly markers: readonly TailwindMarkerSource[];
  readonly duplicateMarkerCount: number;
  readonly documentWithoutMarkers: string;
}

interface RepairFingerprintOptions {
  readonly ignoreFunctionPlotJson: boolean;
  readonly ignoreTailwindMetadata: boolean;
  readonly geometryInstances?: ReadonlySet<string>;
}

interface AcornSyntaxError extends Error {
  readonly loc?: { readonly line?: unknown; readonly column?: unknown };
}

interface CanonicalNodeLike {
  readonly nodeType: number;
  readonly textContent: string | null;
}

interface CanonicalElementLike extends CanonicalNodeLike {
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
  readonly childNodes: Iterable<CanonicalNodeLike>;
  readonly content?: { readonly childNodes: Iterable<CanonicalNodeLike> };
  readonly tagName: string;
}

const javascriptMimeTypes = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'text/ecmascript',
  'text/javascript',
  'module',
]);
const functionPlotMarkerIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const componentMarkerIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const knownScienceKitRuntimeIds = new Set<InteractiveRuntimeId>(
  (Object.keys(INTERACTIVE_SCIENCE_KIT_DEFINITIONS) as InteractiveScienceKitId[]).map(
    (kitId) => interactiveScienceKitRuntimeDependency(kitId).id,
  ),
);

// DOM normalization is intentionally inert: this Window is a parser host only and is configured
// to neither evaluate inline code nor fetch scripts, styles, images, or iframe documents.
const parserWindow = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableImageFileLoading: false,
    enableJavaScriptEvaluation: false,
  },
});

/**
 * Generation-only parser. Durable reads deliberately continue to use
 * parseInteractiveSceneValue() without importing an AST implementation.
 */
export function createGeneratedInteractiveSceneParser(
  expectedPageId: string,
  options: ScientificGenerationValidationOptions & {
    readonly validateScene?: (scene: InteractiveScene) => void;
  } = {},
): (value: unknown) => InteractiveScene {
  let repairInvariant: InteractiveRepairInvariant | undefined;
  let allowFunctionPlotCorrection = false;
  let geometryInstances: ReadonlySet<string> | undefined;
  let ignoreTailwindMetadata = false;
  let requireTailwindPair = false;
  let mutableInlineScriptIndices = new Set<number>();
  let protectRuntimeDependenciesBeforeValidation = false;
  return (value) => {
    const normalized = normalizeModelEventManifest(normalizeNullableInteractiveNarration(value));
    const candidate = inspectInteractiveCandidate(normalized);
    const tailwindErrors = candidate.tailwindErrors.slice();
    if (repairInvariant !== undefined && requireTailwindPair && !candidate.hasExactTailwindPair) {
      tailwindErrors.push(
        `Interactive Tailwind correction must restore exactly one ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="${INTERACTIVE_TAILWIND_RUNTIME_VERSION}" root marker and one ${INTERACTIVE_TAILWIND_RUNTIME_ID}@${INTERACTIVE_TAILWIND_RUNTIME_VERSION} dependency; removing both is not valid.`,
      );
    }

    let strictScene: InteractiveScene | undefined;
    let strictParseError: unknown;
    try {
      strictScene = parseInteractiveSceneValue(normalized, expectedPageId);
    } catch (error) {
      strictParseError = error;
    }

    let scene = strictScene;
    if (
      scene === undefined &&
      tailwindErrors.length > 0 &&
      candidate.projectedValue !== undefined
    ) {
      try {
        scene = parseInteractiveSceneValue(candidate.projectedValue, expectedPageId);
      } catch {
        throw strictParseError;
      }
    }
    if (scene === undefined) throw strictParseError;

    const intentionalEmpty = isInteractiveBlankDocument(scene.documentHtml);
    if (!intentionalEmpty && scene.narration === undefined) {
      throw new Error('Generated Interactive scenes must include narration.');
    }
    if (scene.runtimeDependencies === undefined) {
      throw new Error('Generated Interactive scenes must declare runtimeDependencies.');
    }
    assertInteractiveComponentMarkersAreValid(candidate.documentHtml);
    const document = new parserWindow.DOMParser().parseFromString(
      candidate.documentHtml,
      'text/html',
    );
    let science: ReturnType<typeof inspectScienceGenerationMarkers>;
    try {
      science = inspectScienceGenerationMarkers(
        document,
        options,
        scene.runtimeDependencies.some(({ id }) => isGeometryRuntime(id)),
      );
    } catch (error) {
      // Hard marker/permission/budget failures must not leave a fresh baseline for a rewrite.
      if (repairInvariant === undefined) {
        geometryInstances = new Set();
        protectRuntimeDependenciesBeforeValidation = true;
        repairInvariant = buildRepairInvariant(scene, candidate.documentHtml, {
          ignoreFunctionPlotJson: false,
          ignoreTailwindMetadata: false,
          geometryInstances,
        });
      }
      throw error;
    }
    let semanticError: unknown;
    let semanticInstances: readonly string[] = [];
    if (science.errors.length === 0 && options.validateScene !== undefined) {
      try {
        options.validateScene(scene);
      } catch (error) {
        semanticError = error;
        if (
          error instanceof GeometryGenerationSemanticError &&
          error.instanceIds.length > 0 &&
          error.instanceIds.every((id) => science.geometryInstances.has(id))
        ) {
          semanticInstances = error.instanceIds;
        }
      }
    }
    let functionPlotError: unknown;
    try {
      assertFunctionPlotMarkersAreValid(candidate.documentHtml);
    } catch (error) {
      functionPlotError = error;
    }
    const inlineScriptErrors = inspectInlineScriptSyntax(candidate.documentHtml);
    const lifecycleListenerScriptIndices = candidateDocumentLifecycleListenerIndices(
      candidate.documentHtml,
    );
    const restoreInitializationScriptIndices =
      options.scientificCapabilityPolicy !== 'legacy' && science.geometryInstances.size > 0
        ? candidateRestoreInitializationViolationIndices(candidate.documentHtml)
        : [];
    const diagnostics = [...tailwindErrors];
    diagnostics.push(...inlineScriptErrors.map(({ message }) => message));
    if (lifecycleListenerScriptIndices.length > 0) {
      diagnostics.push(
        'Interactive lifecycle events are dispatched on window: register reach-interactive-* listeners with window.addEventListener, never document.addEventListener. Bind every referenced DOM control before initialization and call ReachInteractive.ready only after successful initialization.',
      );
    }
    diagnostics.push(...tailwindAuthoringDiagnostics(candidate.documentHtml));
    if (functionPlotError !== undefined && diagnostics.length > 0) {
      diagnostics.push(readErrorMessage(functionPlotError));
    }

    // Generic dependency mismatches are independent candidates, while geometry diagnostics need
    // to establish their narrowly-scoped repair baseline before dependency correction is allowed.
    const validatedRuntimeDependencies =
      science.errors.length === 0 &&
      (repairInvariant === undefined || !protectRuntimeDependenciesBeforeValidation);
    if (validatedRuntimeDependencies) {
      assertNonTailwindRuntimeDependenciesMatchDocument(scene, options, science.runtimeIds);
    }

    if (repairInvariant === undefined) {
      const invalidInstances = new Set([...science.invalidGeometryInstances, ...semanticInstances]);
      geometryInstances = invalidInstances.size > 0 ? invalidInstances : undefined;
      protectRuntimeDependenciesBeforeValidation = science.geometryInstances.size > 0;
      ignoreTailwindMetadata = tailwindErrors.length > 0;
      requireTailwindPair = ignoreTailwindMetadata && candidate.requestsTailwind;
      allowFunctionPlotCorrection =
        geometryInstances === undefined && isRepairableFunctionPlotJsonError(functionPlotError);
      mutableInlineScriptIndices = new Set([
        ...inlineScriptErrors.map(({ index }) => index),
        ...restoreInitializationScriptIndices,
        ...lifecycleListenerScriptIndices,
      ]);
      repairInvariant = buildRepairInvariant(scene, candidate.documentHtml, {
        ignoreFunctionPlotJson: allowFunctionPlotCorrection,
        ignoreTailwindMetadata,
        geometryInstances,
      });
    } else {
      assertSameRepairInvariant(
        repairInvariant,
        buildRepairInvariant(scene, candidate.documentHtml, {
          ignoreFunctionPlotJson: allowFunctionPlotCorrection,
          ignoreTailwindMetadata,
          geometryInstances,
        }),
        mutableInlineScriptIndices,
      );
    }
    if (options.scientificCapabilityPolicy !== 'legacy' && science.geometryInstances.size > 0) {
      // This is a repair-eligible author-script error. Freeze the original's
      // non-script locks first; otherwise a correction could establish its
      // own baseline after replacing unrelated content.
      assertCandidateRestoreInitializationContract(scene.documentHtml);
    }
    // Geometry errors are deliberately deferred until the rejected original has frozen its locks.
    if (science.errors.length > 0) {
      throw new GeometryGenerationContractError(science.errors.join('; '));
    }
    if (semanticError !== undefined) throw semanticError;
    if (!validatedRuntimeDependencies) {
      assertNonTailwindRuntimeDependenciesMatchDocument(scene, options, science.runtimeIds);
    }
    if (diagnostics.length > 0) throw combinedInteractiveDiagnostic(diagnostics);
    if (functionPlotError !== undefined) throw functionPlotError;
    if (strictScene === undefined) throw strictParseError;
    return strictScene;
  };
}

function normalizeNullableInteractiveNarration(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Object.prototype.hasOwnProperty.call(value, 'narration') ||
    (value as { narration?: unknown }).narration !== null
  ) {
    return value;
  }
  const { narration: _nullableNarration, ...scene } = value as Record<string, unknown>;
  return scene;
}

/** 各类型 payload 字段保留的类型专属键，以及该键为 null 或缺省时的宿主默认值（全局上限）。 */
const PAYLOAD_FIELD_TYPE_KEYS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  string: { maxLength: INTERACTIVE_EVENT_MAX_STRING_LENGTH, enum: [] },
  number: { minimum: INTERACTIVE_EVENT_MIN_NUMBER, maximum: INTERACTIVE_EVENT_MAX_NUMBER },
  integer: { minimum: INTERACTIVE_EVENT_MIN_NUMBER, maximum: INTERACTIVE_EVENT_MAX_NUMBER },
  boolean: {},
};
const PAYLOAD_FIELD_OPTIONAL_KEYS = new Set(['maxLength', 'enum', 'minimum', 'maximum']);

/**
 * 把生成 schema 的扁平事件声明（所有类型专属键都在、不适用的填 null）还原成
 * reach-interactive-event-manifest/v1 的标准形状；已是标准形状的声明原样通过。
 * 网关按字母序生成键时模型先写边界、后写 type，适用的边界常被填成 null，此时取全局上限；
 * 不适用于该类型的键没有语义，直接丢弃。
 */
function normalizeModelEventManifest(value: unknown): unknown {
  if (
    !isPlainRecord(value) ||
    !isPlainRecord(value.eventManifest) ||
    !Array.isArray(value.eventManifest.events)
  ) {
    return value;
  }
  const events = value.eventManifest.events.map((event: unknown) => {
    if (!isPlainRecord(event)) return event;
    const next: Record<string, unknown> = { ...event };
    if (Array.isArray(event.payloadFields))
      next.payloadFields = event.payloadFields.map(normalizeModelPayloadField);
    if (isPlainRecord(event.delivery) && event.delivery.mode === 'immediate')
      next.delivery = { mode: 'immediate' };
    return next;
  });
  return { ...value, eventManifest: { ...value.eventManifest, events } };
}

function normalizeModelPayloadField(field: unknown): unknown {
  if (!isPlainRecord(field) || typeof field.type !== 'string') return field;
  const defaults = PAYLOAD_FIELD_TYPE_KEYS[field.type];
  if (defaults === undefined) return field;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(field))
    if (!PAYLOAD_FIELD_OPTIONAL_KEYS.has(key)) normalized[key] = entry;
  for (const [key, fallback] of Object.entries(defaults))
    normalized[key] = field[key] ?? structuredClone(fallback);
  return normalized;
}

interface InspectedInteractiveCandidate {
  readonly documentHtml: string;
  readonly hasExactTailwindPair: boolean;
  readonly projectedValue?: Record<string, unknown>;
  readonly requestsTailwind: boolean;
  readonly tailwindErrors: string[];
}

function inspectInteractiveCandidate(value: unknown): InspectedInteractiveCandidate {
  if (!isPlainRecord(value) || typeof value.documentHtml !== 'string') {
    return {
      documentHtml: '',
      hasExactTailwindPair: false,
      requestsTailwind: false,
      tailwindErrors: [],
    };
  }
  const source = inspectTailwindSource(value.documentHtml);
  const dependencies = Array.isArray(value.runtimeDependencies) ? value.runtimeDependencies : [];
  const tailwindDependencies = dependencies.filter(
    (dependency) => isPlainRecord(dependency) && dependency.id === INTERACTIVE_TAILWIND_RUNTIME_ID,
  );
  const exactTailwindDependency =
    tailwindDependencies.length === 1 &&
    hasExactKeys(tailwindDependencies[0]!, ['id', 'version']) &&
    tailwindDependencies[0]!.version === INTERACTIVE_TAILWIND_RUNTIME_VERSION;
  const markerCount = source.markers.length + source.duplicateMarkerCount;
  const exactTailwindMarker =
    source.authoredHtmlCount === 1 &&
    markerCount === 1 &&
    source.markers.length === 1 &&
    source.markers[0]!.tagName === 'html' &&
    source.markers[0]!.value === INTERACTIVE_TAILWIND_RUNTIME_VERSION;
  const requestsTailwind = markerCount > 0 || tailwindDependencies.length > 0;
  const tailwindErrors: string[] = [];

  if (requestsTailwind) {
    if (source.authoredHtmlCount !== 1) {
      tailwindErrors.push(
        'Interactive Tailwind documents must contain exactly one authored <html> root element.',
      );
    }
    if (markerCount !== 1 || source.markers.length !== 1 || source.markers[0]?.tagName !== 'html') {
      tailwindErrors.push(
        `Interactive Tailwind marker ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE} must appear exactly once on the authored <html> root and nowhere else.`,
      );
    } else if (source.markers[0].value !== INTERACTIVE_TAILWIND_RUNTIME_VERSION) {
      tailwindErrors.push(
        `Interactive Tailwind runtime marker must equal ${INTERACTIVE_TAILWIND_RUNTIME_VERSION}.`,
      );
    }
    if (!exactTailwindDependency) {
      tailwindErrors.push(
        `Interactive Tailwind runtime dependency must contain exactly one ${INTERACTIVE_TAILWIND_RUNTIME_ID}@${INTERACTIVE_TAILWIND_RUNTIME_VERSION} entry with no extra fields.`,
      );
    }
    if (exactTailwindMarker !== exactTailwindDependency) {
      tailwindErrors.push(
        'Interactive Tailwind root marker and runtime dependency must either both be absent or form one exact pair.',
      );
    }
  }

  return {
    documentHtml: value.documentHtml,
    hasExactTailwindPair: exactTailwindMarker && exactTailwindDependency,
    projectedValue:
      tailwindErrors.length === 0
        ? undefined
        : {
            ...value,
            documentHtml: source.documentWithoutMarkers,
            runtimeDependencies: dependencies.filter(
              (dependency) =>
                !isPlainRecord(dependency) || dependency.id !== INTERACTIVE_TAILWIND_RUNTIME_ID,
            ),
          },
    requestsTailwind,
    tailwindErrors,
  };
}

function inspectTailwindSource(documentHtml: string): TailwindSourceInspection {
  let authoredHtmlCount = 0;
  const markers: TailwindMarkerSource[] = [];
  const markerRanges: SourceRange[] = [];
  const duplicateMarkerRanges: SourceRange[] = [];
  let duplicateMarkerCount = 0;
  const parser = new Parser<DefaultTreeAdapterMap>({
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code !== 'duplicate-attribute') return;
      const range = duplicateTailwindAttributeRange(documentHtml, error);
      if (range === undefined) return;
      duplicateMarkerCount += 1;
      duplicateMarkerRanges.push(range);
    },
  });
  const handleStartTag = parser.onStartTag.bind(parser);
  parser.onStartTag = (token) => {
    if (token.tagName === 'html') authoredHtmlCount += 1;
    const marker = token.attrs.find(
      (attribute) => attribute.name === INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
    );
    if (marker !== undefined) {
      const location = token.location?.attrs?.[INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE];
      const range =
        location === undefined
          ? undefined
          : { start: location.startOffset, end: location.endOffset };
      markers.push({ tagName: token.tagName, value: marker.value, range });
      if (range !== undefined) markerRanges.push(range);
    }
    handleStartTag(token);
  };
  parser.tokenizer.write(documentHtml, true);

  return {
    authoredHtmlCount,
    markers,
    duplicateMarkerCount,
    documentWithoutMarkers: removeSourceRanges(documentHtml, [
      ...markerRanges,
      ...duplicateMarkerRanges,
    ]),
  };
}

function duplicateTailwindAttributeRange(
  source: string,
  error: ParserError,
): SourceRange | undefined {
  const nameEnd = error.startOffset;
  const nameStart = nameEnd - INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE.length;
  if (
    nameStart < 0 ||
    source.slice(nameStart, nameEnd).toLowerCase() !== INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE
  ) {
    return undefined;
  }
  let end = nameEnd;
  while (/\s/.test(source[end] ?? '')) end += 1;
  if (source[end] !== '=') return { start: nameStart, end };
  end += 1;
  while (/\s/.test(source[end] ?? '')) end += 1;
  const quote = source[end];
  if (quote === '"' || quote === "'") {
    end += 1;
    while (end < source.length && source[end] !== quote) end += 1;
    if (source[end] === quote) end += 1;
  } else {
    while (end < source.length && !/[\s>]/.test(source[end] ?? '')) end += 1;
  }
  return { start: nameStart, end };
}

function removeSourceRanges(source: string, ranges: readonly SourceRange[]): string {
  let result = source;
  const ordered = [...ranges].sort((left, right) => right.start - left.start);
  for (const range of ordered) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function assertInlineScriptsHaveValidSyntax(documentHtml: string): void {
  const errors = inspectInlineScriptSyntax(documentHtml);
  if (errors.length > 0) throw combinedInteractiveDiagnostic(errors.map(({ message }) => message));
}

function inspectInlineScriptSyntax(documentHtml: string): InlineScriptSyntaxError[] {
  const errors: InlineScriptSyntaxError[] = [];
  for (const script of extractInlineJavaScript(documentHtml)) {
    try {
      parseJavaScript(script.source, {
        allowHashBang: true,
        ecmaVersion: 'latest',
        locations: true,
        sourceType: script.sourceType,
      });
    } catch (error) {
      const syntaxError = error as AcornSyntaxError;
      const line = boundedLocation(syntaxError.loc?.line);
      const column = boundedLocation(syntaxError.loc?.column);
      const location =
        line === undefined
          ? ''
          : ` at line ${line}, column ${column === undefined ? 0 : column + 1}`;
      errors.push({
        index: script.index,
        message: `Inline script ${script.index} has invalid JavaScript${location}: ${boundedParserMessage(syntaxError.message)}`,
      });
    }
  }
  return errors;
}

/** Compile inline browser JavaScript and CSS without evaluating code or loading resources. */
export async function assertInteractiveDocumentStaticallyCompiles(
  documentHtml: string,
): Promise<void> {
  if (candidateDocumentLifecycleListenerIndices(documentHtml).length > 0) {
    throw new Error(
      'Interactive lifecycle listeners must use window.addEventListener, not document.addEventListener.',
    );
  }
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  const compilations: Promise<unknown>[] = extractInlineJavaScript(documentHtml).map(
    async (script) => {
      try {
        await transform(script.source, {
          format: script.sourceType === 'module' ? 'esm' : 'iife',
          loader: 'js',
          logLevel: 'silent',
          target: 'es2022',
        });
      } catch (error) {
        throw new Error(
          `Inline script ${script.index} failed static compilation: ${boundedParserMessage(readErrorMessage(error))}`,
          { cause: error },
        );
      }
    },
  );
  compilations.push(
    ...[...document.querySelectorAll('style')].map(async (style, index) => {
      try {
        await transform(style.textContent ?? '', { loader: 'css', logLevel: 'silent' });
      } catch (error) {
        throw new Error(
          `Inline style ${index + 1} failed static compilation: ${boundedParserMessage(readErrorMessage(error))}`,
          { cause: error },
        );
      }
    }),
  );
  await Promise.all(compilations);
}

export function fingerprintInteractiveNonScriptDocument(
  documentHtml: string,
  ignoreFunctionPlotJson = false,
  geometryInstances?: ReadonlySet<string>,
  ignoreTailwindMetadata = false,
): string {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  const canonical = canonicalNode(document.documentElement as CanonicalNodeLike, {
    ignoreFunctionPlotJson,
    geometryInstances,
    ignoreTailwindMetadata,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function assertFunctionPlotMarkersAreValid(documentHtml: string): void {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  const seen = new Set<string>();
  for (const marker of document.querySelectorAll('[data-reach-function-plot]')) {
    const type = (marker.getAttribute('type') ?? '').trim().toLowerCase();
    const id = (marker.getAttribute('data-reach-function-plot') ?? '').trim();
    if (
      marker.tagName.toLowerCase() !== 'script' ||
      type !== 'application/json' ||
      !functionPlotMarkerIdPattern.test(id) ||
      seen.has(id)
    ) {
      throw new Error('Interactive function plot marker has an invalid type or id.');
    }
    seen.add(id);
    try {
      parseReachFunctionPlotSpecValue(JSON.parse(marker.textContent ?? ''));
    } catch (error) {
      const detail = error instanceof Error ? ` ${boundedParserMessage(error.message)}` : '';
      throw new Error(
        `Interactive function plot marker has invalid Reach function plot JSON.${detail}`,
        { cause: error },
      );
    }
  }
}

export function assertInteractiveComponentMarkersAreValid(documentHtml: string): void {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  const seen = new Set<string>();
  const markers = document.querySelectorAll('[data-reach-component-id]');
  if (markers.length > 64) throw new Error('Interactive component marker count exceeds 64.');
  for (const marker of markers) {
    const id = (marker.getAttribute('data-reach-component-id') ?? '').trim();
    const label = marker.getAttribute('data-reach-component-label')?.trim();
    const detail = marker.getAttribute('data-reach-component-detail')?.trim();
    if (
      !componentMarkerIdPattern.test(id) ||
      seen.has(id) ||
      (label !== undefined && (label.length < 1 || label.length > 160)) ||
      (detail !== undefined && (detail.length < 1 || detail.length > 500)) ||
      marker.outerHTML.length > 32 * 1024
    ) {
      throw new Error('Interactive component marker metadata is invalid or duplicated.');
    }
    seen.add(id);
  }
}

/**
 * Candidate scenes must let the bridge own initialization ordering. Calling
 * getInitialization() eagerly can run before the host dispatches the restore
 * event, consume an author guard, and make the real snapshot invisible.
 */
export function assertCandidateRestoreInitializationContract(documentHtml: string): void {
  if (candidateRestoreInitializationViolationIndices(documentHtml).length > 0) {
    throw new Error(
      'Candidate Interactive restore must initialize from reach-interactive-initialize event.detail; do not call ReachInteractive.getInitialization() eagerly.',
    );
  }
}

function candidateRestoreInitializationViolationIndices(documentHtml: string): number[] {
  return extractInlineJavaScript(documentHtml)
    .filter(
      ({ source }) =>
        /reach-interactive-initialize/.test(source) &&
        /\b(?:initialize|restore|start)\s*\(\s*(?:window\.)?ReachInteractive\.getInitialization\s*\(\s*\)\s*\)/.test(
          source,
        ),
    )
    .map(({ index }) => index);
}

/** Inspect syntax, not string contents/comments, and never execute untrusted author code. */
function candidateDocumentLifecycleListenerIndices(documentHtml: string): number[] {
  type AstNode = Record<string, unknown>;
  const memberName = (node: AstNode): unknown => {
    const property = node.property as AstNode | undefined;
    return node.computed === true ? property?.value : property?.name;
  };
  const isDocument = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const node = value as AstNode;
    return (
      (node.type === 'Identifier' && node.name === 'document') ||
      (node.type === 'MemberExpression' &&
        memberName(node) === 'document' &&
        (node.object as AstNode | undefined)?.name === 'window')
    );
  };
  return extractInlineJavaScript(documentHtml)
    .filter((script) => {
      let ast: unknown;
      try {
        ast = parseJavaScript(script.source, {
          ecmaVersion: 'latest',
          sourceType: script.sourceType,
        });
      } catch {
        return false; // Existing syntax diagnostics own malformed scripts.
      }
      const pending: unknown[] = [ast];
      while (pending.length > 0) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
          for (const child of value) pending.push(child);
          continue;
        }
        const node = value as AstNode;
        if (node.type === 'CallExpression') {
          const callee = node.callee as AstNode | undefined;
          const firstArgument = (node.arguments as AstNode[] | undefined)?.[0];
          const eventName = firstArgument?.value;
          if (
            callee?.type === 'MemberExpression' &&
            memberName(callee) === 'addEventListener' &&
            isDocument(callee.object) &&
            typeof eventName === 'string' &&
            /^reach-interactive-(initialize|resize|suspend|resume|reset|dispose)$/.test(eventName)
          ) {
            return true;
          }
        }
        for (const child of Object.values(node)) pending.push(child);
      }
      return false;
    })
    .map(({ index }) => index);
}

export function assertRuntimeDependenciesMatchDocument(
  scene: InteractiveScene,
  options: ScientificGenerationValidationOptions = {},
  inspectedRuntimeIds?: ReadonlySet<InteractiveRuntimeId>,
): void {
  if (scene.runtimeDependencies === undefined) {
    throw new Error('Generated Interactive scenes must declare runtimeDependencies.');
  }
  const tailwindErrors = inspectInteractiveCandidate(scene).tailwindErrors;
  if (tailwindErrors.length > 0) throw combinedInteractiveDiagnostic(tailwindErrors);
  assertNonTailwindRuntimeDependenciesMatchDocument(scene, options, inspectedRuntimeIds);
}

function assertNonTailwindRuntimeDependenciesMatchDocument(
  scene: InteractiveScene,
  options: ScientificGenerationValidationOptions = {},
  inspectedRuntimeIds?: ReadonlySet<InteractiveRuntimeId>,
): void {
  if (scene.runtimeDependencies === undefined) {
    throw new Error('Generated Interactive scenes must declare runtimeDependencies.');
  }
  const ids = new Set(scene.runtimeDependencies.map(({ id }) => id));
  for (const pin of scene.runtimeDependencies) {
    if (isGeometryRuntime(pin.id) && options.scientificCapabilityPolicy === 'legacy') {
      throw new Error('Interactive geometry generation is disabled.');
    }
    if (
      options.allowedRuntimeDependencies !== undefined &&
      !options.allowedRuntimeDependencies.some(
        (allowed) => allowed.id === pin.id && allowed.version === pin.version,
      )
    ) {
      throw new Error(`Interactive runtime ${pin.id} is not authorized by the frozen context.`);
    }
  }
  const document = new parserWindow.DOMParser().parseFromString(scene.documentHtml, 'text/html');
  const hasFunctionPlot =
    document.querySelector('script[type="application/json"][data-reach-function-plot]') !== null;
  const usesExpression = /\bReachExpression\s*\./.test(scene.documentHtml);
  const usesAnimateCss = /\banimate__(?:animated|[A-Za-z0-9_-]+)\b/.test(scene.documentHtml);
  const science =
    inspectedRuntimeIds === undefined
      ? inspectScienceGenerationMarkers(document, options)
      : undefined;
  if (science && science.errors.length > 0) throw new Error(science.errors.join('; '));
  const usedScienceKitRuntimeIds = inspectedRuntimeIds ?? science!.runtimeIds;
  const checks = [
    ['function-plot', hasFunctionPlot],
    ['expression', usesExpression],
    ['animate-css', usesAnimateCss],
  ] as const;
  for (const [id, used] of checks) {
    if (used !== ids.has(id)) {
      throw new Error(`Interactive runtime dependency ${id} does not match document usage.`);
    }
  }
  const declaredScienceKitRuntimeIds = new Set(
    scene.runtimeDependencies
      .map(({ id }) => id)
      .filter((id) => knownScienceKitRuntimeIds.has(id) || isGeometryRuntime(id)),
  );
  if (
    declaredScienceKitRuntimeIds.size !== usedScienceKitRuntimeIds.size ||
    [...declaredScienceKitRuntimeIds].some((id) => !usedScienceKitRuntimeIds.has(id))
  ) {
    throw new Error('Interactive science kit runtime dependencies do not match document markers.');
  }
}

/** Derive the exact pinned runtime set used by one complete Interactive HTML document. */
export function inferInteractiveRuntimeDependencies(
  documentHtml: string,
  options: ScientificGenerationValidationOptions = {},
): InteractiveRuntimeDependency[] {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  const tailwindSource = inspectTailwindSource(documentHtml);
  const ids = new Set<InteractiveRuntimeId>();
  const markerCount = tailwindSource.markers.length + tailwindSource.duplicateMarkerCount;
  if (markerCount > 0) {
    const marker = tailwindSource.markers[0];
    if (
      tailwindSource.authoredHtmlCount !== 1 ||
      markerCount !== 1 ||
      tailwindSource.markers.length !== 1 ||
      marker?.tagName !== 'html'
    ) {
      throw new Error(
        `Interactive Tailwind marker ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE} must appear exactly once on the sole authored <html> root.`,
      );
    }
    if (marker.value !== INTERACTIVE_TAILWIND_RUNTIME_VERSION) {
      throw new Error(
        `Interactive Tailwind runtime marker must equal ${INTERACTIVE_TAILWIND_RUNTIME_VERSION}.`,
      );
    }
    ids.add(INTERACTIVE_TAILWIND_RUNTIME_ID);
  }
  if (document.querySelector('script[type="application/json"][data-reach-function-plot]')) {
    ids.add('function-plot');
  }
  if (/\bReachExpression\s*\./.test(documentHtml)) ids.add('expression');
  if (/\banimate__(?:animated|[A-Za-z0-9_-]+)\b/.test(documentHtml)) ids.add('animate-css');
  const science = inspectScienceGenerationMarkers(document, options);
  if (science.errors.length > 0) throw new Error(science.errors.join('; '));
  for (const id of science.runtimeIds) ids.add(id);
  return [...ids]
    .sort(compareCodeUnits)
    .map((id) => ({ id, version: INTERACTIVE_RUNTIME_PINS[id] }));
}

function extractInlineJavaScript(documentHtml: string): InlineScript[] {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  return [...document.querySelectorAll('script')].flatMap((element, offset) => {
    if (element.hasAttribute('src')) return [];
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
    if (!javascriptMimeTypes.has(type)) return [];
    return [
      {
        index: offset + 1,
        source: element.textContent ?? '',
        sourceType: type === 'module' ? 'module' : 'script',
      },
    ];
  });
}

function buildRepairInvariant(
  scene: InteractiveScene,
  documentHtml: string,
  options: RepairFingerprintOptions,
): InteractiveRepairInvariant {
  return {
    id: scene.id,
    title: scene.title,
    runtimePolicy: JSON.stringify(scene.runtimePolicy),
    eventManifest: JSON.stringify(scene.eventManifest),
    runtimeDependencies: JSON.stringify(
      scene.runtimeDependencies?.filter(
        ({ id }) =>
          !(options.ignoreTailwindMetadata && id === INTERACTIVE_TAILWIND_RUNTIME_ID) &&
          !(options.geometryInstances !== undefined && isGeometryRuntime(id)),
      ),
    ),
    narration: JSON.stringify(scene.narration),
    nonScriptDocumentFingerprint: fingerprintInteractiveNonScriptDocument(
      documentHtml,
      options.ignoreFunctionPlotJson,
      options.geometryInstances,
      options.ignoreTailwindMetadata,
    ),
    inlineScripts: extractInlineJavaScript(documentHtml),
  };
}

function assertSameRepairInvariant(
  baseline: InteractiveRepairInvariant,
  candidate: InteractiveRepairInvariant,
  mutableInlineScriptIndices: ReadonlySet<number>,
): void {
  const changed: string[] = [];
  if (baseline.id !== candidate.id) changed.push('id');
  if (baseline.title !== candidate.title) changed.push('title');
  if (baseline.runtimePolicy !== candidate.runtimePolicy) changed.push('runtimePolicy');
  if (baseline.eventManifest !== candidate.eventManifest) changed.push('eventManifest');
  if (baseline.narration !== candidate.narration) changed.push('narration');
  if (baseline.runtimeDependencies !== candidate.runtimeDependencies) {
    changed.push('runtimeDependencies');
  }
  if (baseline.nonScriptDocumentFingerprint !== candidate.nonScriptDocumentFingerprint) {
    changed.push('non-script document structure');
  }
  if (
    baseline.inlineScripts.length !== candidate.inlineScripts.length ||
    baseline.inlineScripts.some((script, index) => {
      const next = candidate.inlineScripts[index];
      return (
        next === undefined ||
        next.index !== script.index ||
        next.sourceType !== script.sourceType ||
        (!mutableInlineScriptIndices.has(script.index) && next.source !== script.source)
      );
    })
  ) {
    changed.push('valid inline scripts');
  }
  if (changed.length > 0) {
    throw new Error(`Interactive correction changed protected fields: ${changed.join(', ')}.`);
  }
}

function canonicalNode(node: CanonicalNodeLike, options: RepairFingerprintOptions): string {
  if (node.nodeType === 3) {
    const text = node.textContent ?? '';
    return text.trim().length === 0 ? '' : JSON.stringify(['text', text]);
  }
  if (node.nodeType !== 1) return '';
  const element = node as CanonicalElementLike;
  const attributes = [...element.attributes]
    .filter(
      (attribute) =>
        !(
          options.ignoreTailwindMetadata &&
          attribute.name.toLowerCase() === INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE
        ),
    )
    .map((attribute) => [attribute.name.toLowerCase(), attribute.value] as const)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const tagName = element.tagName.toLowerCase();
  const childNodes =
    tagName === 'template' && element.content !== undefined
      ? element.content.childNodes
      : element.childNodes;
  const scriptType =
    tagName === 'script'
      ? (attributes.find(([name]) => name === 'type')?.[1] ?? '').trim().toLowerCase()
      : '';
  const isFunctionPlotMarker =
    tagName === 'script' && attributes.some(([name]) => name === 'data-reach-function-plot');
  const geometryInstance = attributes
    .find(([name]) => name === 'data-reach-science-kit')?.[1]
    ?.trim();
  const children =
    (tagName === 'script' && javascriptMimeTypes.has(scriptType)) ||
    (isFunctionPlotMarker && options.ignoreFunctionPlotJson) ||
    (tagName === 'script' &&
      scriptType === 'application/json' &&
      geometryInstance !== undefined &&
      options.geometryInstances?.has(geometryInstance))
      ? []
      : [...childNodes].map((child) => canonicalNode(child, options)).filter(Boolean);
  return JSON.stringify(['element', tagName, attributes, children]);
}

function isRepairableFunctionPlotJsonError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(
      'Interactive function plot marker has invalid Reach function plot JSON.',
    )
  );
}

function tailwindAuthoringDiagnostics(documentHtml: string): string[] {
  return auditInteractiveTailwindAuthoringHtml(documentHtml).map((finding) =>
    finding.code === 'tailwind_url_utility'
      ? `Interactive Tailwind authoring does not support arbitrary utilities containing url(...) (${finding.source}).`
      : `Interactive Tailwind authoring does not support runtime configuration, plugins, @config, @plugin, @import, or @reference (${finding.source}).`,
  );
}

function combinedInteractiveDiagnostic(diagnostics: readonly string[]): Error {
  const unique = [...new Set(diagnostics.map((diagnostic) => boundedParserMessage(diagnostic)))];
  const message = unique.join(' ');
  return new Error(message.length <= 1500 ? message : `${message.slice(0, 1497)}...`);
}

function boundedLocation(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : undefined;
}

function boundedParserMessage(message: string): string {
  const singleLine = message.replace(/[\r\n\t]+/g, ' ').trim();
  return singleLine.slice(0, 300) || 'syntax error';
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
