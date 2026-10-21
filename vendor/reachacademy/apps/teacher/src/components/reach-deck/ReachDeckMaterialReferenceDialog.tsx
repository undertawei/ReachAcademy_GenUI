'use client';

import { TeacherLoadingRegion } from '../TeacherLoading';

import { useEffect, useMemo, useState } from 'react';
import { FileText, Files, Globe2, RotateCcw } from 'lucide-react';
import type { GenerationWorkspace, WorkspaceMaterialBlock } from '@reachany/reach-deck-dsl';
import type { ReachDeckGenerationPanelProps } from '@reachany/reach-deck-editor';
import { Dialog, IconButton, Tab, TabList, TabPanel, Tabs } from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import { inspectReachDeckMaterialSources } from '@/src/lib/reach-deck-source-context';
import styles from './ReachDeckMaterialReferenceDialog.module.css';

type PreviewMaterialAsset = NonNullable<ReachDeckGenerationPanelProps['onPreviewMaterialAsset']>;

export function ReachDeckMaterialReferenceDialog({
  workspace,
  onPreviewMaterialAsset,
}: {
  workspace?: GenerationWorkspace;
  onPreviewMaterialAsset?: PreviewMaterialAsset;
}) {
  const { t } = usePortalI18n();
  const [open, setOpen] = useState(false);
  const inspection = useMemo(
    () => (workspace === undefined ? undefined : inspectReachDeckMaterialSources(workspace)),
    [workspace],
  );
  const sources = inspection?.sources;
  if (sources === undefined || (sources.documents.length === 0 && sources.webSearch === undefined))
    return null;
  return (
    <Dialog
      closeLabel={t('reachDeck.materials.close')}
      onOpenChange={setOpen}
      open={open}
      size="xl"
      title={t('reachDeck.materials.referencesTitle')}
      trigger={
        <IconButton icon={<Files size={16} />} label={t('reachDeck.materials.referencesTitle')} />
      }
    >
      {open ? (
        <Tabs
          className={styles.viewer}
          defaultValue={sources.documents.length > 0 ? 'document-0' : 'web'}
        >
          <TabList aria-label={t('reachDeck.materials.tabsLabel')} className={styles.tabs}>
            {sources.documents.map((document, index) => (
              <Tab
                icon={<FileText size={16} />}
                key={index}
                title={document.fileName}
                value={`document-${index}`}
              >
                {document.fileName}
              </Tab>
            ))}
            {sources.webSearch === undefined ? null : (
              <Tab icon={<Globe2 size={16} />} value="web">
                {t('reachDeck.materials.webResearch')}
              </Tab>
            )}
          </TabList>
          {inspection?.legacy ? (
            <p className={styles.note}>{t('reachDeck.materials.legacyResults')}</p>
          ) : null}
          {sources.documents.map((document, index) => {
            let imageOrdinal = 0;
            return (
              <TabPanel className={styles.panel} key={index} value={`document-${index}`}>
                <div className={styles.documentHeading}>
                  <strong>{document.fileName}</strong>
                  {document.pageCount === undefined ? null : (
                    <span>{t('reachDeck.materials.pages', { count: document.pageCount })}</span>
                  )}
                </div>
                {document.diagnostics.length > 0 ? (
                  <ul className={styles.notes}>
                    {[...new Set(document.diagnostics.map(diagnosticKey))].map((key) => (
                      <li key={key}>{t(key)}</li>
                    ))}
                  </ul>
                ) : null}
                {document.blocks.length === 0 ? (
                  <p className={styles.note}>{t('reachDeck.materials.noExtractedContent')}</p>
                ) : (
                  document.blocks.map((block, blockIndex) => (
                    <div className={styles.block} key={blockIndex}>
                      {block.page !== undefined &&
                      document.blocks[blockIndex - 1]?.page !== block.page ? (
                        <p className={styles.pageLabel}>
                          {t('reachDeck.materials.page', { page: block.page })}
                        </p>
                      ) : null}
                      {block.type === 'text' ? (
                        <div className={styles.text}>{block.text}</div>
                      ) : (
                        <MaterialImage
                          block={block}
                          fileName={document.fileName}
                          index={++imageOrdinal}
                          onPreview={onPreviewMaterialAsset}
                        />
                      )}
                    </div>
                  ))
                )}
              </TabPanel>
            );
          })}
          {sources.webSearch === undefined ? null : (
            <TabPanel className={styles.panel} value="web">
              {sources.webSearch.query ? (
                <div className={styles.documentHeading}>
                  <strong>{t('reachDeck.materials.searchQuery')}</strong>
                  <span>{sources.webSearch.query}</span>
                </div>
              ) : null}
              {sources.webSearch.answer ? (
                <div className={styles.text}>{sources.webSearch.answer}</div>
              ) : null}
              {sources.webSearch.sources.length === 0 ? (
                <p className={styles.note}>{t('reachDeck.materials.noResearchResults')}</p>
              ) : null}
              {sources.webSearch.sources.map((source, index) => (
                <article className={styles.webSource} key={index}>
                  <ResearchTitle
                    title={source.title || t('reachDeck.materials.untitledSource')}
                    url={source.url}
                  />
                  <div className={styles.text}>{source.content}</div>
                </article>
              ))}
              {sources.webSearch.excludedSources.length === 0 ? null : (
                <section className={styles.excluded}>
                  <strong>{t('reachDeck.materials.excludedSources')}</strong>
                  <ul>
                    {sources.webSearch.excludedSources.map((source, index) => (
                      <li key={index}>
                        <ResearchTitle
                          title={source.title || t('reachDeck.materials.untitledSource')}
                          url={source.url}
                        />
                        <span>
                          {t(
                            source.reason === 'pdf_binary_content'
                              ? 'reachDeck.materials.excludedPdf'
                              : 'reachDeck.materials.excludedEmpty',
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </TabPanel>
          )}
        </Tabs>
      ) : null}
    </Dialog>
  );
}

function ResearchTitle({ title, url }: { title: string; url: string }) {
  let safeUrl: string | undefined;
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password)
      safeUrl = parsed.href;
  } catch {
    /* Legacy research can contain incomplete source URLs. */
  }
  return safeUrl === undefined ? (
    <strong>{title}</strong>
  ) : (
    <a href={safeUrl} rel="noopener noreferrer" target="_blank">
      {title}
    </a>
  );
}

function diagnosticKey(code: string): string {
  if (code === 'image_mime_corrected') return 'reachDeck.materials.diagnostic.imageCorrected';
  if (code === 'xlsx_text_only' || code === 'pptx_text_only')
    return 'reachDeck.materials.diagnostic.textOnly';
  if (
    code.startsWith('unsupported_image_type') ||
    code === 'image_size_unsupported' ||
    code === 'pptx_image_type_unsupported' ||
    code === 'pptx_image_reference_unavailable'
  )
    return 'reachDeck.materials.diagnostic.imageSkipped';
  if (code === 'pptx_vector_diagram_text_only')
    return 'reachDeck.materials.diagnostic.diagramTextOnly';
  return 'reachDeck.materials.diagnostic.incomplete';
}

function MaterialImage({
  block,
  fileName,
  index,
  onPreview,
}: {
  block: Extract<WorkspaceMaterialBlock, { type: 'image' }>;
  fileName: string;
  index: number;
  onPreview?: PreviewMaterialAsset;
}) {
  const { t } = usePortalI18n();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ url?: string; failed?: boolean; loaded?: boolean }>({});
  useEffect(() => {
    let active = true;
    setState({});
    if (onPreview === undefined) {
      setState({ failed: true });
      return;
    }
    onPreview(block.assetId).then(
      (result) => {
        if (active) setState({ url: result.downloadUrl });
      },
      () => {
        if (active) setState({ failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, block.assetId, onPreview]);
  return (
    <figure className={styles.image}>
      {state.failed ? (
        <div className={styles.imageStatus} role="status">
          <span>{t('reachDeck.materials.imageFailed')}</span>
          <IconButton
            icon={<RotateCcw size={16} />}
            label={t('reachDeck.materials.imageRetry')}
            onClick={() => setAttempt((current) => current + 1)}
          />
        </div>
      ) : (
        <>
          {state.loaded ? null : (
            <TeacherLoadingRegion label={t('reachDeck.materials.imageLoading')} compact />
          )}
          {state.url === undefined ? null : (
            <img
              alt={t('reachDeck.materials.imageAlt', { file: fileName, index })}
              className={state.loaded ? undefined : styles.imagePending}
              src={state.url}
              onError={() => setState({ failed: true })}
              onLoad={() => setState((current) => ({ ...current, loaded: true }))}
            />
          )}
        </>
      )}
    </figure>
  );
}
