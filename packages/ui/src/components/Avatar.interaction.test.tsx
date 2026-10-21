// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Avatar, avatarCategory, avatarInitial, AvatarGroup } from './Avatar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('avatar helpers', () => {
  it('picks a stable category 1–4 from the seed', () => {
    const seeds = ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6', 'u-7', 'u-8'];
    const categories = seeds.map(avatarCategory);
    expect(categories.every((value) => value >= 1 && value <= 4)).toBe(true);
    expect(seeds.map(avatarCategory)).toEqual(categories);
    expect(new Set(categories).size).toBeGreaterThan(1);
  });

  it('takes the first grapheme of the name', () => {
    expect(avatarInitial('  ada lovelace')).toBe('A');
    expect(avatarInitial('王小明')).toBe('王');
    expect(avatarInitial('😀 Smile')).toBe('😀');
    expect(avatarInitial('')).toBe('');
  });
});

describe('Avatar interactions', () => {
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

  it('offers an extra large size for members shown with their name underneath', () => {
    act(() => root.render(<Avatar decorative name="陈一鸣" size="xl" />));
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.dataset.size).toBe('xl');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the image with alt text and falls back to the initial when it fails', () => {
    act(() => root.render(<Avatar name="Grace Hopper" seed="user-7" size="lg" src="/g.png" />));
    const avatar = container.firstElementChild as HTMLElement;
    const image = avatar.querySelector('img')!;
    expect(image.getAttribute('alt')).toBe('Grace Hopper');
    expect(avatar.dataset.size).toBe('lg');
    expect(avatar.hasAttribute('data-category')).toBe(false);

    act(() => {
      image.dispatchEvent(new Event('error'));
    });
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('Grace Hopper');
    expect(avatar.textContent).toBe('G');
    expect(avatar.dataset.category).toBe(String(avatarCategory('user-7')));

    // 换一张图后重新尝试加载。
    act(() => root.render(<Avatar name="Grace Hopper" seed="user-7" src="/g2.png" />));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/g2.png');
  });

  it('hides decorative avatars from assistive technology', () => {
    act(() => root.render(<Avatar decorative name="Ada" />));
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.hasAttribute('role')).toBe(false);
    expect(avatar.hasAttribute('data-size')).toBe(false);
  });

  it('shows at most four avatars plus an overflow count', () => {
    act(() => {
      root.render(
        <AvatarGroup overflowLabel={(count) => `${count} more`} size="sm">
          {['A', 'B', 'C', 'D', 'E', 'F'].map((name) => (
            <Avatar key={name} name={name} />
          ))}
        </AvatarGroup>,
      );
    });
    const avatars = container.querySelectorAll('.rx-avatar');
    expect(avatars).toHaveLength(5);
    expect(Array.from(avatars).every((node) => node.getAttribute('data-size') === 'sm')).toBe(true);
    const overflow = container.querySelector('.rx-avatar-overflow')!;
    expect(overflow.textContent).toBe('+2');
    expect(overflow.getAttribute('aria-label')).toBe('2 more');

    act(() => {
      root.render(
        <AvatarGroup>
          <Avatar name="A" />
          <Avatar name="B" />
        </AvatarGroup>,
      );
    });
    expect(container.querySelector('.rx-avatar-overflow')).toBeNull();
  });
});
