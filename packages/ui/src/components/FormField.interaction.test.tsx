// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FormField, FormGrid, FormSection, useFormFieldControl } from './FormField';
import { Input, setNativeInputValue } from './Input';
import { NumberInput } from './NumberInput';
import { PasswordInput } from './PasswordInput';
import { SearchInput } from './SearchInput';
import { Textarea } from './Textarea';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

function render(node: ReactNode) {
  act(() => root.render(node));
}

function label() {
  return container.querySelector<HTMLLabelElement>('label')!;
}

function describedText(element: Element) {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent);
}

describe('FormField', () => {
  it('associates label, help text and required state with a shared Input', () => {
    render(
      <FormField help="Up to 40 characters" label="Course name" required>
        <Input />
      </FormField>,
    );
    const input = container.querySelector('input')!;
    expect(label().htmlFor).toBe(input.id);
    expect(input.id).not.toBe('');
    expect(label().textContent).toBe('Course name*');
    expect(label().querySelector('.rx-form-field-required')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.hasAttribute('required')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(describedText(input)).toEqual(['Up to 40 characters']);
  });

  it('replaces help with the error, marks the control invalid, and removes it when fixed', () => {
    function Field() {
      const [error, setError] = useState<string | undefined>('Name is required');
      return (
        <FormField error={error} help="Help" label="Name">
          <Input onValueChange={(value) => setError(value ? undefined : 'Name is required')} />
        </FormField>
      );
    }
    render(<Field />);
    const input = container.querySelector('input')!;
    expect(container.querySelector('.rx-form-field-help')).toBeNull();
    const error = container.querySelector('.rx-form-field-error')!;
    expect(error.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(describedText(input)).toEqual(['Name is required']);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('.rx-input')!.getAttribute('data-invalid')).toBe('true');

    act(() => setNativeInputValue(input, 'Ada'));
    expect(container.querySelector('.rx-form-field-error')).toBeNull();
    expect(describedText(input)).toEqual(['Help']);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('merges the control’s own descriptions and honours a caller-provided id', () => {
    render(
      <>
        <p id="extra">Extra</p>
        <FormField help="Help" htmlFor="fixed-id" label="Email">
          <Input aria-describedby="extra" />
        </FormField>
      </>,
    );
    const input = container.querySelector('input')!;
    expect(input.id).toBe('fixed-id');
    expect(label().htmlFor).toBe('fixed-id');
    expect(describedText(input)).toEqual(['Extra', 'Help']);
  });

  it('wires every shared field control and propagates disabled', () => {
    const controls: [string, ReactNode, string][] = [
      ['textarea', <Textarea key="t" />, 'textarea'],
      [
        'number',
        <NumberInput decrementLabel="Down" incrementLabel="Up" key="n" unit="min" />,
        'input',
      ],
      ['search', <SearchInput key="s" />, 'input'],
      ['password', <PasswordInput hideLabel="Hide" key="p" showLabel="Show" />, 'input'],
    ];
    for (const [name, control, selector] of controls) {
      render(
        <FormField disabled error="Wrong" label={name} required>
          {control}
        </FormField>,
      );
      const element = container.querySelector<HTMLInputElement>(selector)!;
      expect(label().htmlFor, name).toBe(element.id);
      expect(element.getAttribute('aria-invalid'), name).toBe('true');
      expect(element.getAttribute('aria-required'), name).toBe('true');
      expect(element.disabled, name).toBe(true);
      expect(describedText(element), name).toContain('Wrong');
    }
  });

  it('passes control props to a render function for native elements', () => {
    render(
      <FormField error="Pick one" label="Native">
        {(control) => (
          <input
            aria-describedby={control['aria-describedby']}
            aria-invalid={control['aria-invalid']}
            id={control.id}
          />
        )}
      </FormField>,
    );
    const input = container.querySelector('input')!;
    expect(label().htmlFor).toBe(input.id);
    expect(describedText(input)).toEqual(['Pick one']);
  });

  it('exposes labelId through useFormFieldControl for group-like controls', () => {
    function Group() {
      const control = useFormFieldControl();
      return <div aria-labelledby={control.labelId} role="radiogroup" />;
    }
    render(
      <FormField label="Grade">
        <Group />
      </FormField>,
    );
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)).toBe(label());

    function Outside() {
      const control = useFormFieldControl({ id: 'own', invalid: true });
      return <output>{JSON.stringify(control)}</output>;
    }
    render(<Outside />);
    const outside = JSON.parse(container.querySelector('output')!.textContent!);
    expect(outside).toMatchObject({ disabled: false, id: 'own', inField: false, invalid: true });
  });

  it('supports a visually hidden label and omits empty help/error', () => {
    render(
      <FormField error="" help={null} label="Filter" labelHidden>
        <Input />
      </FormField>,
    );
    expect(label().classList.contains('rx-visually-hidden')).toBe(true);
    expect(container.querySelector('p')).toBeNull();
    expect(container.querySelector('input')!.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('FormGrid and FormSection', () => {
  it('renders a labelled group with a subtitle heading and a two-column grid', () => {
    render(
      <FormSection className="layout" description="Basics" headingLevel={4} title="Course info">
        <FormGrid>
          <FormField label="Stage">
            <Input />
          </FormField>
          <FormField label="Subject">
            <Input />
          </FormField>
        </FormGrid>
      </FormSection>,
    );
    const section = container.querySelector<HTMLElement>('.rx-form-section')!;
    expect(section.getAttribute('role')).toBe('group');
    expect(section.classList.contains('layout')).toBe(true);
    const heading = section.querySelector('h4')!;
    expect(heading.textContent).toBe('Course info');
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(section.querySelector('.rx-form-grid')!.children).toHaveLength(2);
  });
});
