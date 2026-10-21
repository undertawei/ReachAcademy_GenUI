import {
  sortPptxDiagnostics,
  type PptxDiagnostic,
  type PptxDiagnosticLocation,
} from '../diagnostics.js';
import {
  resolvePptxFont,
  type PptxFontCatalog,
  type PptxFontRequest,
  type PptxResolvedFont,
  type PptxThemeFontScheme,
} from './fonts.js';

export interface PptxFontMetricsRequest {
  readonly family: string;
  readonly text: string;
  readonly fontSizePt: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly letterSpacingPt: number;
}

export interface PptxMeasuredText {
  readonly advanceWidthPt: number;
  readonly ascentPt: number;
  readonly descentPt: number;
  readonly lineGapPt: number;
}

export interface PptxFontMetricsProvider {
  readonly version: string;
  /** Returns undefined when the exact family/style cannot be measured. */
  measureText(request: PptxFontMetricsRequest): PptxMeasuredText | undefined;
}

export interface PptxTextRunForFit {
  readonly id: string;
  readonly text: string;
  readonly font: PptxFontRequest;
  readonly fontSizePt: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly letterSpacingPt: number;
}

export interface PptxListForFit {
  readonly level: number;
  readonly markerText: string;
  /** Space reserved before the text content, including the marker. */
  readonly indentationPt: number;
  readonly markerGapPt: number;
}

export interface PptxTextParagraphForFit {
  readonly id: string;
  readonly runs: readonly PptxTextRunForFit[];
  readonly list?: PptxListForFit;
  readonly lineSpacingMultiplier: number;
  readonly spaceBeforePt: number;
  readonly spaceAfterPt: number;
}

export type PptxAutoFitConstraint =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'shrink';
      readonly minimumFontScale: number;
      readonly fontScaleStep: number;
      readonly maximumLineSpacingReduction: number;
      readonly lineSpacingReductionStep: number;
    };

export interface PptxTextFrameFitRequest {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly insetLeftPt: number;
  readonly insetRightPt: number;
  readonly insetTopPt: number;
  readonly insetBottomPt: number;
  readonly wrap: boolean;
  readonly tolerancePt: number;
  readonly autoFit: PptxAutoFitConstraint;
  readonly paragraphs: readonly PptxTextParagraphForFit[];
  readonly location?: PptxDiagnosticLocation;
}

export interface PptxResolvedTextRunForFit extends PptxTextRunForFit {
  readonly resolvedFont: PptxResolvedFont;
  readonly fittedFontSizePt: number;
}

export interface PptxParagraphFitMeasurement {
  readonly paragraphId: string;
  readonly listLevel?: number;
  readonly lineCount: number;
  readonly maximumLineWidthPt: number;
  readonly heightPt: number;
  readonly markerWidthPt?: number;
}

export interface PptxTextFitMeasurement {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly paragraphs: readonly PptxParagraphFitMeasurement[];
}

export type PptxTextFrameFitResult =
  | {
      readonly ok: true;
      readonly catalogVersion: string;
      readonly metricsVersion: string;
      readonly fontScale: number;
      readonly lineSpacingReduction: number;
      readonly runs: readonly PptxResolvedTextRunForFit[];
      readonly measurement: PptxTextFitMeasurement;
      readonly diagnostics: readonly PptxDiagnostic[];
    }
  | {
      readonly ok: false;
      /** Present when font resolution completed before fitting was blocked. */
      readonly runs?: readonly PptxResolvedTextRunForFit[];
      readonly diagnostics: readonly PptxDiagnostic[];
    };

interface ResolvedParagraph {
  readonly paragraph: PptxTextParagraphForFit;
  readonly runs: readonly (PptxTextRunForFit & { readonly resolvedFont: PptxResolvedFont })[];
}

interface MeasurementAttempt {
  readonly measurement: PptxTextFitMeasurement;
  readonly runs: readonly PptxResolvedTextRunForFit[];
  readonly fits: boolean;
  readonly missingMetrics?: {
    readonly runId: string;
    readonly family: string;
    readonly requestedFamily: string;
    readonly reason: PptxResolvedFont['reason'];
  };
}

const finite = (value: number, minimum: number, _label: string): boolean =>
  Number.isFinite(value) && value >= minimum;

