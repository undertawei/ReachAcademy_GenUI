import { readMaicLineChart } from './chart.js';
import { createMaicSourceDigest, createStableMaicId } from './identity.js';
import { readMaicCanvasImageBackground } from './background.js';
import { transformMaicInteractiveHtml } from './interactive.js';
import type {
  MaicCapabilityEntry,
  MaicCapabilityPageReport,
  MaicCapabilityReport,
  MaicCourseIR,
  MaicDiagnostic,
  MaicElementIR,
  MaicMediaReference,
  MaicPageIR,
  MaicParseResult,
} from './types.js';
import { MAIC_IMPORT_LIMITS, type MaicImportLimits } from './version.js';

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const elementTypes = new Set(['text', 'image', 'shape', 'line', 'table', 'audio', 'chart']);
const pageKinds = new Set(['canvas', 'quiz', 'interactive']);
const allowedMediaHostnames = new Set([
  'file.maic.chat',
  'maic-prod.oss-cn-wulanchabu.aliyuncs.com',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const sortDiagnostics = (diagnostics: readonly MaicDiagnostic[]): MaicDiagnostic[] =>
  [...diagnostics].sort((left, right) => {
    const leftKey = `${left.location?.sourceOrder ?? 0}\0${left.location?.elementId ?? ''}\0${left.code}`;
    const rightKey = `${right.location?.sourceOrder ?? 0}\0${right.location?.elementId ?? ''}\0${right.code}`;
    return leftKey.localeCompare(rightKey);
  });

const issue = (
  suffix: string,
  severity: MaicDiagnostic['severity'],
  feature: MaicDiagnostic['feature'],
  message: string,
  location?: MaicDiagnostic['location'],
): MaicDiagnostic => ({
  code: `maic.${suffix}` as `maic.${string}`,
  severity,
  feature,
  message,
  ...(location ? { location } : {}),
});

const emptyReport = (diagnostics: readonly MaicDiagnostic[]): MaicCapabilityReport => ({
  schemaVersion: 'maic-capability-report/v1',
  entries: [],
  diagnostics: sortDiagnostics(diagnostics),
  pageReports: [],
  canApply: false,
});

const boundedTraversal = (value: unknown, limits: MaicImportLimits): string | undefined => {
  let values = 0;
  const walk = (item: unknown, depth: number): string | undefined => {
    values += 1;
    if (values > limits.maxJsonValues) return 'MAIC JSON contains too many values.';
    if (depth > limits.maxNestingDepth) return 'MAIC JSON nesting is too deep.';
    if (typeof item === 'string' && item.length > limits.maxStringCharacters) {
      return 'MAIC JSON contains a string above the configured limit.';
    }
    if (typeof item === 'number' && !Number.isFinite(item))
      return 'MAIC JSON contains a non-finite number.';
    if (Array.isArray(item)) {
      for (const child of item) {
        const error = walk(child, depth + 1);
        if (error) return error;
      }
    } else if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (unsafeKeys.has(key)) return `MAIC JSON contains forbidden key ${key}.`;
        const error = walk(child, depth + 1);
        if (error) return error;
      }
    }
    return undefined;
  };
  return walk(value, 0);
};

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const registerMediaReference = (
  resourceUrl: unknown,
  resourceKind: MaicMediaReference['kind'],
  location: {
    pageId: string;
    sourceOrder: number;
    elementId?: string;
    field?: string;
  },
  identity: (sourceUrl: string) => readonly string[],
  diagnostics: MaicDiagnostic[],
  media: MaicMediaReference[],
): string | undefined => {
  if (!nonEmptyString(resourceUrl)) {
    diagnostics.push(
      issue(
        'resource.missing_url',
        'error',
        resourceKind,
        'Media reference requires a source URL.',
        location,
      ),
    );
    return undefined;
  }
  let valid = false;
  try {
    const url = new URL(resourceUrl);
    valid =
      url.protocol === 'https:' &&
      allowedMediaHostnames.has(url.hostname) &&
      (url.port === '' || url.port === '443') &&
      !url.username &&
      !url.password &&
      !url.hash;
  } catch {
    valid = false;
  }
  if (!valid) {
    diagnostics.push(
      issue(
        'resource.url_not_allowed',
        'error',
        resourceKind,
        'Media URL is outside the supported MAIC course-media boundary.',
        location,
      ),
    );
    return undefined;
  }
  const id = createStableMaicId('media-ref', identity(resourceUrl));
  media.push({
    id,
    sourceUrl: resourceUrl,
    kind: resourceKind,
    pageId: location.pageId,
    ...(location.elementId === undefined ? {} : { elementId: location.elementId }),
  });
  return id;
};

