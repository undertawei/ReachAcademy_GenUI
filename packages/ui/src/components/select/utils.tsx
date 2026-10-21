import { Fragment, type ReactNode } from 'react';

import type { FilterOption, SelectItem, SelectOption, SelectOptionGroup } from './types';

export function isGroup<Value extends string>(
  item: SelectItem<Value>,
): item is SelectOptionGroup<Value> {
  return (item as SelectOptionGroup<Value>).type === 'group';
}

/** 选项的纯文本：优先 textValue，其次字符串/数字标签。 */
export function optionText(option: { label: ReactNode; textValue?: string }): string {
  if (option.textValue !== undefined) return option.textValue;
  if (typeof option.label === 'string' || typeof option.label === 'number') {
    return String(option.label);
  }
  return '';
}

export const defaultFilterOption: FilterOption = (option, query) =>
  optionText(option).toLocaleLowerCase().includes(query.toLocaleLowerCase());

export type SelectRow<Value extends string = string> =
  | { kind: 'group'; key: string; label: ReactNode }
  | { kind: 'option'; key: string; option: SelectOption<Value> }
  | { kind: 'create'; key: string; query: string }
  | { kind: 'select-all'; key: string };

const OPTION_ROW_PREFIX = 'option:';

export function optionRowKey(value: string): string {
  return `${OPTION_ROW_PREFIX}${value}`;
}

/** 把（可能分组的）选项展平成行，同时应用本地过滤。空分组不输出。 */
export function flattenItems<Value extends string>(
  items: readonly SelectItem<Value>[],
  filter?: (option: SelectOption<Value>) => boolean,
): SelectRow<Value>[] {
  const rows: SelectRow<Value>[] = [];
  const seen = new Set<string>();
  const pushOption = (option: SelectOption<Value>) => {
    if (seen.has(option.value)) return;
    if (filter && !filter(option)) return;
    seen.add(option.value);
    rows.push({ kind: 'option', key: optionRowKey(option.value), option });
  };
  items.forEach((item, index) => {
    if (!isGroup(item)) {
      pushOption(item);
      return;
    }
    const before = rows.length;
    const groupKey = `group:${item.key ?? (optionText({ label: item.label }) || index)}:${index}`;
    rows.push({ kind: 'group', key: groupKey, label: item.label });
    item.options.forEach(pushOption);
    if (rows.length === before + 1) rows.pop();
  });
  return rows;
}

/** 收集所有选项（含分组内），用于已选标签查找。 */
export function collectOptions<Value extends string>(
  items: readonly SelectItem<Value>[],
  into: Map<Value, SelectOption<Value>>,
): Map<Value, SelectOption<Value>> {
  for (const item of items) {
    if (isGroup(item)) item.options.forEach((option) => into.set(option.value, option));
    else into.set(item.value, item);
  }
  return into;
}

/** 搜索命中文字用 primary 高亮（规范 03 §3.5）。只处理字符串标签。 */
export function highlight(label: ReactNode, query: string): ReactNode {
  const needle = query.trim();
  if (needle === '' || typeof label !== 'string') return label;
  const haystack = label.toLocaleLowerCase();
  const lowered = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = haystack.indexOf(lowered, cursor);
  if (index < 0) return label;
  while (index >= 0) {
    if (index > cursor) parts.push(label.slice(cursor, index));
    parts.push(
      <mark className="rx-select-hit" key={index}>
        {label.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = haystack.indexOf(lowered, cursor);
  }
  if (cursor < label.length) parts.push(label.slice(cursor));
  return <Fragment>{parts}</Fragment>;
}

/**
 * 行的 DOM id。选项沿用第一期的 `${listboxId}-option-${encodeURIComponent(value)}`：
 * 存量调用方（含测试）按 `aria-controls` + 该格式直接定位选项，不能改。
 */
export function optionDomId(listboxId: string, key: string): string {
  if (key.startsWith(OPTION_ROW_PREFIX)) {
    return `${listboxId}-option-${encodeURIComponent(key.slice(OPTION_ROW_PREFIX.length))}`;
  }
  return `${listboxId}-${encodeURIComponent(key).replace(/%/g, '_')}`;
}