const fittingDiagnostic = (
  code: `pptx.text.${string}` | `pptx.font.${string}`,
  feature: 'text-frame' | 'font-substitution',
  message: string,
  details: Readonly<Record<string, string | number | boolean>>,
  location?: PptxDiagnosticLocation,
): PptxDiagnostic => ({
  code,
  severity: 'error',
  feature,
  message,
  details,
  ...(location ? { location } : {}),
});

const validateRequest = (request: PptxTextFrameFitRequest): PptxDiagnostic | undefined => {
  const dimensions: readonly [string, number, number][] = [
    ['widthPt', request.widthPt, Number.EPSILON],
    ['heightPt', request.heightPt, Number.EPSILON],
    ['insetLeftPt', request.insetLeftPt, 0],
    ['insetRightPt', request.insetRightPt, 0],
    ['insetTopPt', request.insetTopPt, 0],
    ['insetBottomPt', request.insetBottomPt, 0],
    ['tolerancePt', request.tolerancePt, 0],
  ];
  const invalid = dimensions.find(([label, value, minimum]) => !finite(value, minimum, label));
  if (invalid) {
    return fittingDiagnostic(
      'pptx.text.invalid_fit_constraints',
      'text-frame',
      `${invalid[0]} is not a valid text-fitting constraint.`,
      { field: invalid[0], value: invalid[1] },
      request.location,
    );
  }
  if (
    request.widthPt - request.insetLeftPt - request.insetRightPt <= 0 ||
    request.heightPt - request.insetTopPt - request.insetBottomPt <= 0 ||
    request.paragraphs.length === 0 ||
    request.paragraphs.some(
      (paragraph) =>
        paragraph.runs.length === 0 ||
        !finite(paragraph.lineSpacingMultiplier, Number.EPSILON, 'lineSpacingMultiplier') ||
        !finite(paragraph.spaceBeforePt, 0, 'spaceBeforePt') ||
        !finite(paragraph.spaceAfterPt, 0, 'spaceAfterPt') ||
        paragraph.runs.some(
          (run) =>
            run.id.length === 0 ||
            !finite(run.fontSizePt, Number.EPSILON, 'fontSizePt') ||
            !finite(run.fontWeight, 1, 'fontWeight') ||
            run.fontWeight > 1_000 ||
            !finite(run.letterSpacingPt, -Number.MAX_VALUE, 'letterSpacingPt'),
        ) ||
        (paragraph.list !== undefined &&
          (!Number.isSafeInteger(paragraph.list.level) ||
            paragraph.list.level < 0 ||
            paragraph.list.markerText.length === 0 ||
            !finite(paragraph.list.indentationPt, 0, 'indentationPt') ||
            !finite(paragraph.list.markerGapPt, 0, 'markerGapPt'))),
    )
  ) {
    return fittingDiagnostic(
      'pptx.text.invalid_fit_constraints',
      'text-frame',
      'Paragraph, run, or list fitting constraints are invalid.',
      {},
      request.location,
    );
  }
  if (request.autoFit.mode === 'shrink') {
    const autoFit = request.autoFit;
    if (
      !finite(autoFit.minimumFontScale, Number.EPSILON, 'minimumFontScale') ||
      autoFit.minimumFontScale > 1 ||
      !finite(autoFit.fontScaleStep, Number.EPSILON, 'fontScaleStep') ||
      autoFit.fontScaleStep > 1 ||
      !finite(autoFit.maximumLineSpacingReduction, 0, 'maximumLineSpacingReduction') ||
      autoFit.maximumLineSpacingReduction >= 1 ||
      !finite(autoFit.lineSpacingReductionStep, Number.EPSILON, 'lineSpacingReductionStep') ||
      autoFit.lineSpacingReductionStep > 1
    ) {
      return fittingDiagnostic(
        'pptx.text.invalid_fit_constraints',
        'text-frame',
        'Autofit constraints are invalid.',
        {},
        request.location,
      );
    }
  }
  return undefined;
};

