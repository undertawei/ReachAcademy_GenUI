'use client';

import {
  forwardRef,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEventHandler,
  type KeyboardEvent,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { ChipList, type ChipListHandle } from './select/Chips';
import type { SelectSize } from './select/types';

/** Enter 之外生成胶囊的分隔符：英文逗号、中文逗号（规范 03 §3.6）。 */
const SEPARATORS = /[,，\n\r]+/;

export interface TagInputProps {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  autoFocus?: boolean;
  /** 只用于外部布局（宽度、外边距）。 */
  className?: string;
  defaultValue?: readonly string[];
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  /** 最多几项；达到后输入框禁用。 */
  max?: number;
  /** 最多显示几个胶囊（含 +N）；不传时按宽度算满 2 行。 */
  maxChips?: number;
  /** 单项最大长度（超长视为无效）。 */
  maxLength?: number;
  /** +N 胶囊的可读名称。 */
  moreLabel?: (count: number) => string;
  /** 同时为每个值渲染一个同名隐藏 input，供原生表单提交。 */
  name?: string;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onChange?: (value: string[]) => void;
  /** 输入了已存在的值（被忽略）。调用方可在这里轻提示。 */
  onDuplicate?: (value: string) => void;
  onFocus?: FocusEventHandler<HTMLInputElement>;
  /** 值未通过 validate / maxLength（保留在输入框里供修改）。 */
  onInvalid?: (value: string) => void;
  /** +N 弹出层的可读名称。 */
  overflowLabel?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** 胶囊 × 的可读名称，例如 `(label) => \`移除 ${label}\``。 */
  removeLabel: (label: string) => string;
  size?: SelectSize;
  /** 返回 false 时不生成胶囊。 */
  validate?: (value: string) => boolean;
  value?: readonly string[];
  variant?: 'filled' | 'outlined';
}

const EMPTY: readonly string[] = [];

/**
 * 自由输入多值（规范 03 §3.6 TagInput）：Enter 或中英文逗号生成胶囊，粘贴多行自动拆分，
 * 重复值忽略并回调 onDuplicate；胶囊样式与键盘操作同 MultiSelect。
 */
export const TagInput = forwardRef<HTMLInputElement, TagInputProps>(function TagInput(props, ref) {
  const {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    autoFocus,
    className,
    defaultValue,
    disabled = false,
    id,
    invalid = false,
    max,
    maxChips,
    maxLength,
    moreLabel,
    name,
    onBlur,
    onChange,
    onDuplicate,
    onFocus,
    onInvalid,
    overflowLabel,
    placeholder,
    readOnly = false,
    removeLabel,
    size,
    validate,
    value: valueProp,
    variant = 'outlined',
  } = props;
  const controlled = Object.prototype.hasOwnProperty.call(props, 'value');
  const [internalValue, setInternalValue] = useState<readonly string[]>(defaultValue ?? EMPTY);
  const value = (controlled ? valueProp : internalValue) ?? EMPTY;
  const valueRef = useRef(value);
  valueRef.current = value;
  const [draft, setDraft] = useState('');
  const [draftInvalid, setDraftInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const chipsRef = useRef<ChipListHandle>(null);
  const interactive = !disabled && !readOnly;
  const full = max !== undefined && value.length >= max;

  const commit = (next: readonly string[]) => {
    // 受控时以父组件回传的 value 为准；父组件拒绝变更时下一次操作仍基于真实值。
    if (!controlled) {
      valueRef.current = next;
      setInternalValue(next);
    }
    onChange?.([...next]);
  };

  /** 尝试加入若干候选值；返回未能加入的无效片段（留在输入框里）。 */
  const add = (candidates: string[]): string[] => {
    const next = [...valueRef.current];
    const rejected: string[] = [];
    for (const raw of candidates) {
      const tag = raw.trim();
      if (tag === '') continue;
      if (next.includes(tag)) {
        onDuplicate?.(tag);
        continue;
      }
      if ((maxLength !== undefined && tag.length > maxLength) || validate?.(tag) === false) {
        onInvalid?.(tag);
        rejected.push(tag);
        continue;
      }
      if (max !== undefined && next.length >= max) break;
      next.push(tag);
    }
    if (next.length !== valueRef.current.length) commit(next);
    return rejected;
  };

  const flush = (text: string) => {
    const rejected = add(text.split(SEPARATORS));
    setDraft(rejected.join(', '));
    setDraftInvalid(rejected.length > 0);
  };

  const remove = (key: string) => {
    if (!interactive) return;
    commit(valueRef.current.filter((item) => item !== key));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      if (event.key !== 'Enter' || draft.trim() !== '') event.preventDefault();
      flush(draft);
      return;
    }
    if (
      (event.key === 'Backspace' || event.key === 'ArrowLeft') &&
      draft === '' &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      if (chipsRef.current?.focusLast()) event.preventDefault();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!SEPARATORS.test(text)) return;
    event.preventDefault();
    flush(`${draft}${text}`);
  };

  const invalidState = invalid || draftInvalid || ariaInvalid === true || ariaInvalid === 'true';

  return (
    <div
      className={cn('rx-select', 'rx-multi-select', 'rx-tag-input', 'rx-sized', className)}
      data-disabled={disabled || undefined}
      data-invalid={invalidState || undefined}
      data-readonly={readOnly || undefined}
      data-size={size}
      data-variant={variant}
    >
      <div
        className="rx-select-control"
        onMouseDown={(event) => {
          if (event.target !== inputRef.current && !readOnly) {
            event.preventDefault();
            inputRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <ChipList
          handleRef={chipsRef}
          inputRef={inputRef}
          interactive={interactive}
          items={value.map((tag) => ({ key: tag, label: tag, text: tag }))}
          maxChips={maxChips}
          moreLabel={moreLabel}
          onRemove={remove}
          overflowLabel={overflowLabel}
          removeLabel={removeLabel}
        >
          {readOnly ? null : (
            <input
              aria-describedby={ariaDescribedBy}
              aria-invalid={invalidState || undefined}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              autoComplete="off"
              autoFocus={autoFocus}
              className="rx-select-input"
              disabled={disabled || full}
              enterKeyHint="enter"
              id={id}
              onBlur={onBlur}
              onChange={(event) => {
                const text = event.target.value;
                setDraftInvalid(false);
                // 输入法直接上屏的逗号（不经过 keydown）也要切分。
                if (SEPARATORS.test(text)) {
                  const parts = text.split(SEPARATORS);
                  const tail = parts.pop() ?? '';
                  const rejected = add(parts);
                  setDraft([...rejected, tail].filter(Boolean).join(', '));
                  setDraftInvalid(rejected.length > 0);
                  return;
                }
                setDraft(text);
              }}
              onFocus={onFocus}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={value.length === 0 ? placeholder : undefined}
              ref={mergeRefs(ref, inputRef)}
              spellCheck={false}
              type="text"
              value={draft}
            />
          )}
        </ChipList>
      </div>
      {name !== undefined
        ? value.map((tag) => <input key={tag} name={name} type="hidden" value={tag} />)
        : null}
    </div>
  );
});
