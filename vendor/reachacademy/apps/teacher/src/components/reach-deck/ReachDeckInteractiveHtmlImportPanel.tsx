'use client';

import { TeacherLoadingIcon } from '../TeacherLoading';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { BookOpenText, ClipboardCheck, Copy, Download, FileUp, X } from 'lucide-react';

import {
  createReachDeckUuid,
  REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES,
  ReachDeckClient,
  type ReachDeckInteractiveHtmlPreflightResult,
  type ReachDeckModuleContext,
} from '@reachany/reach-deck-client';
import { ReachDeckPlayer } from '@reachany/reach-deck-player';
import { upsertReachDeckDocumentPage, type ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { PortalTranslator } from '@/src/lib/i18n';

import {
  reachDeckImportPrimaryButtonClass,
  reachDeckImportSecondaryButtonClass,
} from './ReachDeckPptxImportPanel';
import {
  INTERACTIVE_HTML_AUTHORING_SPEC,
  INTERACTIVE_HTML_AUTHORING_SPEC_FILE_NAME,
} from './interactiveHtmlAuthoringSpec.generated';

export interface ReachDeckInteractiveHtmlConfirmation {
  file: File;
  idempotencyKey: string;
  pageId: string;
  result: ReachDeckInteractiveHtmlPreflightResult;
}

export function createInteractiveHtmlImportIdempotencyKey(): string {
  try {
    return createReachDeckUuid();
  } catch {
    throw new Error('A cryptographically secure UUID generator is required to upload HTML');
  }
}

const kilobytes = (bytes: number): string => (bytes / 1024).toFixed(0);

/** 上传路径的诊断码是 `html.interactive.*`；教师不需要看到内部命名空间。 */
const publicDiagnosticCode = (code: string): string => code.replace(/^html\.interactive\./, '');

/**
 * 教师上传单文件 Interactive HTML 的预览优先对话框。
 *
 * 与 PPTX/MAIC 导入共用两步契约（preflight 不改动工作区，apply 绑定摘要与草稿 CAS），
 * 但只替换当前这一页，因此没有整册模式、页面报告和降级确认。
 */
export function ReachDeckInteractiveHtmlImportPanel(props: {
  client: ReachDeckClient;
  context: ReachDeckModuleContext;
  /** 当前草稿文档。用于把候选页放回真实主题与舞台里预览。 */
  document: ReachDeckDocumentV2;
  pageId: string;
  pageTitle: string;
  onClose: () => void;
  onConfirm?: (confirmation: ReachDeckInteractiveHtmlConfirmation) => Promise<void> | void;
  createIdempotencyKey?: () => string;
}) {
  const { locale, t } = usePortalI18n();
  const [file, setFile] = useState<File>();
  const [idempotencyKey, setIdempotencyKey] = useState<string>();
  const [result, setResult] = useState<ReachDeckInteractiveHtmlPreflightResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'preflight' | 'apply'>();
  const [specCopied, setSpecCopied] = useState(false);

  useEffect(() => {
    setFile(undefined);
    setIdempotencyKey(undefined);
    setResult(undefined);
    setError(undefined);
    setBusy(undefined);
  }, [props.pageId]);

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

  useEffect(() => {
    if (!specCopied) return;
    const timer = window.setTimeout(() => setSpecCopied(false), 2400);
    return () => window.clearTimeout(timer);
  }, [specCopied]);

  const previewDocument = useMemo(() => {
    if (result?.ok !== true) return undefined;
    try {
      const upserted = upsertReachDeckDocumentPage(props.document, result.candidate.page);
      return upserted.document.schemaVersion === 'reach-deck-document/v2'
        ? upserted.document
        : undefined;
    } catch {
      return undefined;
    }
  }, [props.document, result]);

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile !== undefined && nextFile.size > REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES) {
      setFile(undefined);
      setIdempotencyKey(undefined);
      setResult(undefined);
      setError(
        t('reachDeck.interactiveHtml.fileTooLarge', {
          size: kilobytes(nextFile.size),
          limit: kilobytes(REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES),
        }),
      );
      // Re-picking the same path after shrinking the file must fire `change` again.
      event.target.value = '';
      return;
    }
    setFile(nextFile);
    setIdempotencyKey(
      nextFile === undefined
        ? undefined
        : (props.createIdempotencyKey ?? createInteractiveHtmlImportIdempotencyKey)(),
    );
    setResult(undefined);
    setError(undefined);
  };

  const runPreflight = async () => {
    if (file === undefined || idempotencyKey === undefined || busy !== undefined) return;
    setBusy('preflight');
    setError(undefined);
    try {
      setResult(
        await props.client.preflightInteractiveHtml(props.context, file, props.pageId, {
          idempotencyKey,
        }),
      );
    } catch (cause) {
      setResult(undefined);
      setError(
        cause instanceof Error ? cause.message : t('reachDeck.interactiveHtml.preflightFailed'),
      );
    } finally {
      setBusy(undefined);
    }
  };

  const confirm = async () => {
    if (
      file === undefined ||
      idempotencyKey === undefined ||
      result?.canApply !== true ||
      props.onConfirm === undefined ||
      busy !== undefined
    ) {
      return;
    }
    setBusy('apply');
    setError(undefined);
    try {
      await props.onConfirm({ file, idempotencyKey, pageId: props.pageId, result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('reachDeck.interactiveHtml.applyFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const copySpec = async () => {
    try {
      await navigator.clipboard.writeText(INTERACTIVE_HTML_AUTHORING_SPEC);
      setSpecCopied(true);
    } catch {
      setError(t('reachDeck.interactiveHtml.specCopyFailed'));
    }
  };

  const downloadSpec = () => {
    const blob = new Blob([INTERACTIVE_HTML_AUTHORING_SPEC], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = INTERACTIVE_HTML_AUTHORING_SPEC_FILE_NAME;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-[#251d22]/45 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && busy === undefined) props.onClose();
      }}
      role="presentation"
    >
      <section
        aria-label={t('reachDeck.interactiveHtml.dialogLabel')}
        aria-modal="true"
        className="flex max-h-[min(780px,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/80 bg-[#fffdfa] shadow-[0_24px_80px_rgba(48,31,41,0.28)]"
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#f45f22]">
              {t('reachDeck.interactiveHtml.eyebrow')}
            </p>
            <h2 className="mt-1 text-lg font-bold tracking-tight text-[#5e3853]">
              {t('reachDeck.interactiveHtml.title', { page: props.pageTitle })}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[#786d73]">
              {t('reachDeck.interactiveHtml.description')}
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
          <div className="rounded-xl border border-[#dfd6e4] bg-[#f8f5fb] p-3">
            <p className="flex items-start gap-2 text-sm leading-6 text-[#5e3853]">
              <BookOpenText aria-hidden="true" className="mt-1 size-4 shrink-0" />
              <span>{t('reachDeck.interactiveHtml.specHint')}</span>
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                className={reachDeckImportSecondaryButtonClass}
                onClick={() => void copySpec()}
                type="button"
              >
                <span className="flex items-center gap-2">
                  {specCopied ? (
                    <ClipboardCheck aria-hidden="true" className="size-4" />
                  ) : (
                    <Copy aria-hidden="true" className="size-4" />
                  )}
                  {specCopied
                    ? t('reachDeck.interactiveHtml.specCopied')
                    : t('reachDeck.interactiveHtml.specCopy')}
                </span>
              </button>
              <button
                className={reachDeckImportSecondaryButtonClass}
                onClick={downloadSpec}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Download aria-hidden="true" className="size-4" />
                  {t('reachDeck.interactiveHtml.specDownload')}
                </span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e5dcd7] bg-white p-3">
            <FileUp aria-hidden="true" className="size-4 shrink-0 text-[#5e3853]" />
            <input
              accept=".html,.htm,text/html"
              aria-label={t('reachDeck.interactiveHtml.fileLabel')}
              className="min-w-0 flex-1 text-sm text-[#30252c] file:mr-3 file:rounded-lg file:border file:border-solid file:border-[#d8cdd2] file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-bold file:text-[#5e3853] file:transition hover:file:border-[#bdaeb5] hover:file:bg-[#fffdfb] disabled:opacity-55"
              disabled={busy !== undefined}
              onChange={selectFile}
              type="file"
            />
            <button
              className={reachDeckImportSecondaryButtonClass}
              disabled={file === undefined || busy !== undefined}
              onClick={() => void runPreflight()}
              type="button"
            >
              {busy === 'preflight' ? (
                <span className="flex items-center gap-2">
                  <TeacherLoadingIcon />
                  {t('reachDeck.import.preflighting')}
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
            <InteractiveHtmlPreflightReport
              document={previewDocument}
              locale={locale}
              pageId={props.pageId}
              result={result}
              t={t}
            />
          ) : null}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-[#eee7e9] bg-[#fbf7f4] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            className={reachDeckImportSecondaryButtonClass}
            disabled={busy !== undefined}
            onClick={props.onClose}
            type="button"
          >
            {t('reachDeck.import.cancel')}
          </button>
          <button
            className={reachDeckImportPrimaryButtonClass}
            disabled={
              result?.canApply !== true ||
              previewDocument === undefined ||
              props.onConfirm === undefined ||
              busy !== undefined
            }
            onClick={() => void confirm()}
            type="button"
          >
            {busy === 'apply' && <TeacherLoadingIcon />}
            {busy === 'apply'
              ? t('reachDeck.import.applying')
              : t('reachDeck.interactiveHtml.confirm')}
          </button>
        </footer>
      </section>
    </div>
  );
}

function InteractiveHtmlPreflightReport({
  document,
  locale,
  pageId,
  result,
  t,
}: {
  document: ReachDeckDocumentV2 | undefined;
  locale: string;
  pageId: string;
  result: ReachDeckInteractiveHtmlPreflightResult;
  t: PortalTranslator;
}) {
  const blocking = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
  );
  const notes = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity !== 'error' && diagnostic.severity !== 'fatal',
  );
  const runtimeIds = result.ok
    ? result.candidate.runtimeDependencies.map(({ id, version }) => `${id}@${version}`)
    : [];

  return (
    <div aria-live="polite" className="flex min-h-0 flex-col gap-3">
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 ${
          result.canApply && notes.length === 0
            ? 'border-[#b8d6c0] bg-[#edf7f0]'
            : result.canApply
              ? 'border-[#e8d3ae] bg-[#fdf6ec]'
              : 'border-[#e4b6ad] bg-[#fdf1ef]'
        }`}
      >
        <strong
          className={`text-sm font-bold ${
            result.canApply && notes.length === 0
              ? 'text-[#166534]'
              : result.canApply
                ? 'text-[#8a5a1b]'
                : 'text-[#a44436]'
          }`}
        >
          {result.canApply
            ? notes.length === 0
              ? t('reachDeck.interactiveHtml.readyClean')
              : t('reachDeck.interactiveHtml.readyWithNotes', { count: notes.length })
            : t('reachDeck.interactiveHtml.blocked', { count: blocking.length })}
        </strong>
        {result.ok ? (
          <span className="text-sm text-[#786d73]">
            {t('reachDeck.interactiveHtml.sizeSummary', {
              size: kilobytes(result.candidate.documentHtmlUtf8Bytes),
            })}
            {runtimeIds.length > 0
              ? ` · ${t('reachDeck.interactiveHtml.runtimeSummary', {
                  runtimes: runtimeIds.join(', '),
                })}`
              : ''}
          </span>
        ) : null}
      </div>

      <p className="rounded-xl border border-[#e5dcd7] bg-white px-4 py-3 text-sm leading-6 text-[#786d73]">
        {t('reachDeck.interactiveHtml.completionNotice')}
      </p>

      {result.diagnostics.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {[...blocking, ...notes].map((diagnostic, index) => (
            <li
              className={`rounded-lg border px-3 py-2 text-sm ${
                diagnostic.severity === 'error' || diagnostic.severity === 'fatal'
                  ? 'border-[#e4b6ad] bg-[#fdf1ef] text-[#a44436]'
                  : 'border-[#e8d3ae] bg-[#fdf6ec] text-[#8a5a1b]'
              }`}
              key={`${diagnostic.code}:${index}`}
            >
              <code className="mr-2 rounded bg-black/5 px-1.5 py-0.5 text-xs font-semibold">
                {publicDiagnosticCode(diagnostic.code)}
              </code>
              {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}

      {result.ok && document !== undefined ? (
        <div className="min-w-0 overflow-hidden rounded-xl border border-[#ded6d2] bg-white shadow-[0_8px_24px_rgb(46_30_42/8%)]">
          <ReachDeckPlayer
            activePageId={pageId}
            document={document}
            geometryHostMode="authoring-trial"
            // Teacher import preview: grade locally and reveal references right away.
            quizGradingMode="trial"
            interactiveMode="authoring"
            locale={locale}
            pageNavigationLocked
            translate={t}
          />
        </div>
      ) : null}
    </div>
  );
}