const resolveParagraphs = (
  request: PptxTextFrameFitRequest,
  catalog: PptxFontCatalog,
  theme: PptxThemeFontScheme,
):
  | {
      readonly ok: true;
      readonly paragraphs: readonly ResolvedParagraph[];
      diagnostics: PptxDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly PptxDiagnostic[] } => {
  const diagnostics: PptxDiagnostic[] = [];
  const paragraphs: ResolvedParagraph[] = [];
  for (const paragraph of request.paragraphs) {
    const runs: Array<PptxTextRunForFit & { readonly resolvedFont: PptxResolvedFont }> = [];
    for (const run of paragraph.runs) {
      const resolution = resolvePptxFont(run.font, catalog, theme, request.location);
      diagnostics.push(...resolution.diagnostics);
      if (!resolution.ok) return { ok: false, diagnostics: sortPptxDiagnostics(diagnostics) };
      runs.push(Object.freeze({ ...run, resolvedFont: resolution.font }));
    }
    paragraphs.push(Object.freeze({ paragraph, runs: Object.freeze(runs) }));
  }
  return { ok: true, paragraphs: Object.freeze(paragraphs), diagnostics };
};

interface MeasuredToken {
  readonly width: number;
  readonly height: number;
}

const isCjk = (character: string): boolean => {
  const codePoint = character.codePointAt(0)!;
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
};

const tokenize = (text: string): string[] => {
  const tokens: string[] = [];
  let pending = '';
  let pendingWhitespace: boolean | undefined;
  const flush = () => {
    if (pending.length > 0) tokens.push(pending);
    pending = '';
    pendingWhitespace = undefined;
  };
  for (const character of Array.from(text.replace(/\r\n?/g, '\n'))) {
    if (character === '\n' || isCjk(character)) {
      flush();
      tokens.push(character);
      continue;
    }
    const whitespace = /\s/u.test(character);
    if (pendingWhitespace !== undefined && pendingWhitespace !== whitespace) flush();
    pendingWhitespace = whitespace;
    pending += character;
  }
  flush();
  return tokens;
};

const candidateValues = (maximum: number, minimum: number, step: number): number[] => {
  const values: number[] = [];
  const count = Math.floor((maximum - minimum) / step + 1e-12);
  for (let index = 0; index <= count; index += 1) {
    values.push(Math.max(minimum, maximum - index * step));
  }
  if (values.at(-1)! > minimum) values.push(minimum);
  return values;
};

