import { useEffect, useMemo, useRef, useState } from 'react';
import { createBlankReachDeckDocument, isNativeSlideArtifact } from '@reachany/reach-deck-dsl';
import { ReachDeckPlayer } from '@reachany/reach-deck-player';
import type { DeckHarnessGenerationEvidence } from '../../lib/reach-deck/harness-evidence.js';
import { sanitizeGeneratedHtml } from './html-layout/htmlPipeline.js';
import { resolvePptSafeTailwind } from './html-layout/tailwindResolver.js';
import { HTML_MATH_CSS, prepareHtmlMath } from './html-layout/math.js';
import { REACH_DECK_MESSAGES } from '../../../../apps/student/src/lib/reach-deck-i18n.js';
import {
  PlannedVisualRoutes,
  requestOutlinePage,
  summarizeMediaOrigin,
  VISUAL_ROUTE_LABELS,
} from './deck-harness-visuals.js';

type Entry = Pick<
  DeckHarnessGenerationEvidence,
  'jobId' | 'runId' | 'pageId' | 'kind' | 'status' | 'updatedAt'
>;

export async function prepareEvidencePreview(
  html: string,
  assets: DeckHarnessGenerationEvidence['assets'],
  resourceUrls: Record<string, string>,
  prepared = false,
): Promise<string> {
  const sanitized = prepared ? html : await resolvePptSafeTailwind(sanitizeGeneratedHtml(html));
  const document = new DOMParser().parseFromString(sanitized, 'text/html');
  document
    .querySelectorAll('script, iframe, object, embed, link, meta, base')
    .forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const trustedRaster =
        prepared &&
        element.tagName === 'IMG' &&
        attribute.name === 'src' &&
        /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(attribute.value);
      if (
        /^on/i.test(attribute.name) ||
        (['src', 'srcset', 'action', 'formaction'].includes(attribute.name) && !trustedRaster) ||
        (['href', 'xlink:href'].includes(attribute.name) &&
          !/^#[a-zA-Z][\w:.-]*$/.test(attribute.value))
      )
        element.removeAttribute(attribute.name);
    }
  });
  const safeCss = (css: string) =>
    css
      .replace(/@import\s+[^;]+;?/gi, '')
      .replace(/url\s*\(([^)]*)\)/gi, (value, target: string) =>
        /^\s*['"]?#[\w:.-]+['"]?\s*$/.test(target) ? value : 'none',
      );
  document.querySelectorAll('style').forEach((node) => {
    node.textContent = safeCss(node.textContent ?? '');
  });
  document.querySelectorAll('[style]').forEach((node) => {
    node.setAttribute('style', safeCss(node.getAttribute('style') ?? ''));
  });
  for (const slot of document.querySelectorAll('img[data-reach-asset], div[data-reach-asset]')) {
    const asset = assets?.find((entry) => entry.assetId === slot.getAttribute('data-reach-asset'));
    const url = asset && resourceUrls[asset.objectKey];
    if (!url?.startsWith('/harness/media/')) continue;
    let image = slot;
    if (slot.tagName === 'DIV') {
      if (slot.children.length > 0 || slot.textContent?.trim()) continue;
      image = document.createElement('img');
      for (const attribute of Array.from(slot.attributes))
        image.setAttribute(attribute.name, attribute.value);
      slot.replaceWith(image);
    }
    image.setAttribute('src', url);
  }
  if (!prepared) prepareHtmlMath(document);
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content =
    "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  document.head.prepend(policy);
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = '/deck-harness.css';
  document.head.append(fonts);
  const reset = document.createElement('style');
  reset.textContent = `html,body{margin:0;width:1600px;height:900px;overflow:hidden}\n${HTML_MATH_CSS}`;
  document.head.append(reset);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

