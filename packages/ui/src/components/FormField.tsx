'use client';

import { CircleAlert } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useMemo,
  type AriaAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '../cn';

/** FormField 通过上下文下发给内部控件的信息（规范 03 §3.3、06 §4）。 */
interface FormFieldContextValue {
  /** 控件 id；标签用 htmlFor 指向它。 */
  controlId: string;
  /** 当前应关联到控件的描述（错误优先于帮助文字）。 */
  describedBy: string | undefined;
  disabled: boolean;
  invalid: boolean;
  labelId: string | undefined;
  required: boolean;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

export interface FormFieldControlOptions {
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-required'?: AriaAttributes['aria-required'];
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  required?: boolean;
}

export interface FormFieldControlProps {
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
  disabled: boolean;
  id: string | undefined;
  /** 是否位于 FormField 内。 */
  inField: boolean;
  invalid: boolean;
  /** FormField 标签的 id；非可标注元素（role=group 等）可用 aria-labelledby 引用它。 */
  labelId: string | undefined;
  required: boolean;
}

function joinIds(...ids: (string | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined === '' ? undefined : joined;
}

function isTruthyAria(value: AriaAttributes['aria-invalid'] | AriaAttributes['aria-required']) {
  return value === true || value === 'true' || value === 'grammar' || value === 'spelling';
}

/**
 * 共享控件调用本 hook，在 FormField 内自动获得 id、aria-describedby、aria-invalid、aria-required
 * 与禁用态；控件自身传入的属性优先，aria-describedby 会与字段描述合并。不在 FormField 内时原样返回。
 */
export function useFormFieldControl(options: FormFieldControlOptions = {}): FormFieldControlProps {
  const field = useContext(FormFieldContext);
  const invalid =
    options.invalid ??
    (options['aria-invalid'] !== undefined
      ? isTruthyAria(options['aria-invalid'])
      : (field?.invalid ?? false));
  const required =
    options.required ??
    (options['aria-required'] !== undefined
      ? isTruthyAria(options['aria-required'])
      : (field?.required ?? false));
  return {
    'aria-describedby': joinIds(options['aria-describedby'], field?.describedBy),
    'aria-invalid': invalid ? true : undefined,
    'aria-required': required ? true : undefined,
    disabled: options.disabled ?? field?.disabled ?? false,
    id: options.id ?? field?.controlId,
    inField: field !== null,
    invalid,
    labelId: field?.labelId,
    required,
  };
}

export type FormFieldProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 控件；也可以是函数，拿到需要写到原生元素上的属性（id、aria-*、disabled）。 */
  children: ReactNode | ((control: FormFieldControlProps) => ReactNode);
  disabled?: boolean;
  /** 错误文字；非空时替换帮助文字，控件标为 aria-invalid。 */
  error?: ReactNode;
  /** 帮助文字（12 `text-secondary`）。 */
  help?: ReactNode;
  /** 控件 id；不传时自动生成。需要固定 id 时传在这里而不是控件上，以保证标签关联。 */
  htmlFor?: string;
  /** 没有错误文字但仍需标红时使用。 */
  invalid?: boolean;
  label?: ReactNode;
  /** 标签仅对读屏可见（筛选条等已有视觉上下文的场景）。 */
  labelHidden?: boolean;
  required?: boolean;
};

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/** 表单项：标签（上）→ 控件 → 帮助或错误（下），规范 03 §3.3、05 §4。 */
export const FormField = forwardRef<HTMLDivElement, FormFieldProps>(function FormField(
  {
    children,
    className,
    disabled = false,
    error,
    help,
    htmlFor,
    invalid = false,
    label,
    labelHidden = false,
    required = false,
    ...props
  },
  ref,
) {
  const baseId = useId();
  const controlId = htmlFor ?? `${baseId}-control`;
  const labelId = `${baseId}-label`;
  const helpId = `${baseId}-help`;
  const errorId = `${baseId}-error`;
  const hasError = hasContent(error);
  const hasHelp = hasContent(help);
  const hasLabel = hasContent(label);
  const isInvalid = invalid || hasError;
  const describedBy = hasError ? errorId : hasHelp ? helpId : undefined;

  const context = useMemo<FormFieldContextValue>(
    () => ({
      controlId,
      describedBy,
      disabled,
      invalid: isInvalid,
      labelId: hasLabel ? labelId : undefined,
      required,
    }),
    [controlId, describedBy, disabled, hasLabel, isInvalid, labelId, required],
  );

  return (
    <div
      className={cn('rx-form-field', className)}
      data-disabled={disabled ? 'true' : undefined}
      data-invalid={isInvalid ? 'true' : undefined}
      ref={ref}
      {...props}
    >
      {hasLabel ? (
        <label
          className={cn('rx-form-field-label', labelHidden && 'rx-visually-hidden')}
          htmlFor={controlId}
          id={labelId}
        >
          {label}
          {required ? (
            <span aria-hidden="true" className="rx-form-field-required">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      <FormFieldContext.Provider value={context}>
        {typeof children === 'function' ? <FormFieldRenderControl render={children} /> : children}
      </FormFieldContext.Provider>
      {hasError ? (
        <p className="rx-form-field-error" id={errorId}>
          <CircleAlert aria-hidden="true" className="rx-form-field-error-icon" />
          <span>{error}</span>
        </p>
      ) : hasHelp ? (
        <p className="rx-form-field-help" id={helpId}>
          {help}
        </p>
      ) : null}
    </div>
  );
});

function FormFieldRenderControl({
  render,
}: {
  render: (control: FormFieldControlProps) => ReactNode;
}) {
  return <>{render(useFormFieldControl())}</>;
}

export type FormGridProps = HTMLAttributes<HTMLDivElement>;

/** 短字段并排的两列栅格，列间距 16（规范 03 §3.3）；窄屏自动变单列。 */
export const FormGrid = forwardRef<HTMLDivElement, FormGridProps>(function FormGrid(
  { className, ...props },
  ref,
) {
  return <div className={cn('rx-form-grid', className)} ref={ref} {...props} />;
});

export type FormSectionProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  description?: ReactNode;
  /** 标题层级，默认 3。 */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  title: ReactNode;
};

/** 表单内分组：`subtitle` 区块标题，组间距 24、组内字段间距 16（规范 03 §3.3）。 */
export const FormSection = forwardRef<HTMLDivElement, FormSectionProps>(function FormSection(
  { children, className, description, headingLevel = 3, title, ...props },
  ref,
) {
  const titleId = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      aria-labelledby={titleId}
      className={cn('rx-form-section', className)}
      ref={ref}
      role="group"
      {...props}
    >
      <div className="rx-form-section-header">
        <Heading className="rx-form-section-title" id={titleId}>
          {title}
        </Heading>
        {hasContent(description) ? (
          <p className="rx-form-section-description">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
});