const measureAttempt = (
  request: PptxTextFrameFitRequest,
  paragraphs: readonly ResolvedParagraph[],
  metrics: PptxFontMetricsProvider,
  fontScale: number,
  lineSpacingReduction: number,
): MeasurementAttempt => {
  const availableWidth = request.widthPt - request.insetLeftPt - request.insetRightPt;
  const availableHeight = request.heightPt - request.insetTopPt - request.insetBottomPt;
  const fittedRuns: PptxResolvedTextRunForFit[] = [];
  const paragraphMeasurements: PptxParagraphFitMeasurement[] = [];
  let totalHeight = 0;
  let maximumWidth = 0;
  let widthOverflow = false;

  for (const { paragraph, runs } of paragraphs) {
    const fittedParagraphRuns = runs.map((run) => {
      const fitted = Object.freeze({
        ...run,
        fittedFontSizePt: run.fontSizePt * fontScale,
      });
      fittedRuns.push(fitted);
      return fitted;
    });
    const firstRun = fittedParagraphRuns[0]!;
    const measure = (text: string, run: PptxResolvedTextRunForFit): MeasuredToken | undefined => {
      const measured = metrics.measureText({
        family: run.resolvedFont.resolvedFamily,
        text,
        fontSizePt: run.fittedFontSizePt,
        fontWeight: run.fontWeight,
        italic: run.italic,
        letterSpacingPt: run.letterSpacingPt,
      });
      if (
        !measured ||
        !finite(measured.advanceWidthPt, 0, 'advanceWidthPt') ||
        !finite(measured.ascentPt, 0, 'ascentPt') ||
        !finite(measured.descentPt, 0, 'descentPt') ||
        !finite(measured.lineGapPt, 0, 'lineGapPt')
      ) {
        return undefined;
      }
      return {
        width: measured.advanceWidthPt,
        height: measured.ascentPt + measured.descentPt + measured.lineGapPt,
      };
    };

    const baseMetrics = measure('M', firstRun);
    if (!baseMetrics) {
      return {
        fits: false,
        runs: fittedRuns,
        measurement: { widthPt: 0, heightPt: 0, paragraphs: [] },
        missingMetrics: {
          runId: firstRun.id,
          family: firstRun.resolvedFont.resolvedFamily,
          requestedFamily: firstRun.resolvedFont.requestedFamily,
          reason: firstRun.resolvedFont.reason,
        },
      };
    }

    let indentation = 0;
    let markerWidth: number | undefined;
    if (paragraph.list) {
      indentation = paragraph.list.indentationPt;
      const marker = measure(paragraph.list.markerText, firstRun);
      if (!marker) {
        return {
          fits: false,
          runs: fittedRuns,
          measurement: { widthPt: 0, heightPt: 0, paragraphs: [] },
          missingMetrics: {
            runId: firstRun.id,
            family: firstRun.resolvedFont.resolvedFamily,
            requestedFamily: firstRun.resolvedFont.requestedFamily,
            reason: firstRun.resolvedFont.reason,
          },
        };
      }
      markerWidth = marker.width;
      if (marker.width + paragraph.list.markerGapPt > indentation + request.tolerancePt) {
        widthOverflow = true;
      }
    }

    const lineWidthLimit = availableWidth - indentation;
    if (lineWidthLimit <= 0) widthOverflow = true;
    let currentWidth = 0;
    let currentHeight = baseMetrics.height;
    let lineCount = 0;
    let paragraphMaximumWidth = 0;
    let linesHeight = 0;
    const finishLine = () => {
      paragraphMaximumWidth = Math.max(paragraphMaximumWidth, indentation + currentWidth);
      linesHeight += currentHeight * paragraph.lineSpacingMultiplier * (1 - lineSpacingReduction);
      lineCount += 1;
      currentWidth = 0;
      currentHeight = baseMetrics.height;
    };

    for (const run of fittedParagraphRuns) {
      for (const token of tokenize(run.text)) {
        if (token === '\n') {
          finishLine();
          continue;
        }
        const tokenMetrics = measure(token, run);
        if (!tokenMetrics) {
          return {
            fits: false,
            runs: fittedRuns,
            measurement: { widthPt: 0, heightPt: 0, paragraphs: [] },
            missingMetrics: {
              runId: run.id,
              family: run.resolvedFont.resolvedFamily,
              requestedFamily: run.resolvedFont.requestedFamily,
              reason: run.resolvedFont.reason,
            },
          };
        }
        if (!request.wrap || currentWidth + tokenMetrics.width <= lineWidthLimit) {
          currentWidth += tokenMetrics.width;
          currentHeight = Math.max(currentHeight, tokenMetrics.height);
          continue;
        }
        if (currentWidth > 0) finishLine();
        if (tokenMetrics.width <= lineWidthLimit) {
          currentWidth = tokenMetrics.width;
          currentHeight = Math.max(currentHeight, tokenMetrics.height);
          continue;
        }
        for (const character of Array.from(token)) {
          const characterMetrics = measure(character, run);
          if (!characterMetrics) {
            return {
              fits: false,
              runs: fittedRuns,
              measurement: { widthPt: 0, heightPt: 0, paragraphs: [] },
              missingMetrics: {
                runId: run.id,
                family: run.resolvedFont.resolvedFamily,
                requestedFamily: run.resolvedFont.requestedFamily,
                reason: run.resolvedFont.reason,
              },
            };
          }
          if (characterMetrics.width > lineWidthLimit + request.tolerancePt) widthOverflow = true;
          if (currentWidth > 0 && currentWidth + characterMetrics.width > lineWidthLimit)
            finishLine();
          currentWidth += characterMetrics.width;
          currentHeight = Math.max(currentHeight, characterMetrics.height);
        }
      }
    }
    finishLine();
    const paragraphHeight = paragraph.spaceBeforePt + linesHeight + paragraph.spaceAfterPt;
    totalHeight += paragraphHeight;
    maximumWidth = Math.max(maximumWidth, paragraphMaximumWidth);
    paragraphMeasurements.push(
      Object.freeze({
        paragraphId: paragraph.id,
        ...(paragraph.list ? { listLevel: paragraph.list.level } : {}),
        lineCount,
        maximumLineWidthPt: paragraphMaximumWidth,
        heightPt: paragraphHeight,
        ...(markerWidth === undefined ? {} : { markerWidthPt: markerWidth }),
      }),
    );
  }

  const measurement = Object.freeze({
    widthPt: maximumWidth,
    heightPt: totalHeight,
    paragraphs: Object.freeze(paragraphMeasurements),
  });
  return {
    measurement,
    runs: Object.freeze(fittedRuns),
    fits:
      !widthOverflow &&
      maximumWidth <= availableWidth + request.tolerancePt &&
      totalHeight <= availableHeight + request.tolerancePt,
  };
};

