'use client';

import { MessageSquareText } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './Button';

export type FeedbackTranslator = (key: string) => string;
export type FeedbackCategory =
  | 'bug'
  | 'usability'
  | 'content'
  | 'accessibility'
  | 'performance'
  | 'feature'
  | 'other';

const categories: FeedbackCategory[] = [
  'bug',
  'usability',
  'content',
  'accessibility',
  'performance',
  'feature',
  'other',
];
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type FeedbackCaptureProps = {
  t: FeedbackTranslator;
  endpoint?: string;
};

function ImagePreview({ file, alt, onClick }: { file: File; alt: string; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!url) return null;
  return (
    <button type="button" className="rx-feedback-preview" onClick={onClick} aria-label={alt}>
      <img src={url} alt={alt} />
    </button>
  );
}

/** Capture the rendered browser tab, preserving cross-origin and canvas content. */
async function captureViewport(): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return null;
  const getDisplayMedia =
    navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices) ??
    (
      navigator as Navigator & {
        getDisplayMedia?: (options?: DisplayMediaStreamOptions) => Promise<MediaStream>;
      }
    ).getDisplayMedia;
  if (!getDisplayMedia) return null;

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  try {
    const isChromium = /Chrome|Chromium|Edg\//.test(navigator.userAgent);
    stream = await getDisplayMedia(
      isChromium
        ? ({
            video: { displaySurface: 'browser', cursor: 'never' },
            audio: false,
            preferCurrentTab: true,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'exclude',
            monitorTypeSurfaces: 'exclude',
          } as DisplayMediaStreamOptions)
        : { video: true, audio: false },
    );
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const nextFrame = () =>
      new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
      });
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve) => {
        video?.addEventListener('loadedmetadata', () => resolve(), { once: true });
      });
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve) => {
        video?.addEventListener('loadeddata', () => resolve(), { once: true });
      });
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      await new Promise<void>((resolve) => video?.requestVideoFrameCallback(() => resolve()));
    } else {
      await nextFrame();
    }

    const width = Math.max(1, video.videoWidth || document.documentElement.clientWidth);
    const height = Math.max(1, video.videoHeight || document.documentElement.clientHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }
}

