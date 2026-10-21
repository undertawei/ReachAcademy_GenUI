'use client';

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

import { cn } from '../cn';

export type AvatarSize = 'lg' | 'md' | 'sm' | 'xl';

/** 按种子（用户 ID）稳定地从轨道分类色 1–4 中取一个（规范 01 §10、03 §3.33）。 */
export function avatarCategory(seed: string): 1 | 2 | 3 | 4 {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) >>> 0;
  }
  return ((hash % 4) + 1) as 1 | 2 | 3 | 4;
}

/** 姓名首字（按字素取，兼容中文与表情），拉丁字母转大写。 */
export function avatarInitial(name: string): string {
  const [first] = Array.from(name.trim());
  return first ? first.toLocaleUpperCase() : '';
}

export type AvatarProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** 图片替代文字；默认用 `name`。装饰性头像（旁边已有姓名）传 `decorative`。 */
  alt?: string;
  /** 旁边已显示姓名时设为 true，头像对读屏隐藏。 */
  decorative?: boolean;
  /** 用户姓名：用于首字兜底与可读名称。 */
  name: string;
  /** 取底色的种子，一般是用户 ID；默认用 `name`。 */
  seed?: string;
  /** 24 / 34（默认）/ 40 / 56（`xl`，头像下方带姓名的成员展示）。 */
  size?: AvatarSize;
  src?: string | null;
};

/** 头像（规范 03 §3.33）：圆形；无图或加载失败时显示姓名首字 + 分类色底白字。 */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { alt, className, decorative = false, name, seed, size, src, ...props },
  ref,
) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;
  const label = alt ?? name;

  return (
    <span
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={decorative || showImage ? undefined : label}
      className={cn('rx-avatar', className)}
      data-category={showImage ? undefined : String(avatarCategory(seed ?? name))}
      data-size={size}
      ref={ref}
      role={decorative || showImage ? undefined : 'img'}
      {...props}
    >
      {showImage ? (
        <img
          alt={decorative ? '' : label}
          className="rx-avatar-image"
          draggable={false}
          onError={() => setFailedSrc(src ?? null)}
          src={src ?? undefined}
        />
      ) : (
        <span aria-hidden="true" className="rx-avatar-initial">
          {avatarInitial(name)}
        </span>
      )}
    </span>
  );
});

export type AvatarGroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children: ReactNode;
  /** 最多显示几个头像，其余收成 `+N`。默认 4。 */
  max?: number;
  /** `+N` 的读屏文字，例如 `(n) => \`还有 ${n} 人\``。 */
  overflowLabel?: (count: number) => string;
  /** 统一尺寸（子头像未单独指定时生效）。 */
  size?: AvatarSize;
};

/** 头像组：每个向左叠放 25%，最多显示 `max` 个 + `+N`。 */
export const AvatarGroup = forwardRef<HTMLDivElement, AvatarGroupProps>(function AvatarGroup(
  { children, className, max = 4, overflowLabel, size, ...props },
  ref,
) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<AvatarProps>[];
  const limit = Math.max(1, Math.floor(max));
  const visible = items.length > limit ? items.slice(0, limit) : items;
  const hidden = items.length - visible.length;
  return (
    <div className={cn('rx-avatar-group', className)} data-size={size} ref={ref} {...props}>
      {visible.map((item) =>
        size && item.props.size === undefined ? cloneElement(item, { size }) : item,
      )}
      {hidden > 0 ? (
        <span
          aria-label={overflowLabel?.(hidden)}
          className="rx-avatar rx-avatar-overflow rx-numeric"
          data-size={size}
          role={overflowLabel ? 'img' : undefined}
        >
          <span aria-hidden={overflowLabel ? 'true' : undefined}>{`+${hidden}`}</span>
        </span>
      ) : null}
    </div>
  );
});
