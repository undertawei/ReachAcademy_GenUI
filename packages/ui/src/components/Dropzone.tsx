'use client';

import { Upload } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../cn';

export type UploadRejectReason = 'count' | 'size' | 'type';

export interface UploadRejection {
  file: File;
  reason: UploadRejectReason;
}

export interface FileValidationOptions {
  /** 同 `<input accept>`：`.png`、`image/*`、`application/pdf`，逗号分隔；空表示不限类型。 */
  accept?: string;
  /** 已有文件数（例如 FileList 里已选的），用于数量校验。 */
  currentCount?: number;
  /** 最多文件数（含已有）。 */
  maxFiles?: number;
  /** 单个文件的最大字节数。 */
  maxSize?: number;
  /** 为 false 时一次只接受一个文件，其余按 `count` 拒绝。 */
  multiple?: boolean;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  const tokens = (accept ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

/**
 * 前端先校验类型、大小、数量（规范 03 §3.29），拒绝项带原因返回，由调用方就地显示文案。
 * 类型与大小先判；数量只对通过前两项的文件按顺序计算剩余名额。
 */
export function validateFiles(
  files: readonly File[],
  { accept, currentCount = 0, maxFiles, maxSize, multiple = true }: FileValidationOptions = {},
): { accepted: File[]; rejected: UploadRejection[] } {
  const accepted: File[] = [];
  const rejected: UploadRejection[] = [];
  const perBatch = multiple ? Number.POSITIVE_INFINITY : 1;
  const remaining = Math.min(
    perBatch,
    maxFiles === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxFiles - currentCount),
  );
  for (const file of files) {
    if (!matchesAccept(file, accept)) rejected.push({ file, reason: 'type' });
    else if (maxSize !== undefined && file.size > maxSize) rejected.push({ file, reason: 'size' });
    else if (accepted.length >= remaining) rejected.push({ file, reason: 'count' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export interface FilePickerOptions extends FileValidationOptions {
  disabled?: boolean;
  onFiles?: (files: File[]) => void;
  onReject?: (rejections: UploadRejection[]) => void;
}

/** 内部：隐藏的 `<input type=file>` + 校验后分发。Dropzone 与 FileList 共用。 */
export function useFilePicker(options: FilePickerOptions) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handleFiles = useCallback((list: FileList | readonly File[] | null | undefined) => {
    const current = optionsRef.current;
    if (current.disabled || !list) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    const { accepted, rejected } = validateFiles(files, current);
    if (rejected.length > 0) current.onReject?.(rejected);
    if (accepted.length > 0) current.onFiles?.(accepted);
  }, []);

  const open = useCallback(() => {
    if (optionsRef.current.disabled) return;
    inputRef.current?.click();
  }, []);

  const inputProps: InputHTMLAttributes<HTMLInputElement> & {
    ref: RefObject<HTMLInputElement | null>;
  } = {
    accept: options.accept,
    'aria-hidden': true,
    className: 'rx-visually-hidden',
    disabled: options.disabled,
    multiple: options.multiple ?? true,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      handleFiles(event.currentTarget.files);
      // 清空以便再次选择同一个文件也能触发 change。
      event.currentTarget.value = '';
    },
    ref: inputRef,
    tabIndex: -1,
    type: 'file',
  };

  return { handleFiles, inputProps, open };
}

export type DropzoneTone = 'default' | 'primary';

export type DropzoneProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onDrop' | 'title'> &
  FilePickerOptions & {
    /** 说明之后的附加内容（应为非交互内容：整个区域本身就是按钮）。 */
    children?: ReactNode;
    /** 格式与大小说明，例如「支持 PNG、JPEG、WebP 格式，最大 5MB」。 */
    description?: ReactNode;
    /** 中间图标，默认 lucide Upload。 */
    icon?: ReactNode;
    /** 透传给隐藏 file input 的 name / capture 等属性。 */
    inputProps?: Omit<
      InputHTMLAttributes<HTMLInputElement>,
      'accept' | 'multiple' | 'onChange' | 'type'
    >;
    /** 标题，例如「点击或拖拽文件到此处上传」。 */
    title?: ReactNode;
    /** `primary`：学生端上传选择卡的 primary 60% 虚线描边。 */
    tone?: DropzoneTone;
  };

/**
 * 拖放/点击上传区（规范 03 §3.29）。可点击、可键盘（Enter/Space）打开文件对话框；
 * 选择或拖入的文件先按 accept / maxSize / maxFiles 校验，通过的交给 onFiles，拒绝的交给 onReject。
 */
export const Dropzone = forwardRef<HTMLDivElement, DropzoneProps>(function Dropzone(
  {
    accept,
    children,
    className,
    currentCount,
    description,
    disabled = false,
    icon,
    inputProps,
    maxFiles,
    maxSize,
    multiple = true,
    onClick,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onFiles,
    onKeyDown,
    onReject,
    title,
    tone = 'default',
    ...props
  },
  ref,
) {
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);
  const titleId = useId();
  const descriptionId = useId();
  const picker = useFilePicker({
    accept,
    currentCount,
    disabled,
    maxFiles,
    maxSize,
    multiple,
    onFiles,
    onReject,
  });

  const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const reset = () => {
    depth.current = 0;
    setDragActive(false);
  };

  return (
    <div
      aria-describedby={description === undefined ? undefined : descriptionId}
      aria-disabled={disabled || undefined}
      aria-labelledby={title === undefined ? undefined : titleId}
      className={cn('rx-dropzone', className)}
      data-disabled={disabled ? 'true' : undefined}
      data-state={dragActive ? 'active' : 'idle'}
      data-tone={tone}
      ref={ref}
      role="button"
      tabIndex={disabled ? -1 : 0}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // 点在内部的按钮等交互元素上时由它自己处理。
        const target = event.target as HTMLElement;
        const interactive = target.closest('button, a, input');
        if (interactive && interactive !== event.currentTarget) return;
        picker.open();
      }}
      onDragEnter={(event) => {
        onDragEnter?.(event);
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        onDragLeave?.(event);
        if (!dragActive) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragActive(false);
      }}
      onDragOver={(event) => {
        onDragOver?.(event);
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        reset();
        picker.handleFiles(event.dataTransfer?.files);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          picker.open();
        }
      }}
    >
      <input {...inputProps} {...picker.inputProps} />
      <span aria-hidden="true" className="rx-dropzone-icon">
        {icon ?? <Upload strokeWidth={1.5} />}
      </span>
      {title === undefined ? null : (
        <span className="rx-dropzone-title" id={titleId}>
          {title}
        </span>
      )}
      {description === undefined ? null : (
        <span className="rx-dropzone-description" id={descriptionId}>
          {description}
        </span>
      )}
      {children}
    </div>
  );
});