export const fitPptxTextFrame = (
  request: PptxTextFrameFitRequest,
  catalog: PptxFontCatalog,
  theme: PptxThemeFontScheme,
  metrics: PptxFontMetricsProvider,
): PptxTextFrameFitResult => {
  const invalid = validateRequest(request);
  if (invalid) return { ok: false, diagnostics: [invalid] };
  if (metrics.version.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [
        fittingDiagnostic(
          'pptx.font.metrics_missing',
          'font-substitution',
          'The font metrics provider must have a stable version.',
          {},
          request.location,
        ),
      ],
    };
  }

  const resolved = resolveParagraphs(request, catalog, theme);
  if (!resolved.ok) return resolved;
  const scales =
    request.autoFit.mode === 'none'
      ? [1]
      : candidateValues(1, request.autoFit.minimumFontScale, request.autoFit.fontScaleStep);
  const reductions =
    request.autoFit.mode === 'none'
      ? [0]
      : candidateValues(
          request.autoFit.maximumLineSpacingReduction,
          0,
          request.autoFit.lineSpacingReductionStep,
        ).reverse();

  let lastAttempt: MeasurementAttempt | undefined;
  for (const fontScale of scales) {
    for (const lineSpacingReduction of reductions) {
      const attempt = measureAttempt(
        request,
        resolved.paragraphs,
        metrics,
        fontScale,
        lineSpacingReduction,
      );
      lastAttempt = attempt;
      if (attempt.missingMetrics) {
        return {
          ok: false,
          runs: attempt.runs,
          diagnostics: sortPptxDiagnostics([
            ...resolved.diagnostics,
            fittingDiagnostic(
              'pptx.font.metrics_missing',
              'font-substitution',
              `Metrics are unavailable for ${attempt.missingMetrics.family}.`,
              {
                family: attempt.missingMetrics.family,
                requestedFamily: attempt.missingMetrics.requestedFamily,
                reason: attempt.missingMetrics.reason,
                runId: attempt.missingMetrics.runId,
                metricsVersion: metrics.version,
              },
              request.location,
            ),
          ]),
        };
      }
      if (attempt.fits) {
        return {
          ok: true,
          catalogVersion: catalog.version,
          metricsVersion: metrics.version,
          fontScale,
          lineSpacingReduction,
          runs: attempt.runs,
          measurement: attempt.measurement,
          diagnostics: sortPptxDiagnostics(resolved.diagnostics),
        };
      }
    }
  }

  const availableWidth = request.widthPt - request.insetLeftPt - request.insetRightPt;
  const availableHeight = request.heightPt - request.insetTopPt - request.insetBottomPt;
  return {
    ok: false,
    ...(lastAttempt ? { runs: lastAttempt.runs } : {}),
    diagnostics: sortPptxDiagnostics([
      ...resolved.diagnostics,
      fittingDiagnostic(
        'pptx.text.overflow_after_substitution',
        'text-frame',
        'Text still overflows after applying every permitted deterministic autofit step.',
        {
          availableWidthPt: availableWidth,
          availableHeightPt: availableHeight,
          measuredWidthPt: lastAttempt?.measurement.widthPt ?? 0,
          measuredHeightPt: lastAttempt?.measurement.heightPt ?? 0,
          minimumFontScale: request.autoFit.mode === 'none' ? 1 : request.autoFit.minimumFontScale,
          catalogVersion: catalog.version,
          metricsVersion: metrics.version,
        },
        request.location,
      ),
    ]),
  };
};
