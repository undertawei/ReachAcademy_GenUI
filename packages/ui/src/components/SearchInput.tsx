'use client';

import { Search } from 'lucide-react';
import { forwardRef, useEffect, useRef, type CompositionEvent, type KeyboardEvent } from 'react';

import { cn } from '../cn';
import { Input, setNativeInputValue, type InputProps } from './Input';
import { Spinner } from './Spinner';

/** 规范 03 §3.2：输入防抖 300ms。 */
export const SEARCH_DEBOUNCE_MS = 300;

export type SearchInputProps = Omit<InputProps, 'clearable' | 'prefix' | 'type'> & {
  /** 清除按钮的可读名称；提供时有值即可清除。 */
  clearLabel?: string;
  /** 防抖时长，默认 300ms。 */
  debounceMs?: number;
  /** 搜索进行中：右侧显示小 Spinner，输入框 aria-busy。 */
  loading?: boolean;
  /** 触发搜索：输入停顿 300ms、回车立即、Esc/清除时以空串立即触发。 */
  onSearch?: (query: string) => void;
};

/** 搜索框（规范 03 §3.2）：高 36、圆角 lg、左侧搜索图标。 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  {
    className,
    clearLabel,
    debounceMs = SEARCH_DEBOUNCE_MS,
    loading = false,
    onClear,
    onCompositionEnd,
    onCompositionStart,
    onKeyDown,
    onSearch,
    onValueChange,
    size,
    suffix,
    ...props
  },
  ref,
) {
  const timer = useRef<number | undefined>(undefined);
  const composing = useRef(false);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const cancel = () => window.clearTimeout(timer.current);
  const searchNow = (query: string) => {
    cancel();
    onSearchRef.current?.(query);
  };
  const schedule = (query: string) => {
    cancel();
    timer.current = window.setTimeout(() => onSearchRef.current?.(query), debounceMs);
  };

  const handleValueChange = (next: string) => {
    onValueChange?.(next);
    // 输入法组字过程中不搜索，组字结束（compositionend）再排期。
    if (!composing.current) schedule(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || composing.current) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      searchNow(event.currentTarget.value);
      return;
    }
    // 有内容时 Esc 清空（并阻止外层弹窗把它当作关闭）；已为空时放行给外层。
    if (event.key === 'Escape' && event.currentTarget.value !== '') {
      event.preventDefault();
      setNativeInputValue(event.currentTarget, '');
      searchNow('');
    }
  };

  return (
    <Input
      aria-busy={loading || undefined}
      className={cn('rx-search-input', className)}
      clearLabel={clearLabel}
      clearable={clearLabel !== undefined}
      enterKeyHint="search"
      onClear={() => {
        searchNow('');
        onClear?.();
      }}
      onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
        composing.current = false;
        onCompositionEnd?.(event);
        schedule(event.currentTarget.value);
      }}
      onCompositionStart={(event: CompositionEvent<HTMLInputElement>) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onKeyDown={handleKeyDown}
      onValueChange={handleValueChange}
      prefix={<Search aria-hidden="true" />}
      ref={ref}
      size={size}
      suffix={
        loading ? (
          <>
            {suffix}
            <Spinner className="rx-search-input-spinner" size="sm" />
          </>
        ) : (
          suffix
        )
      }
      type="search"
      {...props}
    />
  );
});