interface MaicElementIdentityState {
  readonly reservedSourceIds: ReadonlySet<string>;
  readonly assignedIds: Set<string>;
  readonly occurrences: Map<string, number>;
}

const assignElementId = (
  sourceId: string,
  pageId: string,
  state: MaicElementIdentityState,
): { id: string; occurrence: number } => {
  const occurrence = (state.occurrences.get(sourceId) ?? 0) + 1;
  state.occurrences.set(sourceId, occurrence);
  if (occurrence === 1) {
    state.assignedIds.add(sourceId);
    return { id: sourceId, occurrence };
  }

  let collisionAttempt = 0;
  let id: string;
  do {
    id = createStableMaicId('duplicate-element', [
      pageId,
      sourceId,
      String(occurrence),
      String(collisionAttempt),
    ]);
    collisionAttempt += 1;
  } while (state.reservedSourceIds.has(id) || state.assignedIds.has(id));
  state.assignedIds.add(id);
  return { id, occurrence };
};

const parseElement = (
  source: unknown,
  pageId: string,
  sourceOrder: number,
  identityState: MaicElementIdentityState,
  diagnostics: MaicDiagnostic[],
  media: MaicMediaReference[],
): MaicElementIR | undefined => {
  const location = { pageId, sourceOrder };
  if (!isRecord(source) || !nonEmptyString(source.id) || !nonEmptyString(source.type)) {
    diagnostics.push(
      issue(
        'element.invalid',
        'error',
        'canvas',
        'Canvas element requires string id and type.',
        location,
      ),
    );
    return undefined;
  }
  const sourceId = source.id;
  const assigned = assignElementId(sourceId, pageId, identityState);
  if (assigned.occurrence > 1) {
    diagnostics.push({
      ...issue(
        'element.duplicate_id',
        'warning',
        'canvas',
        'Duplicate canvas element id was renamed deterministically for import.',
        { ...location, elementId: sourceId },
      ),
      details: {
        originalId: sourceId,
        remappedId: assigned.id,
        occurrence: assigned.occurrence,
      },
    });
  }
  const elementLocation = { ...location, elementId: assigned.id };
  if (!elementTypes.has(source.type)) {
    diagnostics.push(
      issue(
        'element.unsupported',
        'error',
        'canvas',
        `Unsupported canvas element type ${source.type}.`,
        elementLocation,
      ),
    );
    return undefined;
  }
  const requiredGeometry =
    source.type === 'line' ? ['left', 'top', 'width'] : ['left', 'top', 'width', 'height'];
  if (!requiredGeometry.every((key) => finiteNumber(source[key]))) {
    diagnostics.push(
      issue(
        'element.geometry',
        'error',
        'canvas',
        'Canvas element geometry must be finite numbers.',
        elementLocation,
      ),
    );
    return undefined;
  }
  if ((source.width as number) < 0 || (finiteNumber(source.height) && source.height < 0)) {
    diagnostics.push(
      issue(
        'element.geometry',
        'error',
        'canvas',
        'Canvas element dimensions cannot be negative.',
        elementLocation,
      ),
    );
    return undefined;
  }
  if (
    source.type === 'chart' &&
    readMaicLineChart(source, elementLocation, diagnostics) === undefined
  )
    return undefined;
  if (
    source.type === 'image' ||
    source.type === 'audio' ||
    (source.type === 'shape' && nonEmptyString(source.pattern))
  ) {
    const resourceUrl = source.type === 'shape' ? source.pattern : source.src;
    const resourceKind = source.type === 'audio' ? 'audio' : 'image';
    registerMediaReference(
      resourceUrl,
      resourceKind,
      elementLocation,
      (sourceUrl) => [pageId, assigned.id, sourceUrl],
      diagnostics,
      media,
    );
  }
  return {
    id: assigned.id,
    type: source.type as MaicElementIR['type'],
    left: source.left as number,
    top: source.top as number,
    width: source.width as number,
    height: finiteNumber(source.height) ? source.height : 0,
    rotate: finiteNumber(source.rotate) ? source.rotate : 0,
    source: structuredClone(source),
  };
};

