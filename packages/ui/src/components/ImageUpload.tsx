'use client';

import { Eye, ImagePlus, Trash2, X } from 'lucide-react';
import { forwardRef, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import { useFocusTrap } from '../primitives/focus';
import { Portal, useLayer } from '../primitives/layer';
import { usePresence } from '../primitives/usePresence';
import { Dropzone, type UploadRejection } from './Dropzone';
import { IconButton } from './IconButton';

export type ImageUploadProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'title'> & {
  /** 默认 `image/*`。 */
  accept?: string;
  /** 图片替代文字（课程名称等）。 */
  alt?: string;
  /** 灯箱关闭按钮的可读名称。 */
  closeLabel: string;
  disabled?: boolean;
  /** 空状态 Dropzone 的格式与大小说明。 */
  dropzoneDescription?: ReactNode;
  /** 空状态 Dropzone 的标题。 */
  dropzoneTitle?: ReactNode;
  /** 生成中：图片区显示骨架与进度文案。 */
  generating?: boolean;
  /** 生成中的进度文案（例如「正在生成封面…」），同时作为 aria-live 播报。 */
  generatingLabel?: ReactNode;
  /** 区块头部右侧操作位（例如调用方提供的 accent「智能生成」按钮）。 */
  headerAction?: ReactNode;
  /** 区块标题（例如「课程封面」）。 */
  heading?: ReactNode;
  maxSize?: number;
  onChange?: (file: File) => void;
  onReject?: (rejections: UploadRejection[]) => void;
  onRemove?: () => void;
  /** 悬停遮罩上「预览」按钮的可读名称。 */
  previewLabel: string;
  /** 悬停遮罩上「删除」按钮的可读名称。 */
  removeLabel: string;
  /** 当前图片 URL；为空时显示 Dropzone。 */
  value?: string | null;
};

/**
 * 课程封面上传（规范 03 §3.29）：16:9 预览，悬停出现 ink 50% 遮罩与预览/删除按钮，
 * 预览打开灯箱（Esc 或点击遮罩关闭）；空时为 Dropzone。
 */
export const ImageUpload = forwardRef<HTMLDivElement, ImageUploadProps>(function ImageUpload(
  {
    accept = 'image/*',
    alt = '',
    className,
    closeLabel,
    disabled = false,
    dropzoneDescription,
    dropzoneTitle,
    generating = false,
    generatingLabel,
    headerAction,
    heading,
    maxSize,
    onChange,
    onReject,
    onRemove,
    previewLabel,
    removeLabel,
    value,
    ...props
  },
  ref,
) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const headingId = useId();
  const hasImage = typeof value === 'string' && value !== '';

  let body: ReactNode;
  if (generating) {
    body = (
      <div aria-busy="true" className="rx-image-upload-frame" data-state="generating">
        <span aria-hidden="true" className="rx-image-upload-skeleton" />
        {generatingLabel === undefined ? null : (
          <span aria-live="polite" className="rx-image-upload-generating" role="status">
            {generatingLabel}
          </span>
        )}
      </div>
    );
  } else if (hasImage) {
    body = (
      <div className="rx-image-upload-frame" data-state="filled">
        <img alt={alt} className="rx-image-upload-image" src={value} />
        <div className="rx-image-upload-overlay">
          <IconButton
            icon={<Eye />}
            size="md"
            label={previewLabel}
            onClick={() => setPreviewOpen(true)}
            variant="inverse"
          />
          {onRemove === undefined ? null : (
            <IconButton
              disabled={disabled}
              icon={<Trash2 />}
              size="md"
              label={removeLabel}
              onClick={onRemove}
              variant="inverse"
            />
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <Dropzone
        accept={accept}
        className="rx-image-upload-dropzone"
        description={dropzoneDescription}
        disabled={disabled}
        icon={<ImagePlus strokeWidth={1.5} />}
        maxSize={maxSize}
        multiple={false}
        onFiles={(files) => {
          const [file] = files;
          if (file) onChange?.(file);
        }}
        onReject={onReject}
        title={dropzoneTitle}
      />
    );
  }

  return (
    <div
      aria-labelledby={heading === undefined ? undefined : headingId}
      className={cn('rx-image-upload', className)}
      data-disabled={disabled ? 'true' : undefined}
      ref={ref}
      role="group"
      {...props}
    >
      {heading === undefined && headerAction === undefined ? null : (
        <div className="rx-image-upload-header">
          {heading === undefined ? (
            <span />
          ) : (
            <span className="rx-image-upload-heading" id={headingId}>
              {heading}
            </span>
          )}
          {headerAction}
        </div>
      )}
      {body}
      {hasImage ? (
        <Lightbox
          alt={alt}
          closeLabel={closeLabel}
          label={previewLabel}
          onClose={() => setPreviewOpen(false)}
          open={previewOpen && !generating}
          src={value}
        />
      ) : null}
    </div>
  );
});

function Lightbox({
  alt,
  closeLabel,
  label,
  onClose,
  open,
  src,
}: {
  alt: string;
  closeLabel: string;
  label: string;
  onClose: () => void;
  open: boolean;
  src: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>(open);
  const layer = useLayer({
    active: open,
    elements: [contentRef],
    kind: 'modal',
    onDismiss: onClose,
  });
  // 初始聚焦对话框本身：聚焦关闭按钮会弹出它的 Tooltip，第一次 Esc 只会关掉 Tooltip。
  useFocusTrap({ active: open, container: dialogRef, initialFocus: 'container' });

  if (!presence.mounted) return null;
  return (
    <Portal>
      <layer.Provider>
        <div
          aria-label={alt || label}
          aria-modal="true"
          className="rx-lightbox"
          data-state={presence.state}
          ref={(node) => {
            dialogRef.current = node;
            presence.ref(node);
          }}
          role="dialog"
          style={{ zIndex: layer.zIndex }}
        >
          <div className="rx-lightbox-content" ref={contentRef}>
            <img alt={alt} className="rx-lightbox-image" src={src} />
            <IconButton
              className="rx-lightbox-close"
              icon={<X />}
              label={closeLabel}
              onClick={onClose}
              variant="inverse"
            />
          </div>
        </div>
      </layer.Provider>
    </Portal>
  );
}
