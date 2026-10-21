'use client';

import { TeacherLoadingIcon } from '../TeacherLoading';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { AlertTriangle, CircleAlert, FileUp, Sparkles, X } from 'lucide-react';

import {
  ReachDeckClient,
  createReachDeckUuid,
  type ReachDeckMaicPageReport,
  type ReachDeckMaicPreflightResult,
  type ReachDeckModuleContext,
  type ReachDeckPptxPageReport,
  type ReachDeckPptxPreflightResult,
} from '@reachany/reach-deck-client';
import { NativeV2SlideRenderer, ReachDeckPlayer } from '@reachany/reach-deck-player';
import {
  REACH_DECK_PPTX_MAX_UPLOAD_BYTES,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { PortalTranslator } from '@/src/lib/i18n';

export type ReachDeckPptxImportRequest =
  | { mode: 'create' }
  | { mode: 'insert-after'; afterPageId: string; anchorTitle: string }
  | { mode: 'before-first' };

export interface ReachDeckPptxConfirmation {
  completionAction?: 'generate-narration';
  file: File;
  idempotencyKey: string;
  request: ReachDeckPptxImportRequest;
  result: ReachDeckPptxPreflightResult;
  /** 用户点击了“仍然导入”：跳过 error 页、接受 warning 页的内容损失。 */
  acceptDegraded: boolean;
}

export type ReachDeckMaicImportRequest = ReachDeckPptxImportRequest;

export interface ReachDeckMaicConfirmation {
  completionAction?: 'generate-narration';
  file: File;
  idempotencyKey: string;
  request: ReachDeckMaicImportRequest;
  result: ReachDeckMaicPreflightResult;
  acceptDegraded: boolean;
}

export function createPptxImportIdempotencyKey(): string {
  try {
    return createReachDeckUuid();
  } catch {
    throw new Error('A cryptographically secure UUID generator is required to import PPTX files');
  }
}

export const createMaicImportIdempotencyKey = createPptxImportIdempotencyKey;

/** 导入类对话框共用的按钮外观。Interactive HTML 上传面板复用同一套。 */
export const reachDeckImportSecondaryButtonClass =
  'min-h-10 rounded-lg border border-[#d8cdd2] bg-white px-4 py-2 text-sm font-bold text-[#5e3853] shadow-sm transition hover:border-[#bdaeb5] hover:bg-[#fffdfb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9d7a8d] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55';

export const reachDeckImportPrimaryButtonClass =
  'flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#f45f22] px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-[#dd4f15] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f45f22] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-65';

const secondaryButtonClass = reachDeckImportSecondaryButtonClass;
const primaryButtonClass = reachDeckImportPrimaryButtonClass;

/** Shared mutation-free upload and preview dialog for both PPTX product entry points. */
export function ReachDeckPptxImportPanel(props: {
  client: ReachDeckClient;
  context: ReachDeckModuleContext;
  onClose: () => void;
  onConfirm?: (confirmation: ReachDeckPptxConfirmation) => Promise<void> | void;
  request: ReachDeckPptxImportRequest;
  createIdempotencyKey?: () => string;
}) {
  return (
    <ReachDeckImportPanel
      accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
      client={props.client}
      context={props.context}
      createIdempotencyKey={props.createIdempotencyKey}
      format="pptx"
      onClose={props.onClose}
      onConfirm={
        props.onConfirm === undefined
          ? undefined
          : (confirmation) => {
              if (confirmation.result.schemaVersion !== 'reach-deck-pptx-preflight/v1') {
                throw new Error('PPTX import confirmation format mismatch');
              }
              return props.onConfirm?.({ ...confirmation, result: confirmation.result });
            }
      }
      request={props.request}
    />
  );
}

export function ReachDeckMaicImportPanel(props: {
  client: ReachDeckClient;
  context: ReachDeckModuleContext;
  onClose: () => void;
  onConfirm?: (confirmation: ReachDeckMaicConfirmation) => Promise<void> | void;
  request: ReachDeckMaicImportRequest;
  createIdempotencyKey?: () => string;
}) {
  return (
    <ReachDeckImportPanel
      accept=".json,application/json"
      client={props.client}
      context={props.context}
      createIdempotencyKey={props.createIdempotencyKey}
      format="maic"
      onClose={props.onClose}
      onConfirm={
        props.onConfirm === undefined
          ? undefined
          : (confirmation) => {
              if (confirmation.result.schemaVersion !== 'reach-deck-maic-preflight/v1') {
                throw new Error('MAIC import confirmation format mismatch');
              }
              return props.onConfirm?.({ ...confirmation, result: confirmation.result });
            }
      }
      request={props.request}
    />
  );
}

type ImportPreflightResult = ReachDeckPptxPreflightResult | ReachDeckMaicPreflightResult;
type ImportPageReport = ReachDeckPptxPageReport | ReachDeckMaicPageReport;
type ImportDiagnostic = ImportPreflightResult['diagnostics'][number];
type ImportRequest = ReachDeckPptxImportRequest;
type JsonImportFormat = 'maic' | 'invalid' | 'unsupported';
interface ImportConfirmation {
  completionAction?: 'generate-narration';
  file: File;
  idempotencyKey: string;
  request: ImportRequest;
  result: ImportPreflightResult;
  acceptDegraded: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read JSON file'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Unable to read JSON file'));
    reader.readAsText(file, 'utf-8');
  });
}

