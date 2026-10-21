// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QuestionOption,
  QuestionOptionGroup,
  QuestionOutcome,
  questionOptionMarker,
  type QuestionOptionGroupProps,
  type QuestionOptionLabels,
  type QuestionOptionResult,
} from './QuestionOption';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zhLabels: QuestionOptionLabels = {
  correct: '正确',
  correctAnswer: '正确答案',
  incorrect: '错误',
  missed: '漏选',
};

const enLabels: QuestionOptionLabels = {
  correct: 'Correct',
  correctAnswer: 'Correct answer',
  incorrect: 'Incorrect',
  missed: 'Missed',
};

const OPTIONS = [
  { value: 'a', text: 'Gradient is parallel' },
  { value: 'b', text: 'Gradient is normal' },
  { value: 'c', text: 'Locked option', disabled: true },
  { value: 'd', text: 'No relation' },
];

function Question({
  optionResults = {},
  ...props
}: Partial<QuestionOptionGroupProps> & {
  optionResults?: Partial<Record<string, QuestionOptionResult>>;
}) {
  return (
    <>
      <p id="stem">Which statement is true?</p>
      <QuestionOptionGroup aria-labelledby="stem" labels={enLabels} {...props}>
        {OPTIONS.map((option, index) => (
          <QuestionOption
            disabled={option.disabled}
            key={option.value}
            marker={questionOptionMarker(index)}
            result={optionResults[option.value]}
            value={option.value}
          >
            <span>
              {option.text} <strong>∇f</strong>
            </span>
          </QuestionOption>
        ))}
      </QuestionOptionGroup>
    </>
  );
}

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }),
    );
  });
}

