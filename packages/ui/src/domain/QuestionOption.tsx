'use client';

import { Check, CircleCheck, CircleMinus, CircleX, X } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { Checkbox, CheckboxGroup } from '../components/Checkbox';
import { Radio, RadioGroup } from '../components/Radio';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';

/**
 * 判分后单个选项的结果（规范 03 §3.8a）：
 * - `correct`：选中且正确；`incorrect`：选中但错误；
 * - `missed`：未选中的正确答案（单选显示「正确答案」，多选显示「漏选」）。
 * 与判分无关的选项不传，保持默认态。
 */
export type QuestionOptionResult = 'correct' | 'incorrect' | 'missed';

/** 整题判分结论，用于 `QuestionOutcome`；`partial` 为多选部分正确。 */
export type QuestionOutcomeKind = 'correct' | 'incorrect' | 'partial';

/** 判分标签文案，全部由调用方从各 app 的 i18n 目录传入（共享库不含任何语言字面量）。 */
export interface QuestionOptionLabels {
  /** 「正确」 */
  correct: string;
  /** 单选题中未选的正确答案：「正确答案」 */
  correctAnswer: string;
  /** 「错误」 */
  incorrect: string;
  /** 多选题中未选的正确答案：「漏选」 */
  missed: string;
}

type QuestionOptionContextValue = {
  labels: QuestionOptionLabels;
  multiple: boolean;
  readOnly: boolean;
  value: readonly string[];
};

const QuestionOptionContext = createContext<QuestionOptionContextValue | null>(null);

const EMPTY: readonly string[] = [];
const OPTION_ATTRIBUTE = 'data-rx-question-option';

/** 选项字母标记：0 → A，25 → Z，26 → AA（与语言无关，可直接作为 `marker`）。 */
export function questionOptionMarker(index: number): string {
  let rest = Math.max(0, Math.floor(index)) + 1;
  let marker = '';
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    marker = String.fromCharCode(65 + digit) + marker;
    rest = Math.floor((rest - 1) / 26);
  }
  return marker;
}

export type QuestionOptionGroupProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'defaultValue' | 'onChange'
> & {
  /** `QuestionOption` 子元素。 */
  children?: ReactNode;
  /** 非受控初始选中值。 */
  defaultValue?: readonly string[];
  disabled?: boolean;
  /** 判分标签文案（必填）。 */
  labels: QuestionOptionLabels;
  /** `true` 为多选题（Checkbox，`role="group"`），默认单选题（Radio，`role="radiogroup"`）。 */
  multiple?: boolean;
  /** 原生表单字段名；不传时单选自动生成。 */
  name?: string;
  /** 选中值变化（单选为单元素数组），多选按选项的 DOM 顺序排列。 */
  onChange?: (value: string[]) => void;
  /** 已提交或已判分：保留焦点与读屏，但不可再改。 */
  readOnly?: boolean;
  /** 受控选中值；单选只取第一项。 */
  value?: readonly string[];
};

/**
 * 学生答题选项组（规范 03 §3.8a、§4）。单选为 APG radio group（方向键移动并选中，Tab 只进出整组），
 * 多选为 checkbox group（Tab 逐项、空格切换）。用 `aria-labelledby` 关联题干。
 */
