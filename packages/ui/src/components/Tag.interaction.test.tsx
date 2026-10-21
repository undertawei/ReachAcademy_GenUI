// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Badge, CountBadge, Dot, MetaTag, Ribbon, StatusPill, Tag } from './Tag';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Tag family', () => {
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

  it('renders read-only tags with tones and no interactive semantics', () => {
    act(() => {
      root.render(
        <>
          <MetaTag>High school</MetaTag>
          <Tag tone="purple">SRL</Tag>
          <Tag>Default</Tag>
          <StatusPill bordered size="md" tone="pending">
            Waiting for teacher
          </StatusPill>
          <StatusPill>Neutral</StatusPill>
          <Badge tone="warning">Unsaved</Badge>
          <Ribbon>Published</Ribbon>
        </>,
      );
    });
    const [meta, tag, neutralTag, pill, neutralPill, badge, ribbon] = Array.from(
      container.children,
    ) as HTMLElement[];
    expect(meta?.className).toContain('rx-meta-tag');
    expect(tag?.dataset.tone).toBe('purple');
    expect(neutralTag?.dataset.tone).toBe('neutral');
    expect(pill?.dataset.tone).toBe('pending');
    expect(pill?.dataset.size).toBe('md');
    expect(pill?.dataset.bordered).toBe('true');
    expect(neutralPill?.hasAttribute('data-size')).toBe(false);
    expect(neutralPill?.dataset.tone).toBe('neutral');
    expect(badge?.dataset.tone).toBe('warning');
    expect(ribbon?.dataset.tone).toBe('published');
    expect(container.querySelector('button, a, [tabindex]')).toBeNull();
    expect(container.querySelector('[role]')).toBeNull();
  });

  it('truncates long tag text inside a label span', () => {
    const long = 'A very long category name '.repeat(10);
    act(() => root.render(<Tag>{long}</Tag>));
    expect(container.querySelector('.rx-tag-label')?.textContent).toBe(long);
  });

  it('hides decorative dots and announces labelled ones', () => {
    act(() => {
      root.render(
        <>
          <Dot />
          <Dot label="Unread notifications" />
        </>,
      );
    });
    const [decorative, labelled] = Array.from(container.children) as HTMLElement[];
    expect(decorative?.getAttribute('aria-hidden')).toBe('true');
    expect(labelled?.hasAttribute('aria-hidden')).toBe(false);
    expect(labelled?.textContent).toBe('Unread notifications');
  });

  it('caps counts, hides zero by default and uses the label template', () => {
    act(() => {
      root.render(
        <>
          <CountBadge count={0} />
          <CountBadge count={10} />
          <CountBadge count={250} formatLabel={(count) => `${count} unread`} />
          <CountBadge count={0} showZero />
        </>,
      );
    });
    const badges = Array.from(container.querySelectorAll('.rx-count-badge'));
    expect(badges).toHaveLength(3);
    expect(badges[0]?.textContent).toBe('10');
    expect(badges[1]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('99+');
    expect(badges[1]?.querySelector('.rx-visually-hidden')?.textContent).toBe('250 unread');
    expect(badges[2]?.textContent).toBe('0');
  });
});
