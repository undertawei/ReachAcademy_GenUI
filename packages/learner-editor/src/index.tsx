'use client';

import { EditorContent, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type LearnerEditorKey =
  | 'toolbar'
  | 'bold'
  | 'italic'
  | 'bulletList'
  | 'orderedList'
  | 'heading'
  | 'blockquote'
  | 'codeBlock'
  | 'undo'
  | 'redo'
  | 'inlineMath'
  | 'blockMath'
  | 'uploadImage'
  | 'takePhoto'
  | 'systemCamera'
  | 'cameraTitle'
  | 'cameraPreview'
  | 'photoPreview'
  | 'capture'
  | 'retake'
  | 'usePhoto'
  | 'close'
  | 'cameraStarting'
  | 'cameraInsecure'
  | 'cameraUnavailable'
  | 'cameraDenied'
  | 'cameraNotFound'
  | 'cameraError'
  | 'imageLimit'
  | 'imageError'
  | 'uploadError'
  | 'uploading';
export type LearnerEditorTranslate = (key: LearnerEditorKey) => string;
export interface LearnerEditorOptions {
  formatting: 'none' | 'basic' | 'full';
  math: boolean;
  images: boolean;
  attachments: boolean;
}
export interface LearnerEditorProps {
  editor: Editor | null;
  contextKey?: string;
  allowOwnedHtmlPaste?: (html: string) => boolean;
  remainingImages?: number;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  translate: LearnerEditorTranslate;
  options: LearnerEditorOptions;
  customFormattingToolbar?: ReactNode;
  toolbarClassName?: string;
  toolbarLabel?: string;
  onInsertMath?: (displayMode: boolean) => void;
  onImages?: (files: File[]) => Promise<void>;
  attachments?: ReactNode;
  className?: string;
}

export function getClipboardImageFiles(data: DataTransfer): File[] {
  const items = Array.from(data.items ?? []);
  const files = items
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
  return files.length
    ? files
    : Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}

/** Normalize formats unsupported by upload endpoints only when this browser can decode them. */
export async function prepareLearnerImage(file: File): Promise<File> {
  if (file.size > 100 * 1024 * 1024) throw new Error('imageError');
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  if (!file.type.startsWith('image/')) throw new Error('imageError');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, Math.sqrt(24_000_000 / (image.naturalWidth * image.naturalHeight)));
    canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('imageError');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    );
    if (!blob) throw new Error('imageError');
    return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function CameraDialog({
  translate: t,
  onClose,
  onPhoto,
}: {
  translate: LearnerEditorTranslate;
  onClose: () => void;
  onPhoto: (file: File) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [nativeCapture, setNativeCapture] = useState(false);
  const [error, setError] = useState<LearnerEditorKey | null>(null);
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      live.current = false;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => {
    if (photo || nativeCapture) return;
    let cancelled = false;
    setReady(false);
    setError(null);
    if (!window.isSecureContext) {
      setError('cameraInsecure');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('cameraUnavailable');
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        if (video.current) {
          video.current.srcObject = media;
          try {
            await video.current.play();
          } catch {
            if (!cancelled) setError('cameraError');
          }
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'cameraDenied'
            : name === 'NotFoundError'
              ? 'cameraNotFound'
              : 'cameraError',
        );
      });
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
    };
  }, [photo, nativeCapture]);
  function useNativeCapture() {
    // A user gesture is required to open the device picker. Release browser capture first.
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setReady(false);
    setNativeCapture(true);
    cameraInput.current?.click();
  }
  async function capture() {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight) return;
    setReady(false);
    const canvas = document.createElement('canvas');
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      setError('cameraError');
      return;
    }
    context.drawImage(source, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    );
    if (!live.current) return;
    if (!blob) {
      setError('cameraError');
      return;
    }
    setPhoto(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
  }
  return (
    <dialog
      ref={dialog}
      className="learner-editor-camera"
      aria-label={t('cameraTitle')}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2>{t('cameraTitle')}</h2>
      {photo && preview ? (
        <img src={preview} alt={t('photoPreview')} />
      ) : !nativeCapture ? (
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label={t('cameraPreview')}
          onLoadedData={() => setReady(true)}
        />
      ) : null}
      {error ? (
        <p role="alert">{t(error)}</p>
      ) : !ready && !photo && !nativeCapture ? (
        <p role="status">{t('cameraStarting')}</p>
      ) : null}
      <div className="learner-editor-toolbar">
        {photo ? (
          <>
            <button
              type="button"
              onClick={() => {
                setPhoto(null);
                if (nativeCapture) cameraInput.current?.click();
              }}
            >
              {t('retake')}
            </button>
            <button type="button" onClick={() => onPhoto(photo)}>
              {t('usePhoto')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!ready || !!error || nativeCapture}
              onClick={() => void capture()}
            >
              {t('capture')}
            </button>
            {(error || nativeCapture) && (
              <button type="button" onClick={useNativeCapture}>
                {t('systemCamera')}
              </button>
            )}
          </>
        )}
        <button type="button" onClick={onClose}>
          {t('close')}
        </button>
      </div>
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label={t('systemCamera')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            setError(null);
            setPhoto(file);
          }
          event.target.value = '';
        }}
      />
    </dialog>
  );
}