export function DeckHarnessEvidence({
  runId,
  resourceUrls,
}: {
  runId?: string;
  resourceUrls: Record<string, string>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState('');
  const [evidence, setEvidence] = useState<DeckHarnessGenerationEvidence>();
  const [error, setError] = useState('');
  const [tab, setTab] = useState('html');
  const [html, setHtml] = useState('');
  const [width, setWidth] = useState(800);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setEntries([]);
    setEvidence(undefined);
    setSelected('');
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(
          `/harness/generation-evidence?runId=${encodeURIComponent(runId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Evidence HTTP ${response.status}`);
        const data = (await response.json()) as { entries: Entry[] };
        setEntries(data.entries);
        setSelected(
          (current) =>
            current ||
            data.entries.find((entry) => entry.kind === 'page-generation')?.jobId ||
            data.entries[0]?.jobId ||
            '',
        );
      } catch (cause) {
        if (!controller.signal.aborted) setError(String(cause));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId]);
  const updatedAt = entries.find((entry) => entry.jobId === selected)?.updatedAt;
  useEffect(() => {
    if (!runId || !selected) return;
    const controller = new AbortController();
    setError('');
    void fetch(
      `/harness/generation-evidence?runId=${encodeURIComponent(runId)}&jobId=${encodeURIComponent(selected)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Evidence HTTP ${response.status}`);
        return response.json() as Promise<DeckHarnessGenerationEvidence>;
      })
      .then((value) => {
        if (!controller.signal.aborted) setEvidence(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => controller.abort();
  }, [runId, selected, updatedAt]);
  useEffect(() => {
    let disposed = false;
    setHtml('');
    if (evidence?.html)
      void prepareEvidencePreview(
        evidence.preparedHtml ?? evidence.html,
        evidence.assets,
        resourceUrls,
        evidence.preparedHtml !== undefined,
      )
        .then((value) => {
          if (!disposed) setHtml(value);
        })
        .catch((cause) => {
          if (!disposed) setError(String(cause));
        });
    return () => {
      disposed = true;
    };
  }, [evidence, resourceUrls]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab, html]);
  const document = useMemo(() => {
    const artifact = evidence?.artifact;
    if (!artifact || !isNativeSlideArtifact(artifact)) return undefined;
    const result = createBlankReachDeckDocument({
      id: evidence.jobId,
      title: artifact.nativeSlide.title ?? artifact.pageId,
    });
    result.resources = artifact.resources;
    result.defaultThemeId = artifact.resources.themes[0]?.id ?? result.defaultThemeId;
    result.pages = [
      {
        pageId: artifact.pageId,
        order: 1,
        revision: artifact.requestedRevision,
        sceneType: 'slide',
        title: artifact.nativeSlide.title ?? artifact.pageId,
      },
    ];
    result.nativeSlides = [{ pageId: artifact.pageId, slide: artifact.nativeSlide }];
    return result;
  }, [evidence]);
  const urls = Object.fromEntries(
    (document?.resources.media ?? []).flatMap((media) =>
      resourceUrls[media.objectKey] ? [[media.id, resourceUrls[media.objectKey]]] : [],
    ),
  );
  const scientific = document?.nativeSlides.some((binding) =>
    binding.slide.elements.some((element) => element.type === 'scientificVisual'),
  );
  const reviewDiagnosticCount =
    evidence?.diagnostics?.filter((item) =>
      /^(?:TEXT_COLLISION|TEXT_OVERFLOW|FOOTER_|CONTRAST_LOW|INVALID_TEXT_STYLE|UNKNOWN_VISIBLE_NODE)/.test(
        item,
      ),
    ).length ?? 0;
  return (
    <section data-harness-generation-evidence>
      <label>
        生成任务{' '}
        <select
          aria-label="生成证据任务"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {entries.map((entry) => (
            <option key={entry.jobId} value={entry.jobId}>
              {entry.pageId ?? entry.kind} · {entry.status} · {entry.jobId}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {reviewDiagnosticCount > 0 ? (
        <p role="status" data-harness-layout-review>
          本页需人工检查 · {reviewDiagnosticCount} 项版面诊断
        </p>
      ) : null}
      {!evidence ? (
        <p>暂无捕获记录</p>
      ) : (
        <>
          <div className="tabs">
            {[
              ['html', '同次 HTML'],
              ['native', '同次 Native'],
              ['assets', '视觉策略与产物'],
              ['source', 'HTML 源码'],
              ['request', '大纲与设计输入'],
              ['prompt', '实际提示词'],
              ['diagnostics', '开发诊断'],
            ].map(([key, label]) => (
              <button key={key} data-active={tab === key} onClick={() => setTab(key!)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'html' && scientific && (
            <p>HTML 科学组件槽位未复现；科学组件请查看同次 Native。</p>
          )}
          {tab === 'html' && !evidence.preparedHtml && (
            <p>原始 HTML 的安全预览；尚无编译器预处理快照。</p>
          )}
          {tab === 'html' && (
            <div
              ref={viewport}
              style={{ width: '100%', height: (width * 9) / 16, overflow: 'hidden' }}
            >
              {html ? (
                <iframe
                  title="同次生成 HTML"
                  sandbox="allow-same-origin"
                  srcDoc={html}
                  style={{
                    width: 1600,
                    height: 900,
                    border: 0,
                    transform: `scale(${width / 1600})`,
                    transformOrigin: 'top left',
                  }}
                />
              ) : (
                <p>该任务尚无 HTML</p>
              )}
            </div>
          )}
          {tab === 'native' &&
            (document ? (
              <ReachDeckPlayer
                document={document}
                nativeResourceUrlsById={urls}
                locale="zh-CN"
                translate={(key) => REACH_DECK_MESSAGES['zh-CN'][key] ?? key}
                hideNativeDiagnostics
                scientificDependencyBaseUrl={window.location.origin}
              />
            ) : (
              <p>该任务没有已编译 Native 产物</p>
            ))}
          {tab === 'source' && <pre>{evidence.html ?? '暂无 HTML'}</pre>}
          {tab === 'assets' && (
            <section data-harness-visual-evidence>
              <h3>大纲计划</h3>
              <PlannedVisualRoutes page={requestOutlinePage(evidence.request)} />
              <h3>实际产物</h3>
              {!document && <p>该任务尚无已编译产物；失败不会以其他路线替代。</p>}
              {document?.resources.media
                .filter((media) => media.contentType.startsWith('image/'))
                .map((media) => {
                  const origin = summarizeMediaOrigin(media.origin);
                  return (
                    <article key={media.id} data-harness-actual-route={origin?.route ?? 'unknown'}>
                      <strong>
                        {origin ? VISUAL_ROUTE_LABELS[origin.route] : '未记录生产来源'} · {media.id}
                      </strong>
                      {urls[media.id] && (
                        <img
                          src={urls[media.id]}
                          alt="本次生成的视觉资产"
                          style={{
                            display: 'block',
                            maxWidth: '100%',
                            maxHeight: 240,
                            objectFit: 'contain',
                          }}
                        />
                      )}
                      {origin?.details.map((detail) => (
                        <p key={detail}>{detail}</p>
                      ))}
                    </article>
                  );
                })}
              {scientific && (
                <p data-harness-actual-route="scientific-visual">
                  讲稿驱动科学图：在“同次 Native”或完整课件预览中检查播放、暂停和拖动播放头。
                </p>
              )}
              <p>此处仅显示调试证据；来源、许可的产品展示方式不属于本轮功能。</p>
            </section>
          )}
          {tab === 'request' && <pre>{JSON.stringify(evidence.request, null, 2)}</pre>}
          {tab === 'prompt' &&
            evidence.prompts.map((prompt, index) => (
              <details key={index} open>
                <summary>
                  {prompt.stage} · {prompt.promptVersion}
                </summary>
                <pre>{formatPrompt(prompt.serializedModelInput)}</pre>
              </details>
            ))}
          {tab === 'diagnostics' && (
            <pre>
              {JSON.stringify(
                {
                  status: evidence.status,
                  error: evidence.error,
                  diagnostics: evidence.diagnostics ?? [],
                },
                null,
                2,
              )}
            </pre>
          )}
        </>
      )}
    </section>
  );
}

function formatPrompt(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
