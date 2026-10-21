'use client';

import { Camera, FileUp } from 'lucide-react';
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import { Button } from './Button';

export type UploadChooserKind = 'camera' | 'file';

export interface UploadChooserOption {
  /** 按钮文字，例如「打开相机」「选择文件」。 */
  actionLabel: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** 默认 camera 用 lucide Camera，file 用 FileUp。 */
  icon?: ReactNode;
  title: ReactNode;
}

export type UploadChooserProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  camera: UploadChooserOption;
  disabled?: boolean;
  file: UploadChooserOption;
  onChoose: (kind: UploadChooserKind) => void;
};

/**
 * 学生答题上传方式选择（规范 03 §3.29）：「拍照上传 / 文件上传」两张卡并排。
 * 只是内容，由调用方放进 `sm` Dialog；选择后由调用方打开相机或文件对话框。
 */
export const UploadChooser = forwardRef<HTMLDivElement, UploadChooserProps>(function UploadChooser(
  { camera, className, disabled = false, file, onChoose, ...props },
  ref,
) {
  return (
    <div className={cn('rx-upload-chooser', className)} ref={ref} {...props}>
      <ChooserCard
        defaultIcon={<Camera strokeWidth={1.5} />}
        disabled={disabled}
        kind="camera"
        onChoose={onChoose}
        option={camera}
      />
      <ChooserCard
        defaultIcon={<FileUp strokeWidth={1.5} />}
        disabled={disabled}
        kind="file"
        onChoose={onChoose}
        option={file}
      />
    </div>
  );
});

function ChooserCard({
  defaultIcon,
  disabled,
  kind,
  onChoose,
  option,
}: {
  defaultIcon: ReactNode;
  disabled: boolean;
  kind: UploadChooserKind;
  onChoose: (kind: UploadChooserKind) => void;
  option: UploadChooserOption;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const off = disabled || option.disabled === true;
  return (
    <div
      className="rx-upload-chooser-card"
      data-disabled={off ? 'true' : undefined}
      data-kind={kind}
    >
      <span aria-hidden="true" className="rx-upload-chooser-icon">
        {option.icon ?? defaultIcon}
      </span>
      <span className="rx-upload-chooser-title" id={titleId}>
        {option.title}
      </span>
      {option.description === undefined ? null : (
        <span className="rx-upload-chooser-description" id={descriptionId}>
          {option.description}
        </span>
      )}
      <Button
        aria-describedby={cn(titleId, option.description === undefined ? null : descriptionId)}
        disabled={off}
        onClick={() => onChoose(kind)}
        variant="outline"
      >
        {option.actionLabel}
      </Button>
    </div>
  );
}