async function detectJsonImportFormat(file: File): Promise<JsonImportFormat> {
  let source: unknown;
  try {
    source = JSON.parse(await readJsonFileText(file));
  } catch {
    return 'invalid';
  }
  if (
    isJsonObject(source) &&
    typeof source.title === 'string' &&
    typeof source.width === 'number' &&
    Number.isFinite(source.width) &&
    typeof source.height === 'number' &&
    Number.isFinite(source.height) &&
    Array.isArray(source.slides)
  ) {
    return 'maic';
  }
  return 'unsupported';
}

/**
 * Stages the import routes report. Unknown values fall back to the generic
 * label rather than surfacing a raw server token.
 */
const IMPORT_STAGE_KEYS = {
  reading: 'reachDeck.import.stage.reading',
  mapping: 'reachDeck.import.stage.mapping',
  writing: 'reachDeck.import.stage.writing',
} as const;

type ImportStage = keyof typeof IMPORT_STAGE_KEYS;

const asImportStage = (value: string): ImportStage | undefined =>
  value in IMPORT_STAGE_KEYS ? (value as ImportStage) : undefined;

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);

function publicImportText(value: string, format: 'pptx' | 'maic', t: PortalTranslator): string {
  if (value === 'MAIC media preview expired or is unavailable; parse and preview the file again') {
    return t('reachDeck.import.previewExpired');
  }
  if (value === 'MAIC mapping identity does not match the previewed candidate') {
    return t('reachDeck.import.previewChanged');
  }
  return format === 'maic'
    ? value.replace(/\bMAIC JSON\b/gi, 'JSON').replace(/\bMAIC\b/gi, 'JSON')
    : value;
}

function publicDiagnosticCode(value: string, format: 'pptx' | 'maic'): string {
  return format === 'maic' ? value.replace(/^maic\./i, '') : value;
}

function importDiagnosticText(
  diagnostic: ImportDiagnostic,
  format: 'pptx' | 'maic',
  t: PortalTranslator,
): string {
  const details = diagnostic.details;
  if (format === 'maic') {
    const chartKeys: Record<string, string> = {
      'maic.chart.option_unsupported': 'reachDeck.import.diagnostic.chartOptionUnsupported',
      'maic.chart.color_unsupported': 'reachDeck.import.diagnostic.chartColorUnsupported',
      'maic.chart.data_invalid': 'reachDeck.import.diagnostic.chartDataInvalid',
      'maic.chart.type_unsupported': 'reachDeck.import.diagnostic.chartTypeUnsupported',
    };
    const key = chartKeys[diagnostic.code];
    if (key) {
      const field =
        diagnostic.location && 'field' in diagnostic.location
          ? diagnostic.location.field
          : undefined;
      if (diagnostic.code === 'maic.chart.option_unsupported' && field === 'options.lineSmooth') {
        return t('reachDeck.import.diagnostic.chartStraightLines');
      }
      return t(key, {
        field:
          typeof field === 'string' && field.length > 0
            ? field
            : t('reachDeck.import.diagnostic.chartField'),
      });
    }
  }
  if (
    format === 'maic' &&
    diagnostic.code === 'maic.media.image_normalized' &&
    isJsonObject(details) &&
    typeof details.sourceContentType === 'string' &&
    details.sourceContentType.length > 0 &&
    typeof details.sourceByteLength === 'number' &&
    Number.isSafeInteger(details.sourceByteLength) &&
    details.sourceByteLength >= 0 &&
    typeof details.storedContentType === 'string' &&
    details.storedContentType.length > 0 &&
    typeof details.storedByteLength === 'number' &&
    Number.isSafeInteger(details.storedByteLength) &&
    details.storedByteLength >= 0
  ) {
    return t('reachDeck.import.diagnostic.imageNormalized', {
      sourceType: details.sourceContentType,
      sourceBytes: details.sourceByteLength,
      storedType: details.storedContentType,
      storedBytes: details.storedByteLength,
    });
  }
  return publicImportText(diagnostic.message, format, t);
}