export const QuestionOptionGroup = forwardRef<HTMLDivElement, QuestionOptionGroupProps>(
  function QuestionOptionGroup(
    {
      children,
      className,
      defaultValue = EMPTY,
      disabled = false,
      labels,
      multiple = false,
      name,
      onChange,
      readOnly = false,
      value: valueProp,
      ...props
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [value, setValue] = useControllableState<readonly string[]>({
      defaultValue,
      onChange: (next) => onChange?.([...next]),
      value: valueProp,
    });
    const context: QuestionOptionContextValue = { labels, multiple, readOnly, value };
    const groupClassName = cn('rx-question-option-group', className);

    if (multiple) {
      const inDomOrder = (next: readonly string[]) => {
        const order = Array.from(
          rootRef.current?.querySelectorAll<HTMLInputElement>(`input[${OPTION_ATTRIBUTE}]`) ?? [],
        ).map((input) => input.value);
        return [
          ...order.filter((item) => next.includes(item)),
          ...next.filter((item) => !order.includes(item)),
        ];
      };
      return (
        <QuestionOptionContext.Provider value={context}>
          <CheckboxGroup
            {...props}
            className={groupClassName}
            disabled={disabled}
            name={name}
            onChange={(next) => setValue(inDomOrder(next))}
            readOnly={readOnly}
            ref={mergeRefs(ref, rootRef)}
            size="lg"
            value={value}
          >
            {children}
          </CheckboxGroup>
        </QuestionOptionContext.Provider>
      );
    }

    return (
      <QuestionOptionContext.Provider value={context}>
        <RadioGroup
          {...props}
          className={groupClassName}
          disabled={disabled}
          name={name}
          onChange={(next) => setValue([next])}
          readOnly={readOnly}
          ref={mergeRefs(ref, rootRef)}
          size="lg"
          value={value[0] ?? null}
        >
          {children}
        </RadioGroup>
      </QuestionOptionContext.Provider>
    );
  },
);

export type QuestionOptionProps = {
  /** 选项正文，可为富文本节点。 */
  children: ReactNode;
  /** 只用于外部布局。 */
  className?: string;
  disabled?: boolean;
  /** 选项标记（如 `questionOptionMarker(index)` 的「A」）；原样显示并计入可读名称。 */
  marker?: ReactNode;
  /** 判分结果；不传为未判分或与判分无关的选项。 */
  result?: QuestionOptionResult;
  value: string;
};

const RESULT_ICONS = {
  correct: Check,
  incorrect: X,
  missed: CircleCheck,
} as const;

/**
 * 单个答题选项：整行可点，内置 20px Radio（单选）或 Checkbox（多选）。
 * 判分结果同时以底色/描边、图标与文字标签表达，文字标签通过 `aria-describedby` 关联到选项。
 * 必须放在 `QuestionOptionGroup` 内；ref 指向内部的原生 input。
 */
export const QuestionOption = forwardRef<HTMLInputElement, QuestionOptionProps>(
  function QuestionOption({ children, className, disabled = false, marker, result, value }, ref) {
    const group = useContext(QuestionOptionContext);
    const resultId = `${useId()}-result`;
    if (!group) throw new Error('QuestionOption must be rendered inside QuestionOptionGroup.');
    const checked = group.value.includes(value);
    const hasMarker = marker !== undefined && marker !== null && marker !== false;

    let resultLabel: string | null = null;
    if (result === 'correct') resultLabel = group.labels.correct;
    else if (result === 'incorrect') resultLabel = group.labels.incorrect;
    else if (result === 'missed')
      resultLabel = group.multiple ? group.labels.missed : group.labels.correctAnswer;
    const ResultIcon = result ? RESULT_ICONS[result] : null;

    const label = (
      <>
        {hasMarker ? <span className="rx-question-option-marker">{marker}</span> : null}
        {/* 空格让可读名称读作「A 选项正文」；flex 容器内的纯空白文本不占视觉位置。 */}
        {hasMarker ? ' ' : null}
        <span className="rx-question-option-content">{children}</span>
      </>
    );
    const controlProps = {
      'aria-describedby': resultLabel ? resultId : undefined,
      className: 'rx-question-option-control',
      [OPTION_ATTRIBUTE]: '',
      disabled,
      label,
      ref,
      size: 'lg' as const,
      value,
    };

    return (
      <div
        className={cn('rx-question-option', className)}
        data-disabled={disabled ? '' : undefined}
        data-readonly={group.readOnly ? '' : undefined}
        data-result={result}
        data-state={checked ? 'checked' : 'unchecked'}
      >
        {group.multiple ? <Checkbox {...controlProps} /> : <Radio {...controlProps} />}
        {resultLabel && ResultIcon ? (
          <span className="rx-question-option-result" id={resultId}>
            <ResultIcon aria-hidden="true" strokeWidth={2} />
            {resultLabel}
          </span>
        ) : null}
      </div>
    );
  },
);

const OUTCOME_ICONS = {
  correct: CircleCheck,
  incorrect: CircleX,
  partial: CircleMinus,
} as const;

export type QuestionOutcomeProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 结论文字（「回答正确」「回答错误」「部分正确」），由调用方传入。 */
  children: ReactNode;
  /** 结论下方的补充说明（得分、正确答案摘要等）。 */
  description?: ReactNode;
  outcome: QuestionOutcomeKind;
};

/**
 * 整题判分结论（规范 03 §3.8a）：图标 + 文字，不只靠颜色；默认 `role="status"` 播报。
 * 多选「部分正确」用 `outcome="partial"`。
 */
export const QuestionOutcome = forwardRef<HTMLDivElement, QuestionOutcomeProps>(
  function QuestionOutcome({ children, className, description, outcome, role, ...props }, ref) {
    const Icon = OUTCOME_ICONS[outcome];
    const hasDescription = description !== undefined && description !== null;
    return (
      <div
        {...props}
        className={cn('rx-question-outcome', className)}
        data-outcome={outcome}
        ref={ref}
        role={role ?? 'status'}
      >
        <Icon aria-hidden="true" className="rx-question-outcome-icon" strokeWidth={1.5} />
        <div className="rx-question-outcome-content">
          <p className="rx-question-outcome-title">{children}</p>
          {hasDescription ? (
            <div className="rx-question-outcome-description">{description}</div>
          ) : null}
        </div>
      </div>
    );
  },
);