export function FeedbackCapture({ t, endpoint = '/api/feedback' }: FeedbackCaptureProps) {
  const tr = (key: string) =>
    t(key) === key
      ? ({
          'feedback.consent.accept': 'I understand and want to include the screenshot.',
          'feedback.consent.required': 'Please confirm the screenshot consent.',
        }[key] ?? key)
      : t(key);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [description, setDescription] = useState('');
  const [consented, setConsented] = useState(true);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [lightbox, setLightbox] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const inputId = useId();
  const previousFocus = useRef<HTMLElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);

  async function activate() {
    previousFocus.current = document.activeElement as HTMLElement | null;
    setExpanded(false);
    setStatus(null);
    setConsented(true);
    const blob = await captureViewport();
    setOpen(true);
    if (blob) {
      setScreenshot(new File([blob], 'page-screenshot.jpg', { type: 'image/jpeg' }));
    } else {
      setStatus(t('feedback.screenshot.unavailable'));
    }
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setLightbox(null);
    previousFocus.current?.focus();
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    const next = [...files, ...selected];
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (
      next.length > MAX_FILES ||
      next.some((file) => !['image/png', 'image/jpeg'].includes(file.type)) ||
      next.some((file) => file.size > MAX_FILE_BYTES) ||
      total > MAX_TOTAL_BYTES
    ) {
      setStatus(t('feedback.files.invalid'));
      return;
    }
    setFiles(next);
  }

  async function submit() {
    if (busy || resultOpen || submittingRef.current) return;
    if (screenshot && !consented) {
      setStatus(tr('feedback.consent.required'));
      return;
    }
    if (!description.trim()) {
      setStatus(t('feedback.description.required'));
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setStatus(null);
    const body = new FormData();
    body.set('category', category);
    body.set('description', description.trim());
    body.set('url', `${location.origin}${location.pathname}${location.search}`);
    if (screenshot) body.set('screenshot', screenshot);
    files.forEach((file) => body.append('attachments', file));
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      });
      if (!response.ok) throw new Error('feedback submission failed');
      setOpen(false);
      launcherRef.current?.focus();
      setResultOpen(true);
      setDescription('');
      setFiles([]);
      setScreenshot(null);
    } catch {
      setStatus(t('feedback.submit.failed'));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={launcherRef}
        className="rx-feedback-launcher"
        type="button"
        aria-expanded={expanded}
        aria-label={t('feedback.launcher')}
        onMouseEnter={() => setExpanded(true)}
        onFocus={() => setExpanded(true)}
        onMouseLeave={() => {
          if (document.activeElement !== launcherRef.current) setExpanded(false);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false);
        }}
        onClick={() => (expanded ? void activate() : setExpanded(true))}
      >
        <span aria-hidden="true">
          <MessageSquareText strokeWidth={1.75} />
        </span>
        <span
          className={expanded ? 'rx-feedback-label' : 'rx-feedback-label rx-feedback-label-hidden'}
        >
          {t('feedback.launcher')}
        </span>
      </button>
      {open ? (
        <div
          className="rx-feedback-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && close()}
        >
          <section
            className="rx-feedback-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${inputId}-title`}
          >
            <header className="rx-feedback-dialog-header">
              <div>
                <h2 id={`${inputId}-title`}>{t('feedback.title')}</h2>
                <p>{t('feedback.consent')}</p>
              </div>
              <button
                type="button"
                className="rx-feedback-close"
                onClick={close}
                aria-label={t('feedback.cancel')}
              >
                ×
              </button>
            </header>
            {screenshot ? (
              <label className="rx-feedback-consent">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(event) => setConsented(event.target.checked)}
                />
                <span>{tr('feedback.consent.accept')}</span>
              </label>
            ) : null}
            {screenshot ? (
              <ImagePreview
                file={screenshot}
                onClick={() => setLightbox(screenshot)}
                alt={t('feedback.screenshot.alt')}
              />
            ) : null}
            {screenshot ? (
              <button
                type="button"
                onClick={() => {
                  setScreenshot(null);
                  setStatus(null);
                }}
              >
                {t('feedback.screenshot.remove')}
              </button>
            ) : null}
            <fieldset>
              <legend>{t('feedback.category')}</legend>
              <div className="rx-feedback-categories">
                {categories.map((item) => (
                  <label key={item}>
                    <input
                      type="radio"
                      name="feedback-category"
                      checked={category === item}
                      onChange={() => setCategory(item)}
                    />
                    <span>{t(`feedback.category.${item}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label htmlFor={`${inputId}-description`}>{t('feedback.description')}</label>
            <textarea
              id={`${inputId}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
            />
            <div className="rx-feedback-upload-section">
              <span className="rx-feedback-upload-heading">{t('feedback.attachments')}</span>
            </div>
            <input
              className="rx-feedback-file-input"
              id={`${inputId}-files`}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              onChange={chooseFiles}
            />
            <div className="rx-feedback-attachments">
              {files.map((file) => (
                <div className="rx-feedback-attachment" key={`${file.name}-${file.lastModified}`}>
                  <ImagePreview file={file} onClick={() => setLightbox(file)} alt={file.name} />
                  <span>{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((current) => current.filter((item) => item !== file))}
                  >
                    {t('feedback.screenshot.remove')}
                  </button>
                </div>
              ))}
              {files.length < MAX_FILES ? (
                <label
                  className="rx-feedback-upload-label"
                  htmlFor={`${inputId}-files`}
                  aria-label={t('feedback.attachments')}
                >
                  <span className="rx-feedback-upload-icon" aria-hidden="true">
                    +
                  </span>
                </label>
              ) : null}
            </div>
            {status ? <p role="status">{status}</p> : null}
            <div className="rx-feedback-actions">
              <Button variant="secondary" disabled={busy} onClick={close}>
                {t('feedback.cancel')}
              </Button>
              <Button
                disabled={busy}
                loading={busy}
                loadingLabel={t('feedback.submitting')}
                onClick={() => void submit()}
              >
                {busy ? t('feedback.submitting') : t('feedback.submit')}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      <ConfirmDialog
        open={resultOpen}
        title={t('feedback.submitted')}
        cancelLabel={undefined}
        confirmLabel={t('feedback.ok')}
        onCancel={() => setResultOpen(false)}
        onConfirm={() => setResultOpen(false)}
      />
      {lightbox ? (
        <ImageLightbox
          file={lightbox}
          alt={t('feedback.screenshot.alt')}
          label={t('feedback.screenshot.preview')}
          closeLabel={t('feedback.cancel')}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </>
  );
}

function ImageLightbox({
  file,
  alt,
  label,
  closeLabel,
  onClose,
}: {
  file: File;
  alt: string;
  label: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!url) return null;
  return (
    <div
      className="rx-feedback-lightbox"
      role="dialog"
      aria-label={label}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <button
        type="button"
        className="rx-feedback-lightbox-close"
        onClick={onClose}
        aria-label={closeLabel}
      >
        {'×'}
      </button>
      <img src={url} alt={alt} />
    </div>
  );
}