function ReachDeckImportPanel(props: {
  accept: string;
  client: ReachDeckClient;
  context: ReachDeckModuleContext;
  createIdempotencyKey?: () => string;
  format: 'pptx' | 'maic';
  onClose: () => void;
  onConfirm?: (confirmation: ImportConfirmation) => Promise<void> | void;
  request: ImportRequest;
}) {
  const { locale, t } = usePortalI18n();
  const [file, setFile] = useState<File>();
  const [idempotencyKey, setIdempotencyKey] = useState<string>();
  const [result, setResult] = useState<ImportPreflightResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'preflight' | 'apply'>();
  const [stage, setStage] = useState<ImportStage>();
  const requestKey =
    props.request.mode === 'insert-after'
      ? `insert-after:${props.request.afterPageId}`
      : props.request.mode;

  useEffect(() => {
    setFile(undefined);
    setIdempotencyKey(undefined);
    setResult(undefined);
    setError(undefined);
    setBusy(undefined);
    setStage(undefined);
  }, [requestKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onClose();
    };
    if (busy !== undefined) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, props.onClose]);

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    // Refuse an oversized deck at selection time: uploading it only to be
    // rejected server-side costs the teacher minutes and tells them nothing.
    if (nextFile !== undefined && nextFile.size > REACH_DECK_PPTX_MAX_UPLOAD_BYTES) {
      setFile(undefined);
      setIdempotencyKey(undefined);
      setResult(undefined);
      setError(
        t('reachDeck.import.fileTooLarge', {
          size: megabytes(nextFile.size),
          limit: megabytes(REACH_DECK_PPTX_MAX_UPLOAD_BYTES),
        }),
      );
      return;
    }
    setFile(nextFile);
    setIdempotencyKey(
      nextFile === undefined
        ? undefined
        : (props.createIdempotencyKey ?? createPptxImportIdempotencyKey)(),
    );
    setResult(undefined);
    setError(undefined);
  };

  const runPreflight = async () => {
    if (file === undefined || idempotencyKey === undefined || busy !== undefined) return;
    setBusy('preflight');
    setStage(undefined);
    setError(undefined);
    try {
      const target =
        props.request.mode === 'insert-after'
          ? ({ mode: 'insert-after', afterPageId: props.request.afterPageId } as const)
          : props.request;
      if (props.format === 'pptx') {
        setResult(
          await props.client.preflightPptx(props.context, file, target, {
            idempotencyKey,
            onProgress: (reported) => setStage(asImportStage(reported)),
          }),
        );
      } else {
        const detectedFormat = await detectJsonImportFormat(file);
        if (detectedFormat === 'invalid') {
          throw new Error(t('reachDeck.import.jsonInvalid'));
        }
        if (detectedFormat === 'unsupported') {
          throw new Error(t('reachDeck.import.jsonUnsupported'));
        }
        setResult(
          await props.client.preflightMaic(props.context, file, target, { idempotencyKey }),
        );
      }
    } catch (cause) {
      setResult(undefined);
      setError(
        publicImportText(
          cause instanceof Error ? cause.message : t('reachDeck.import.preflightFailed'),
          props.format,
          t,
        ),
      );
    } finally {
      setBusy(undefined);
    }
  };

  const applyingRef = useRef(false);
  const appliedActionRef = useRef<'generate-narration' | 'import' | undefined>(undefined);
  useEffect(() => {
    appliedActionRef.current = undefined;
  }, [idempotencyKey]);
  const confirm = async (acceptDegraded: boolean, completionAction?: 'generate-narration') => {
    const applicable = acceptDegraded
      ? result?.ok === true && result.canApplyDegraded
      : result?.canApply === true;
    if (
      file === undefined ||
      idempotencyKey === undefined ||
      !applicable ||
      props.onConfirm === undefined ||
      busy !== undefined ||
      applyingRef.current
    ) {
      return;
    }
    const action = completionAction ?? 'import';
    if (appliedActionRef.current !== undefined && appliedActionRef.current !== action) {
      setError(t('reachDeck.import.retrySameAction'));
      return;
    }
    appliedActionRef.current = action;
    applyingRef.current = true;
    setBusy('apply');
    setError(undefined);
    try {
      const confirmation: ImportConfirmation = {
        ...(completionAction === undefined ? {} : { completionAction }),
        file,
        idempotencyKey,
        request: props.request,
        result: result!,
        acceptDegraded,
      };
      await props.onConfirm(confirmation);
    } catch (cause) {
      setError(
        publicImportText(
          cause instanceof Error ? cause.message : t('reachDeck.import.applyFailed'),
          props.format,
          t,
        ),
      );
    } finally {
      applyingRef.current = false;
      setBusy(undefined);
    }
  };

  const formatLabel = props.format === 'pptx' ? 'PPTX' : 'JSON';
  const modeDescription =
    props.request.mode === 'create'
      ? t('reachDeck.import.mode.createDescription', { format: formatLabel })
      : props.request.mode === 'before-first'
        ? t('reachDeck.import.mode.beforeFirstDescription')
        : t('reachDeck.import.mode.insertDescription', { anchor: props.request.anchorTitle });

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-[#251d22]/45 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && busy === undefined) props.onClose();
      }}
      role="presentation"
    >
      <section
        aria-label={t('reachDeck.import.dialogLabel', { format: formatLabel })}
        aria-modal="true"
        className="flex max-h-[min(780px,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/80 bg-[#fffdfa] shadow-[0_24px_80px_rgba(48,31,41,0.28)]"
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#f45f22]">
              {t('reachDeck.import.eyebrow', { format: formatLabel })}
            </p>
            <h2 className="mt-1 text-lg font-bold tracking-tight text-[#5e3853]">
              {props.request.mode === 'create'
                ? t('reachDeck.import.title.create', { format: formatLabel })
                : t('reachDeck.import.title.insert', { format: formatLabel })}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[#786d73]">
              {modeDescription} {t('reachDeck.import.previewNotice')}
            </p>
          </div>
          <button
            aria-label={t('reachDeck.import.close')}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-[#786d73] transition hover:bg-[#f4ece6] hover:text-[#5e3853] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9d7a8d] disabled:cursor-not-allowed disabled:opacity-55"
            disabled={busy !== undefined}
            onClick={props.onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e5dcd7] bg-white p-3">
            <FileUp aria-hidden="true" className="size-4 shrink-0 text-[#5e3853]" />
            <input
              accept={props.accept}
              aria-label={t('reachDeck.import.fileLabel', { format: formatLabel })}
              className="min-w-0 flex-1 text-sm text-[#30252c] file:mr-3 file:rounded-lg file:border file:border-solid file:border-[#d8cdd2] file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-bold file:text-[#5e3853] file:transition hover:file:border-[#bdaeb5] hover:file:bg-[#fffdfb] disabled:opacity-55"
              disabled={busy !== undefined}
              onChange={selectFile}
              type="file"
            />
            <button
              className={secondaryButtonClass}
              disabled={file === undefined || busy !== undefined}
              onClick={() => void runPreflight()}
              type="button"
            >
              {busy === 'preflight' ? (
                <span className="flex items-center gap-2">
                  <TeacherLoadingIcon />
                  {t(
                    stage === undefined
                      ? 'reachDeck.import.preflighting'
                      : IMPORT_STAGE_KEYS[stage],
                  )}
                </span>
              ) : (
                t('reachDeck.import.preflight')
              )}
            </button>
          </div>

          {error !== undefined ? (
            <p
              className="rounded-xl border border-[#e4b6ad] bg-[#fdf1ef] px-4 py-3 text-sm font-semibold text-[#a44436]"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {result !== undefined ? (
            <ImportPreflightReport
              format={props.format}
              locale={locale}
              request={props.request}
              result={result}
              t={t}
            />
          ) : null}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-[#eee7e9] bg-[#fbf7f4] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            className={secondaryButtonClass}
            disabled={busy !== undefined}
            onClick={props.onClose}
            type="button"
          >
            {t('reachDeck.import.cancel')}
          </button>
          {result?.ok === true && !result.canApply && result.canApplyDegraded ? (
            <button
              className={primaryButtonClass}
              disabled={props.onConfirm === undefined || busy !== undefined}
              onClick={() => void confirm(true)}
              type="button"
            >
              {busy === 'apply' && <TeacherLoadingIcon />}
              {busy === 'apply'
                ? t('reachDeck.import.applying')
                : t('reachDeck.import.applyDegraded', {
                    suffix: degradedButtonSuffix(result, t),
                  })}
            </button>
          ) : (
            <button
              className={primaryButtonClass}
              disabled={
                result?.canApply !== true || props.onConfirm === undefined || busy !== undefined
              }
              onClick={() => void confirm(false)}
              type="button"
            >
              {busy === 'apply' && <TeacherLoadingIcon />}
              {busy === 'apply'
                ? t('reachDeck.import.applying')
                : props.request.mode === 'create'
                  ? t('reachDeck.import.confirmCreate')
                  : t('reachDeck.import.confirmInsert')}
            </button>
          )}
          <button
            className={primaryButtonClass}
            disabled={
              !(result?.canApply || (result?.ok && result.canApplyDegraded)) ||
              props.onConfirm === undefined ||
              busy !== undefined
            }
            onClick={() => void confirm(result?.canApply !== true, 'generate-narration')}
            type="button"
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {result?.ok && !result.canApply && result.canApplyDegraded
              ? t('reachDeck.import.applyDegradedAndGenerate', {
                  suffix: degradedButtonSuffix(result, t),
                })
              : t('reachDeck.import.importAndGenerate')}
          </button>
        </footer>
      </section>
    </div>
  );
}

/**
 * What a page report means to a teacher.
 *
 * A `warning` page covers two very different outcomes: an element is missing
 * from the page (there is a blocking diagnostic behind it), or the page is
 * complete and only some styling was simplified. Only the first is a loss, so
 * the two must not share copy.
 */
type ImportPageOutcome = 'ok' | 'simplified' | 'partial' | 'skipped';

function importPageOutcome(report: ImportPageReport): ImportPageOutcome {
  if (report.status === 'error') return 'skipped';
  if (report.status === 'ok') return 'ok';
  return report.diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
  )
    ? 'partial'
    : 'simplified';
}

function degradedButtonSuffix(result: ImportPreflightResult, t: PortalTranslator): string {
  if (!result.ok || result.mapping === undefined) return '';
  const errorCount = result.mapping.pageReports.filter(
    (report) => report.status === 'error',
  ).length;
  return errorCount > 0
    ? t('reachDeck.import.degradedSkipSuffix', { count: errorCount })
    : t('reachDeck.import.degradedWarningSuffix');
}

function ImportPreflightReport({
  format,
  locale,
  request,
  result,
  t,
}: {
  format: 'pptx' | 'maic';
  locale: string;
  request: ImportRequest;
  result: ImportPreflightResult;
  t: PortalTranslator;
}) {
  const [issuesOpen, setIssuesOpen] = useState(false);
  const degraded = result.ok && !result.canApply && result.canApplyDegraded;
  const pageReports = result.ok ? (result.mapping?.pageReports ?? []) : [];
  // Import is refused only for an unreadable file, so an applicable candidate
  // may still have lost pictures or pages. That has to read as a loss, not as
  // "styling simplified". A candidate that cannot be applied at all — a lost
  // anchor, a stage mismatch, a Deck that moved on — stays in the blocked
  // chrome instead: the action is closed, so amber would understate it.
  const contentLost =
    result.ok &&
    (result.canApply || result.canApplyDegraded) &&
    (result.diagnostics.some(
      (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
    ) ||
      pageReports.some((report) => report.status === 'error'));
  const diagnosticGroups = useMemo(
    () => partitionImportDiagnostics(result.diagnostics, pageReports),
    [pageReports, result.diagnostics],
  );
  const issueCount =
    diagnosticGroups.global.length +
    diagnosticGroups.unmatchedPage.length +
    diagnosticGroups.pageReports.reduce((total, report) => total + report.diagnostics.length, 0);
  return (
    <div aria-live="polite" className="flex min-h-0 flex-col gap-3">
      <div
        className={`flex flex-col items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center ${
          result.canApply && !contentLost
            ? 'border-[#b8d6c0] bg-[#edf7f0]'
            : degraded || contentLost
              ? 'border-[#e8d3ae] bg-[#fdf6ec]'
              : 'border-[#e4b6ad] bg-[#fdf1ef]'
        }`}
      >
        <strong
          className={`min-w-0 text-sm font-bold ${
            result.canApply && !contentLost
              ? 'text-[#166534]'
              : degraded || contentLost
                ? 'text-[#8a5a1b]'
                : 'text-[#a44436]'
          }`}
        >
          {result.canApply
            ? // The import is directly confirmable. Losses (a picture that
              // would not decode, a chart the model cannot carry) are named as
              // losses; mere notes (simplified styling, dropped animation
              // semantics) as notes. Neither demotes the action.
              contentLost
              ? t(
                  request.mode === 'create'
                    ? 'reachDeck.import.status.createReadyWithLoss'
                    : 'reachDeck.import.status.insertReadyWithLoss',
                )
              : request.mode === 'create'
                ? issueCount > 0
                  ? t('reachDeck.import.status.createReadyWithNotes')
                  : t('reachDeck.import.status.createReady')
                : issueCount > 0
                  ? t('reachDeck.import.status.insertReadyWithNotes')
                  : t('reachDeck.import.status.insertReady')
            : degraded
              ? t('reachDeck.import.status.degraded')
              : request.mode === 'create'
                ? t('reachDeck.import.status.createBlocked')
                : t('reachDeck.import.status.insertBlocked')}
        </strong>
        <span className="flex shrink-0 flex-wrap items-center gap-3 sm:ml-auto sm:justify-end">
          {result.ok ? (
            <span className="whitespace-nowrap text-xs font-semibold text-[#786d73]">
              {format === 'pptx'
                ? t('reachDeck.import.summary', {
                    pages: (result as ReachDeckPptxPreflightResult & { ok: true }).summary
                      .slideCount,
                    media: (result as ReachDeckPptxPreflightResult & { ok: true }).summary
                      .assetCount,
                  })
                : t('reachDeck.import.summary', {
                    pages: (result as ReachDeckMaicPreflightResult & { ok: true }).summary
                      .pageCount,
                    media: (result as ReachDeckMaicPreflightResult & { ok: true }).summary
                      .mediaCount,
                  })}
            </span>
          ) : null}
          {issueCount > 0 ? (
            <button
              className="flex min-h-8 items-center gap-1.5 rounded-lg border border-[#d8cdd2] bg-white px-3 py-1 text-xs font-bold text-[#5e3853] shadow-sm transition hover:border-[#bdaeb5] hover:bg-[#fffdfb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9d7a8d]"
              onClick={() => setIssuesOpen(true)}
              type="button"
            >
              <CircleAlert aria-hidden="true" className="size-3.5" />
              {result.canApply && !contentLost
                ? t('reachDeck.import.viewNotes', { count: issueCount })
                : t('reachDeck.import.viewIssues', { count: issueCount })}
            </button>
          ) : null}
        </span>
      </div>

      {result.ok && result.mapping !== undefined ? (
        <ImportCandidatePreview
          document={result.mapping.document}
          key={result.mapping.candidateDigest}
          locale={locale}
          mediaPreviewUrls={result.mapping.mediaPreviewUrls}
          pageReports={result.mapping.pageReports}
          stage={result.mapping.document.stage}
          t={t}
        />
      ) : null}

      {issuesOpen ? (
        <ImportIssuesDialog
          format={format}
          globalDiagnostics={diagnosticGroups.global}
          onClose={() => setIssuesOpen(false)}
          pageReports={diagnosticGroups.pageReports}
          t={t}
          unmatchedPageDiagnostics={diagnosticGroups.unmatchedPage}
        />
      ) : null}
    </div>
  );
}

function ImportIssuesDialog({
  format,
  globalDiagnostics,
  onClose,
  pageReports,
  t,
  unmatchedPageDiagnostics,
}: {
  format: 'pptx' | 'maic';
  globalDiagnostics: readonly ImportDiagnostic[];
  onClose: () => void;
  pageReports: readonly ImportPageReport[];
  t: PortalTranslator;
  unmatchedPageDiagnostics: readonly ImportDiagnostic[];
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose]);
  const reportsWithIssues = pageReports.filter((report) => report.diagnostics.length > 0);
  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-[#251d22]/45 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t('reachDeck.import.issuesLabel')}
        aria-modal="true"
        className="flex max-h-[min(620px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/80 bg-[#fffdfa] shadow-[0_24px_80px_rgba(48,31,41,0.28)]"
        role="dialog"
      >
        <header className="flex items-center justify-between gap-4 border-b border-[#eee7e9] px-5 py-4">
          <h3 className="flex items-center gap-2 text-base font-bold text-[#5e3853]">
            <AlertTriangle aria-hidden="true" className="size-4 text-[#8a5a1b]" />
            {t('reachDeck.import.issuesTitle')}
          </h3>
          <button
            aria-label={t('reachDeck.import.closeIssues')}
            className="grid size-8 place-items-center rounded-lg text-[#786d73] transition hover:bg-[#f4ece6] hover:text-[#5e3853] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9d7a8d]"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {globalDiagnostics.length > 0 ? (
            <section>
              <h4 className="text-xs font-bold uppercase tracking-[0.1em] text-[#786d73]">
                {t('reachDeck.import.documentLevel')}
              </h4>
              <ul className="mt-2 flex flex-col gap-2">
                {globalDiagnostics.map((diagnostic, index) => (
                  <ImportIssueItem
                    diagnostic={diagnostic}
                    format={format}
                    key={`${diagnostic.code}:${diagnosticLocationText(diagnostic) ?? ''}:${index}`}
                    t={t}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {unmatchedPageDiagnostics.length > 0 ? (
            <section>
              <h4 className="text-xs font-bold uppercase tracking-[0.1em] text-[#786d73]">
                {t('reachDeck.import.unmatchedPageLevel')}
              </h4>
              <ul className="mt-2 flex flex-col gap-2">
                {unmatchedPageDiagnostics.map((diagnostic, index) => (
                  <ImportIssueItem
                    diagnostic={diagnostic}
                    format={format}
                    key={`${diagnostic.code}:${diagnosticLocationText(diagnostic) ?? ''}:${index}`}
                    t={t}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {reportsWithIssues.map((report) => {
            const outcome = importPageOutcome(report);
            return (
              <section key={report.pageId}>
                <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-[#786d73]">
                  {outcome === 'skipped' ? '⛔' : outcome === 'partial' ? '⚠' : 'ℹ'}{' '}
                  {t('reachDeck.import.pageHeading', {
                    number: report.sourceOrder,
                    title: report.title,
                  })}
                  <span className="font-semibold normal-case tracking-normal">
                    {outcome === 'skipped'
                      ? t('reachDeck.import.pageSkipped')
                      : outcome === 'partial'
                        ? t('reachDeck.import.pagePartial')
                        : t('reachDeck.import.pageSimplified')}
                  </span>
                </h4>
                <ul className="mt-2 flex flex-col gap-2">
                  {report.diagnostics.map((diagnostic, index) => (
                    <ImportIssueItem
                      diagnostic={diagnostic}
                      format={format}
                      key={`${diagnostic.code}:${index}`}
                      t={t}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          {globalDiagnostics.length === 0 &&
          unmatchedPageDiagnostics.length === 0 &&
          reportsWithIssues.length === 0 ? (
            <p className="text-sm text-[#786d73]">{t('reachDeck.import.noIssues')}</p>
          ) : null}
        </div>
        <footer className="flex justify-end border-t border-[#eee7e9] bg-[#fbf7f4] px-5 py-3">
          <button className={secondaryButtonClass} onClick={onClose} type="button">
            {t('reachDeck.import.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ImportIssueItem({
  diagnostic,
  format,
  t,
}: {
  diagnostic: ImportPreflightResult['diagnostics'][number];
  format: 'pptx' | 'maic';
  t: PortalTranslator;
}) {
  return (
    <li className="rounded-lg border border-[#e5dcd7] bg-white px-3 py-2 text-sm leading-6 text-[#30252c]">
      <code className="rounded bg-[#f4ece6] px-1.5 py-0.5 text-xs font-semibold text-[#5e3853]">
        {publicDiagnosticCode(diagnostic.code, format)}
      </code>{' '}
      {importDiagnosticText(diagnostic, format, t)}
      {diagnosticLocationText(diagnostic) ? (
        <span className="text-xs text-[#786d73]"> ({diagnosticLocationText(diagnostic)})</span>
      ) : null}
    </li>
  );
}

function diagnosticLocationText(
  diagnostic: ImportPreflightResult['diagnostics'][number],
): string | undefined {
  const location = diagnostic.location;
  if (location === undefined) return undefined;
  if ('partPath' in location) return location.partPath;
  if ('field' in location) return location.field;
  return undefined;
}

function partitionImportDiagnostics(
  diagnostics: readonly ImportDiagnostic[],
  pageReports: readonly ImportPageReport[],
): {
  global: ImportDiagnostic[];
  unmatchedPage: ImportDiagnostic[];
  pageReports: ImportPageReport[];
} {
  const normalizedReports = pageReports.map((report) => ({
    ...report,
    diagnostics: uniqueImportDiagnostics(report.diagnostics),
  })) as ImportPageReport[];
  const reportedIdentities = new Set(
    normalizedReports.flatMap((report) => report.diagnostics.map(importDiagnosticIdentity)),
  );
  const unmatched = uniqueImportDiagnostics(diagnostics).filter(
    (diagnostic) => !reportedIdentities.has(importDiagnosticIdentity(diagnostic)),
  );
  return {
    global: unmatched.filter((diagnostic) => !hasPageDiagnosticLocation(diagnostic)),
    unmatchedPage: unmatched.filter(hasPageDiagnosticLocation),
    pageReports: normalizedReports,
  };
}

function uniqueImportDiagnostics(diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] {
  const unique = new Map<string, ImportDiagnostic>();
  for (const diagnostic of diagnostics) {
    const identity = importDiagnosticIdentity(diagnostic);
    if (!unique.has(identity)) unique.set(identity, diagnostic);
  }
  return [...unique.values()];
}

function importDiagnosticIdentity(diagnostic: ImportDiagnostic): string {
  return JSON.stringify(
    stableDiagnosticValue({
      code: diagnostic.code,
      severity: diagnostic.severity,
      feature: diagnostic.feature,
      message: diagnostic.message,
      location: diagnostic.location,
      details: diagnostic.details,
    }),
  );
}

function stableDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableDiagnosticValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableDiagnosticValue(entry)]),
  );
}

function hasPageDiagnosticLocation(diagnostic: ImportDiagnostic): boolean {
  const location = diagnostic.location;
  if (location === undefined) return false;
  return (
    ('slideId' in location && location.slideId !== undefined) ||
    ('pageId' in location && location.pageId !== undefined) ||
    ('sourceOrder' in location && location.sourceOrder !== undefined)
  );
}

function ImportCandidatePreview({
  document,
  locale,
  mediaPreviewUrls,
  pageReports,
  stage,
  t,
}: {
  document: ReachDeckDocumentV2;
  locale: string;
  mediaPreviewUrls?: Readonly<Record<string, string>>;
  pageReports: readonly ImportPageReport[];
  stage: { width: number; height: number };
  t: PortalTranslator;
}) {
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      pageReports.findIndex((report) => report.status !== 'error'),
    ),
  );
  const nativeSlidesByPageId = useMemo(
    () => new Map((document.nativeSlides ?? []).map((binding) => [binding.pageId, binding.slide])),
    [document],
  );
  const themeColors = useMemo(
    () =>
      document.schemaVersion === 'reach-deck-document/v2'
        ? document.resources.themes.find((theme) => theme.id === document.defaultThemeId)?.colors
        : undefined,
    [document],
  );
  const activeReport = pageReports[activeIndex];
  const activeImportable = activeReport !== undefined && activeReport.status !== 'error';
  const activeNativeSlide =
    activeReport === undefined ? undefined : nativeSlidesByPageId.get(activeReport.pageId);
  const activePage =
    activeReport === undefined
      ? undefined
      : document.pages.find((page) => page.pageId === activeReport.pageId);
  const activePlayerPage =
    activePage?.sceneType === 'quiz' || activePage?.sceneType === 'interactive'
      ? activePage
      : undefined;
  return (
    <section
      aria-label={t('reachDeck.import.candidatePreview')}
      className="grid min-h-0 gap-3 sm:grid-cols-[168px_minmax(0,1fr)]"
    >
      <div
        aria-label={t('reachDeck.import.pageList')}
        className="flex max-h-[420px] gap-2 overflow-x-auto rounded-xl border border-[#e5dcd7] bg-[#f8f3ef] p-2 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden"
        role="list"
      >
        {pageReports.map((report, index) => {
          const nativeSlide = nativeSlidesByPageId.get(report.pageId);
          const active = index === activeIndex;
          const outcome = importPageOutcome(report);
          return (
            <button
              aria-pressed={active}
              className={`group w-36 shrink-0 rounded-lg p-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f45f22] sm:w-full ${
                active ? 'bg-[#5e3853]/10 ring-2 ring-[#f45f22]' : 'hover:bg-[#5e3853]/5'
              }`}
              key={report.pageId}
              onClick={() => setActiveIndex(index)}
              title={
                outcome === 'skipped'
                  ? t('reachDeck.import.pageErrorTitle')
                  : outcome === 'partial'
                    ? t('reachDeck.import.pageWarningTitle')
                    : outcome === 'simplified'
                      ? t('reachDeck.import.pageSimplifiedTitle')
                      : undefined
              }
              type="button"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none relative block overflow-hidden rounded-md border border-[#ded6d2] bg-white"
              >
                {nativeSlide !== undefined ? (
                  <NativeV2SlideRenderer
                    hideDiagnostics
                    passiveMedia
                    resourceUrlsById={mediaPreviewUrls ?? {}}
                    slide={nativeSlide}
                    stage={stage}
                    themeColors={themeColors}
                  />
                ) : (
                  <span
                    className="grid place-items-center text-lg font-bold text-[#c9bdb6]"
                    style={{ aspectRatio: `${stage.width} / ${stage.height}` }}
                  >
                    {report.sourceOrder}
                  </span>
                )}
                {/* 只有真的丢了内容才盖遮罩；纯样式简化不遮挡预览。 */}
                {outcome === 'skipped' || outcome === 'partial' ? (
                  <span className="absolute inset-0 grid place-items-center bg-[#251d22]/35 text-xl">
                    {outcome === 'skipped' ? '⛔' : '⚠'}
                  </span>
                ) : null}
              </span>
              <span
                className={`mt-1 block truncate text-xs font-semibold ${
                  outcome === 'skipped'
                    ? 'text-[#a44436]'
                    : outcome === 'partial'
                      ? 'text-[#8a5a1b]'
                      : 'text-[#5e3853]'
                }`}
              >
                {report.sourceOrder}. {report.title}
              </span>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 self-start overflow-hidden rounded-xl border border-[#ded6d2] bg-white shadow-[0_8px_24px_rgb(46_30_42/8%)]">
        {activeImportable ? (
          activeNativeSlide !== undefined ? (
            // 预览用无编辑器外壳的原生渲染器：不挂载只读横幅与保真度诊断面板。
            <NativeV2SlideRenderer
              hideDiagnostics
              resourceUrlsById={mediaPreviewUrls ?? {}}
              slide={activeNativeSlide}
              stage={stage}
              themeColors={themeColors}
            />
          ) : activePlayerPage !== undefined ? (
            <ReachDeckPlayer
              activePageId={activePlayerPage.pageId}
              document={document}
              // Teacher import preview: grade locally and reveal references right away.
              quizGradingMode="trial"
              locale={locale}
              nativeResourceUrlsById={mediaPreviewUrls ?? {}}
              pageNavigationLocked
              translate={t}
            />
          ) : (
            <div
              className="grid aspect-video place-items-center p-5 text-sm text-[#786d73]"
              role="status"
            >
              {t('reachDeck.import.pageCannotImportDetail')}
            </div>
          )
        ) : (
          <div className="grid gap-1.5 p-5 text-sm text-[#a44436]" role="alert">
            <strong className="font-bold">⛔ {t('reachDeck.import.pageCannotImport')}</strong>
            <span className="text-[#786d73]">{t('reachDeck.import.pageCannotImportDetail')}</span>
          </div>
        )}
      </div>
    </section>
  );
}