const parsePage = (
  source: unknown,
  sourceOrder: number,
  defaultWidth: number,
  defaultHeight: number,
  seenPageIds: Set<string>,
  limits: MaicImportLimits,
  diagnostics: MaicDiagnostic[],
  media: MaicMediaReference[],
): MaicPageIR | undefined => {
  if (!isRecord(source) || !nonEmptyString(source.id) || !nonEmptyString(source.component_type)) {
    diagnostics.push(
      issue('page.invalid', 'error', 'document', 'Page requires string id and component_type.', {
        sourceOrder,
      }),
    );
    return undefined;
  }
  const location = { pageId: source.id, sourceOrder };
  if (seenPageIds.has(source.id)) {
    diagnostics.push(
      issue('page.duplicate_id', 'error', 'document', 'Page ids must be unique.', location),
    );
    return undefined;
  }
  seenPageIds.add(source.id);
  if (!pageKinds.has(source.component_type)) {
    diagnostics.push(
      issue(
        'page.unsupported',
        'error',
        'document',
        `Unsupported page kind ${source.component_type}.`,
        location,
      ),
    );
    return undefined;
  }
  const width =
    finiteNumber(source.canvas_width) && source.canvas_width > 0
      ? source.canvas_width
      : defaultWidth;
  const height =
    finiteNumber(source.canvas_height) && source.canvas_height > 0
      ? source.canvas_height
      : defaultHeight;
  if (source.component_type === 'canvas') {
    if (!Array.isArray(source.elements) || source.elements.length > limits.maxElementsPerPage) {
      diagnostics.push(
        issue(
          'canvas.elements_limit',
          'error',
          'canvas',
          `Canvas must contain no more than ${limits.maxElementsPerPage} elements.`,
          location,
        ),
      );
      return undefined;
    }
    const identityState: MaicElementIdentityState = {
      reservedSourceIds: new Set(
        source.elements.flatMap((item) =>
          isRecord(item) && nonEmptyString(item.id) ? [item.id] : [],
        ),
      ),
      assignedIds: new Set(),
      occurrences: new Map(),
    };
    const elements = source.elements.flatMap((item) => {
      const element = parseElement(
        item,
        source.id as string,
        sourceOrder,
        identityState,
        diagnostics,
        media,
      );
      return element ? [element] : [];
    });
    const imageBackground = readMaicCanvasImageBackground(source.background);
    const backgroundMediaReferenceId =
      imageBackground === undefined
        ? undefined
        : registerMediaReference(
            imageBackground.sourceUrl,
            'image',
            { ...location, field: 'background' },
            (sourceUrl) => [source.id as string, 'canvas-background', sourceUrl, 'background'],
            diagnostics,
            media,
          );
    if (source.script !== undefined && typeof source.script !== 'string')
      diagnostics.push(
        issue('narration.invalid', 'error', 'narration', 'Canvas script must be text.', location),
      );
    return {
      id: source.id,
      sourceOrder,
      kind: 'canvas',
      width,
      height,
      background: structuredClone(source.background),
      ...(backgroundMediaReferenceId === undefined ? {} : { backgroundMediaReferenceId }),
      elements,
      ...(typeof source.script === 'string' && source.script.trim()
        ? { script: source.script.trim() }
        : {}),
    };
  }
  if (source.component_type === 'quiz') {
    if (
      !Array.isArray(source.questions) ||
      source.questions.length === 0 ||
      !source.questions.every(isRecord)
    ) {
      diagnostics.push(
        issue(
          'quiz.invalid',
          'error',
          'quiz',
          'Quiz page must contain question objects.',
          location,
        ),
      );
      return undefined;
    }
    return {
      id: source.id,
      sourceOrder,
      kind: 'quiz',
      width,
      height,
      questions: structuredClone(source.questions),
    };
  }
  if (!isRecord(source.content) || typeof source.content.html !== 'string') {
    diagnostics.push(
      issue(
        'interactive.invalid',
        'error',
        'interactive',
        'Interactive page requires content.html.',
        location,
      ),
    );
    return undefined;
  }
  const transformed = transformMaicInteractiveHtml(source.content.html, location);
  diagnostics.push(...transformed.diagnostics);
  return {
    id: source.id,
    sourceOrder,
    kind: 'interactive',
    width,
    height,
    title:
      typeof source.content.title === 'string' && source.content.title.trim()
        ? source.content.title.trim()
        : `Interactive ${sourceOrder}`,
    html: source.content.html,
    ...(transformed.html ? { transformedHtml: transformed.html } : {}),
    runtimeDependencies: transformed.runtimeDependencies,
  };
};