describe('QuestionOption interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const inputs = () => Array.from(container.querySelectorAll<HTMLInputElement>('input'));
  const input = (value: string) => inputs().find((item) => item.value === value)!;
  const row = (value: string) => input(value).closest<HTMLElement>('.rx-question-option')!;
  const accessibleName = (element: HTMLElement) =>
    (element.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const description = (element: HTMLElement) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

  it('exposes a labelled radio group with marker, rich text and 20px radios', () => {
    act(() => root.render(<Question />));
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('stem');
    expect(group.classList.contains('rx-question-option-group')).toBe(true);
    expect(inputs().every((item) => item.type === 'radio')).toBe(true);
    expect(new Set(inputs().map((item) => item.name)).size).toBe(1);
    expect(accessibleName(input('a'))).toBe('A Gradient is parallel ∇f');
    expect(row('a').querySelector('strong')?.textContent).toBe('∇f');
    expect(row('a').querySelector('.rx-radio')?.getAttribute('data-size')).toBe('lg');
    expect(row('a').getAttribute('data-state')).toBe('unchecked');
    expect(row('a').hasAttribute('data-result')).toBe(false);
    expect(container.querySelector('.rx-question-option-result')).toBeNull();
  });

  it('selects a single answer by clicking anywhere on the row (uncontrolled)', () => {
    const onChange = vi.fn();
    act(() => root.render(<Question defaultValue={['a']} onChange={onChange} />));
    expect(row('a').getAttribute('data-state')).toBe('checked');
    act(() => row('b').querySelector<HTMLElement>('.rx-question-option-content')!.click());
    expect(onChange).toHaveBeenLastCalledWith(['b']);
    expect(input('b').checked).toBe(true);
    expect(row('b').getAttribute('data-state')).toBe('checked');
    expect(row('a').getAttribute('data-state')).toBe('unchecked');
  });

  it('only reports changes in controlled mode until the parent updates', () => {
    const onChange = vi.fn();
    act(() => root.render(<Question onChange={onChange} value={['a']} />));
    act(() => input('d').click());
    expect(onChange).toHaveBeenCalledWith(['d']);
    expect(input('a').checked).toBe(true);
    expect(row('d').getAttribute('data-state')).toBe('unchecked');
  });

  it('follows the APG radio group keyboard model, skipping disabled options', () => {
    const onChange = vi.fn();
    act(() => root.render(<Question onChange={onChange} />));
    expect(inputs().map((item) => item.tabIndex)).toEqual([0, -1, -1, -1]);
    act(() => input('a').focus());
    key(input('a'), 'ArrowDown');
    expect(document.activeElement).toBe(input('b'));
    key(input('b'), 'ArrowDown');
    expect(document.activeElement).toBe(input('d'));
    key(input('d'), 'ArrowRight');
    expect(document.activeElement).toBe(input('a'));
    key(input('a'), 'ArrowUp');
    expect(document.activeElement).toBe(input('d'));
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([['b'], ['d'], ['a'], ['d']]);
    expect(inputs().map((item) => item.tabIndex)).toEqual([-1, -1, -1, 0]);
  });

  it('keeps disabled options unselectable and supports disabling the whole group', () => {
    const onChange = vi.fn();
    act(() => root.render(<Question onChange={onChange} />));
    expect(input('c').disabled).toBe(true);
    expect(row('c').hasAttribute('data-disabled')).toBe(true);
    act(() => row('c').querySelector<HTMLElement>('.rx-question-option-content')!.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(row('c').getAttribute('data-state')).toBe('unchecked');

    act(() => root.render(<Question disabled onChange={onChange} />));
    expect(inputs().every((item) => item.disabled)).toBe(true);
    act(() => input('a').click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('toggles multiple answers as checkboxes and reports them in option order', () => {
    function Controlled() {
      const [value, setValue] = useState<string[]>([]);
      return (
        <>
          <Question multiple onChange={setValue} value={value} />
          <output>{value.join(',')}</output>
        </>
      );
    }
    act(() => root.render(<Controlled />));
    const group = container.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('stem');
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(inputs().every((item) => item.type === 'checkbox')).toBe(true);
    // 多选每项都可 Tab 聚焦（空格切换由原生 checkbox 提供）。
    expect(inputs().every((item) => item.tabIndex === 0)).toBe(true);
    expect(row('a').querySelector('.rx-checkbox')?.getAttribute('data-size')).toBe('lg');

    act(() => input('d').click());
    act(() => row('a').querySelector<HTMLElement>('.rx-question-option-content')!.click());
    expect(container.querySelector('output')!.textContent).toBe('a,d');
    expect(row('a').getAttribute('data-state')).toBe('checked');
    expect(row('d').getAttribute('data-state')).toBe('checked');
    act(() => input('a').click());
    expect(container.querySelector('output')!.textContent).toBe('d');
    act(() => input('c').click());
    expect(container.querySelector('output')!.textContent).toBe('d');
  });

  it('renders graded single-choice results with icons, caller labels and descriptions', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Question
          onChange={onChange}
          readOnly
          optionResults={{ a: 'incorrect', b: 'missed' }}
          value={['a']}
        />,
      ),
    );
    expect(row('a').getAttribute('data-result')).toBe('incorrect');
    expect(row('a').getAttribute('data-state')).toBe('checked');
    expect(row('b').getAttribute('data-result')).toBe('missed');
    expect(row('d').hasAttribute('data-result')).toBe(false);
    expect(description(input('a'))).toBe('Incorrect');
    // 单选的未选正确答案显示「正确答案」而不是「漏选」。
    expect(description(input('b'))).toBe('Correct answer');
    expect(input('d').hasAttribute('aria-describedby')).toBe(false);
    for (const tag of container.querySelectorAll('.rx-question-option-result')) {
      expect(tag.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }

    // 判分后只读：不可再改，但仍可聚焦与读屏。
    expect(inputs().every((item) => item.getAttribute('aria-readonly') === 'true')).toBe(true);
    expect(row('a').hasAttribute('data-readonly')).toBe(true);
    act(() => input('d').click());
    expect(onChange).not.toHaveBeenCalled();
    expect(input('a').checked).toBe(true);
    expect(input('d').disabled).toBe(false);
  });

  it('marks multiple-choice correct, incorrect and missed options', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Question
          labels={zhLabels}
          multiple
          onChange={onChange}
          readOnly
          optionResults={{ a: 'correct', b: 'missed', d: 'incorrect' }}
          value={['a', 'd']}
        />,
      ),
    );
    expect(row('a').getAttribute('data-result')).toBe('correct');
    expect(description(input('a'))).toBe('正确');
    expect(description(input('b'))).toBe('漏选');
    expect(description(input('d'))).toBe('错误');
    expect(row('b').getAttribute('data-state')).toBe('unchecked');
    act(() => input('b').click());
    expect(onChange).not.toHaveBeenCalled();
    expect(input('b').checked).toBe(false);
  });

  it('takes every visible label from the caller in both locales', () => {
    const optionResults = { a: 'correct', b: 'incorrect', d: 'missed' } as const;
    act(() =>
      root.render(<Question multiple readOnly optionResults={optionResults} value={['a', 'b']} />),
    );
    const tags = () =>
      Array.from(container.querySelectorAll('.rx-question-option-result')).map(
        (tag) => tag.textContent,
      );
    expect(tags()).toEqual(['Correct', 'Incorrect', 'Missed']);
    act(() =>
      root.render(
        <Question
          labels={zhLabels}
          multiple
          readOnly
          optionResults={optionResults}
          value={['a', 'b']}
        />,
      ),
    );
    expect(tags()).toEqual(['正确', '错误', '漏选']);
  });

  it('announces the question outcome, including partially correct answers', () => {
    act(() =>
      root.render(
        <QuestionOutcome description="2 / 4" outcome="partial">
          部分正确
        </QuestionOutcome>,
      ),
    );
    const status = container.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute('data-outcome')).toBe('partial');
    expect(status.textContent).toBe('部分正确2 / 4');
    expect(status.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    act(() => root.render(<QuestionOutcome outcome="correct">Correct</QuestionOutcome>));
    expect(container.querySelector('[data-outcome="correct"]')?.textContent).toBe('Correct');
  });

  it('requires a QuestionOptionGroup', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      act(() =>
        root.render(
          <QuestionOption marker="A" value="a">
            Alone
          </QuestionOption>,
        ),
      ),
    ).toThrow(/QuestionOptionGroup/);
    error.mockRestore();
  });
});

describe('questionOptionMarker', () => {
  it('produces spreadsheet-style letters', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(questionOptionMarker)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
  });
});