export function LearnerEditor({
  editor,
  contextKey,
  allowOwnedHtmlPaste,
  remainingImages = 10,
  onBusyChange,
  disabled = false,
  busy = false,
  translate: t,
  options,
  customFormattingToolbar,
  toolbarClassName,
  toolbarLabel,
  onInsertMath,
  onImages,
  attachments,
  className,
}: LearnerEditorProps) {
  const [uploading, setUploading] = useState(false);
  const [camera, setCamera] = useState(false);
  const cameraGeneration = useRef(0);
  const [error, setError] = useState<LearnerEditorKey | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mutex = useRef(false);
  const mounted = useRef(true);
  const reportedBusy = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const reportBusy = (value: boolean) => {
    if (reportedBusy.current === value) return;
    reportedBusy.current = value;
    busyCallback.current?.(value);
  };
  const current = useRef({ disabled, busy, images: options.images, onImages, editor, contextKey });
  const generation = useRef(0);
  if (
    current.current.disabled !== disabled ||
    current.current.busy !== busy ||
    current.current.images !== options.images ||
    current.current.editor !== editor ||
    current.current.contextKey !== contextKey
  )
    generation.current++;
  current.current = { disabled, busy, images: options.images, onImages, editor, contextKey };
  const locked = disabled || busy || uploading || !editor;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reportBusy(false);
    };
  }, []);
  useEffect(() => {
    if (disabled || busy || !options.images || cameraGeneration.current !== generation.current)
      setCamera(false);
  }, [disabled, busy, options.images, editor, contextKey]);
  async function upload(files: File[]) {
    const active = current.current;
    const uploadGeneration = generation.current;
    if (
      mutex.current ||
      active.disabled ||
      active.busy ||
      !active.images ||
      !active.onImages ||
      !active.editor ||
      active.editor.isDestroyed ||
      !files.length
    )
      return;
    if (files.length > remainingImages) {
      setError('imageLimit');
      return;
    }
    mutex.current = true;
    reportBusy(true);
    setUploading(true);
    setError(null);
    let phase: 'imageError' | 'uploadError' = 'imageError';
    try {
      const prepared: File[] = [];
      for (const file of files) prepared.push(await prepareLearnerImage(file));
      if (
        !mounted.current ||
        active.editor.isDestroyed ||
        uploadGeneration !== generation.current ||
        current.current.disabled ||
        current.current.busy ||
        !current.current.images
      )
        return;
      phase = 'uploadError';
      await active.onImages(prepared);
    } catch {
      if (mounted.current && !current.current.disabled) setError(phase);
    } finally {
      mutex.current = false;
      reportBusy(false);
      if (mounted.current) setUploading(false);
    }
  }
  // Commands are optional: owning apps decide which extensions exist in their schema.
  function command(name: string, ...args: unknown[]) {
    if (locked || !editor) return;
    editor.commands.focus();
    const commands = editor.commands as unknown as Record<
      string,
      ((...args: unknown[]) => boolean) | undefined
    >;
    commands[name]?.(...args);
  }
  function button(key: LearnerEditorKey, name: string, ...args: unknown[]) {
    if (!editor || !(name in editor.commands)) return null;
    return (
      <button
        key={key}
        type="button"
        disabled={locked}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => command(name, ...args)}
      >
        {t(key)}
      </button>
    );
  }
  return (
    <div
      className={['learner-editor', className].filter(Boolean).join(' ')}
      aria-busy={uploading || busy}
    >
      <div
        className={['learner-editor-toolbar', toolbarClassName].filter(Boolean).join(' ')}
        role="group"
        aria-label={toolbarLabel ?? t('toolbar')}
      >
        {options.formatting !== 'none' &&
          (customFormattingToolbar ?? (
            <>
              {button('bold', 'toggleBold')}
              {button('italic', 'toggleItalic')}
              {button('bulletList', 'toggleBulletList')}
              {button('orderedList', 'toggleOrderedList')}
              {options.formatting === 'full' && (
                <>
                  {button('heading', 'toggleHeading', { level: 2 })}
                  {button('blockquote', 'toggleBlockquote')}
                  {button('codeBlock', 'toggleCodeBlock')}
                  {button('undo', 'undo')}
                  {button('redo', 'redo')}
                </>
              )}
            </>
          ))}
        {options.math && onInsertMath && (
          <>
            <button
              type="button"
              disabled={locked}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onInsertMath(false)}
            >
              {t('inlineMath')}
            </button>
            <button
              type="button"
              disabled={locked}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onInsertMath(true)}
            >
              {t('blockMath')}
            </button>
          </>
        )}
        {options.images && onImages && (
          <>
            <button
              type="button"
              disabled={locked || remainingImages <= 0}
              onClick={() => fileInput.current?.click()}
            >
              {t('uploadImage')}
            </button>
            <button
              type="button"
              disabled={locked || remainingImages <= 0}
              onClick={() => {
                cameraGeneration.current = generation.current;
                setCamera(true);
              }}
            >
              {t('takePhoto')}
            </button>
          </>
        )}
      </div>
      <div
        onDragOverCapture={(event) => {
          if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
        }}
        onDropCapture={(event) => {
          const files = getClipboardImageFiles(event.dataTransfer);
          const html = event.dataTransfer.getData('text/html');
          if (files.length || /<(?:img|picture|svg)\b/i.test(html)) {
            event.preventDefault();
            event.stopPropagation();
            if (files.length && !locked) void upload(files);
          }
        }}
        onPasteCapture={(event) => {
          const files = getClipboardImageFiles(event.clipboardData);
          if (files.length) {
            event.preventDefault();
            event.stopPropagation();
            if (!locked) void upload(files);
            return;
          }
          const html = event.clipboardData.getData('text/html');
          if (
            html &&
            /<(?:img|picture|svg)\b/i.test(html) &&
            !(options.images && !locked && allowOwnedHtmlPaste?.(html))
          ) {
            // Keep text/Office markup, but never insert remote or data-URI image references.
            event.preventDefault();
            event.stopPropagation();
            if (locked || !editor) return;
            const document = new DOMParser().parseFromString(html, 'text/html');
            document
              .querySelectorAll('img,picture,svg')
              .forEach((node) =>
                node.replaceWith(document.createTextNode(node.getAttribute('alt') ?? '')),
              );
            editor.view.pasteHTML(document.body.innerHTML, event.nativeEvent as ClipboardEvent);
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {options.images && onImages && (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={locked || remainingImages <= 0}
            aria-label={t('uploadImage')}
            onChange={(event) => {
              void upload(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </>
      )}
      {uploading && <p role="status">{t('uploading')}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {options.attachments && attachments && (
        <div className="learner-editor-attachments">{attachments}</div>
      )}
      {camera && cameraGeneration.current === generation.current && !locked && options.images && (
        <CameraDialog
          translate={t}
          onClose={() => setCamera(false)}
          onPhoto={(file) => {
            setCamera(false);
            void upload([file]);
          }}
        />
      )}
    </div>
  );
}