const buildReport = (
  pages: readonly MaicPageIR[],
  diagnostics: readonly MaicDiagnostic[],
): MaicCapabilityReport => {
  const sorted = sortDiagnostics(diagnostics);
  const pageReports: MaicCapabilityPageReport[] = pages.map((page) => {
    const pageDiagnostics = sorted.filter((entry) => entry.location?.pageId === page.id);
    const status = pageDiagnostics.some(
      (entry) => entry.severity === 'error' || entry.severity === 'fatal',
    )
      ? 'error'
      : pageDiagnostics.some((entry) => entry.severity === 'warning')
        ? 'warning'
        : 'ok';
    return {
      pageId: page.id,
      sourceOrder: page.sourceOrder,
      kind: page.kind,
      status,
      diagnostics: pageDiagnostics,
    };
  });
  const features = new Map<MaicCapabilityEntry['feature'], MaicCapabilityEntry>();
  for (const page of pages)
    features.set(page.kind, {
      feature: page.kind,
      status: page.kind === 'interactive' ? 'conditional' : 'native',
    });
  return {
    schemaVersion: 'maic-capability-report/v1',
    entries: [...features.values()].sort((left, right) =>
      left.feature.localeCompare(right.feature),
    ),
    diagnostics: sorted,
    pageReports,
    canApply: pageReports.some((page) => page.status !== 'error'),
  };
};

export const parseMaicCourse = (
  input: Uint8Array | string,
  limitOverrides: Partial<MaicImportLimits> = {},
): MaicParseResult => {
  const limits = { ...MAIC_IMPORT_LIMITS, ...limitOverrides } as MaicImportLimits;
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxSourceBytes) {
    const diagnostics = [
      issue(
        'source.size',
        'fatal',
        'document',
        `MAIC source must contain 1-${limits.maxSourceBytes} bytes.`,
      ),
    ];
    return { ok: false, diagnostics, capabilityReport: emptyReport(diagnostics) };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    const diagnostics = [
      issue('source.utf8', 'fatal', 'document', 'MAIC source must be valid UTF-8.'),
    ];
    return { ok: false, diagnostics, capabilityReport: emptyReport(diagnostics) };
  }
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    const diagnostics = [
      issue('source.json', 'fatal', 'document', 'MAIC source is not valid JSON.'),
    ];
    return { ok: false, diagnostics, capabilityReport: emptyReport(diagnostics) };
  }
  const boundsError = boundedTraversal(source, limits);
  if (boundsError) {
    const diagnostics = [issue('source.bounds', 'fatal', 'document', boundsError)];
    return { ok: false, diagnostics, capabilityReport: emptyReport(diagnostics) };
  }
  if (
    !isRecord(source) ||
    !nonEmptyString(source.title) ||
    !finiteNumber(source.width) ||
    source.width <= 0 ||
    !finiteNumber(source.height) ||
    source.height <= 0 ||
    !Array.isArray(source.slides) ||
    source.slides.length === 0 ||
    source.slides.length > limits.maxPages
  ) {
    const diagnostics = [
      issue(
        'document.structure',
        'fatal',
        'document',
        `MAIC document requires title, positive dimensions, and 1-${limits.maxPages} slides.`,
      ),
    ];
    return { ok: false, diagnostics, capabilityReport: emptyReport(diagnostics) };
  }
  const diagnostics: MaicDiagnostic[] = [];
  const mediaReferences: MaicMediaReference[] = [];
  const seenPageIds = new Set<string>();
  const pages = source.slides.flatMap((page, index) => {
    const parsed = parsePage(
      page,
      index + 1,
      source.width as number,
      source.height as number,
      seenPageIds,
      limits,
      diagnostics,
      mediaReferences,
    );
    return parsed ? [parsed] : [];
  });
  const capabilityReport = buildReport(pages, diagnostics);
  const ir: MaicCourseIR = {
    schemaVersion: 'maic-course-ir/v1',
    sourceDigest: createMaicSourceDigest(bytes),
    title: source.title,
    width: source.width,
    height: source.height,
    pages,
    mediaReferences: mediaReferences.sort((left, right) => left.id.localeCompare(right.id)),
  };
  return { ok: true, ir, diagnostics: capabilityReport.diagnostics, capabilityReport };
};

export const collectMaicMediaReferences = (ir: MaicCourseIR): readonly MaicMediaReference[] => [
  ...ir.mediaReferences,
];
