import type { ReactNode } from 'react';

/** 一个可选项（规范 03 §3.5）。 */
export interface SelectOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
  /**
   * 纯文本形式的标签：用于搜索过滤、键盘直达、胶囊 Tooltip。
   * `label` 是字符串时可省略；`label` 是元素时应当提供，否则无法按文字搜索。
   */
  textValue?: string;
  /** 仅 MultiSelect：锁定项的胶囊不显示 ×，「清空」也不会移除它。 */
  locked?: boolean;
}

/**
 * 分组：`options` 数组里可以混入 `{ type: 'group', label, options }`，
 * 组标题不可选（规范 03 §3.5「分组标题 12 text-tertiary 不可选」）。只支持一层分组。
 */
export interface SelectOptionGroup<Value extends string = string> {
  type: 'group';
  /** 同一列表里组标题重复时用于区分，默认取 label 文本。 */
  key?: string;
  label: ReactNode;
  options: readonly SelectOption<Value>[];
}

export type SelectItem<Value extends string = string> =
  | SelectOption<Value>
  | SelectOptionGroup<Value>;

export type SelectCursor = number | string;

export interface LoadOptionsParams {
  /** 当前搜索词（已去掉首尾空白）。 */
  query: string;
  /** 第一页为 undefined；之后是上一页返回的 nextCursor。 */
  cursor: SelectCursor | undefined;
  /** 新的搜索或关闭面板时会取消上一个请求。 */
  signal: AbortSignal;
}

export interface LoadOptionsResult<Value extends string = string> {
  items: readonly SelectItem<Value>[];
  /** 还有下一页时返回游标；null / undefined 表示已到底。 */
  nextCursor?: SelectCursor | null;
}

/** 远程分页数据源（规范 03 §3.5「远程分页」）。每页条数由调用方决定（建议 20）。 */
export type LoadOptions<Value extends string = string> = (
  params: LoadOptionsParams,
) => Promise<LoadOptionsResult<Value>>;

/** 本地过滤函数；默认按标签文本包含匹配（不区分大小写）。可用于拼音、编码匹配。 */
export type FilterOption<Value extends string = string> = (
  option: SelectOption<Value>,
  query: string,
) => boolean;

/** 面板底部状态行与空态的文案（规范 03 §3.5、05 §2）。全部由调用方传入。 */
export interface SelectStatusLabels {
  /** 查询未达到 minSearchLength 时的提示。 */
  minSearchLabel?: ReactNode;
  /** 翻过页且没有更多时显示，例如「已全部加载」。 */
  endLabel?: ReactNode;
  /** 远程加载失败，例如「加载失败」。 */
  errorLabel?: ReactNode;
  /** 无匹配结果，例如「无匹配结果」。 */
  emptyLabel?: ReactNode;
  /** 加载中，例如「加载中…」。 */
  loadingLabel?: ReactNode;
  /** 重试链接，例如「重试」。 */
  retryLabel?: ReactNode;
}

export interface SelectCreateProps {
  /** 无结果时提供「创建“××”」选项。 */
  creatable?: boolean;
  /** 创建项的文案，例如 `(query) => \`创建“${query}”\``。 */
  createLabel?: (query: string) => ReactNode;
  onCreate?: (query: string) => void;
}

/** Select / MultiSelect 共享的数据源属性。 */
export interface SelectSourceProps<Value extends string = string>
  extends SelectStatusLabels, SelectCreateProps {
  filterOption?: FilterOption<Value>;
  loadOptions?: LoadOptions<Value>;
  /** 本地数据；远程模式下可省略。 */
  options?: readonly SelectItem<Value>[];
  /** 已选值不在已加载页里时，用它换取标签（规范：触发器上不得显示裸 ID）。 */
  resolveOptions?: (values: Value[]) => Promise<readonly SelectOption<Value>[]>;
  /** 搜索防抖，默认 300ms（规范 03 §3.5）。 */
  searchDebounceMs?: number;
  /** 远程搜索最少字符数（首尾去空白后），默认 0。 */
  minSearchLength?: number;
  /** 查询改变时立即移除旧页并取消请求，默认保留旧内容。 */
  resetOnQueryChange?: boolean;
  onSearchChange?: (query: string) => void;
  /** 搜索框的可读名称；不传时沿用组件的 aria-label。 */
  searchLabel?: string;
  searchPlaceholder?: string;
}

export type SelectSize = 'lg' | 'md' | 'sm' | 'xl';
