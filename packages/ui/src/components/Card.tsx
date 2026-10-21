import { forwardRef, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';

export type CardPadding = 'lg' | 'md' | 'none' | 'sm';
export type CardRadius = 'card' | 'md';

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** 教师端卡片投影（`shadow-card`）。默认无阴影，只有 1px 描边。 */
  elevated?: boolean;
  /**
   * 可点击卡片：悬停抬起 2px + `shadow-raised`。整卡点击用卡内的 `CardOverlayLink`
   * （或给 Next `<Link>` 加 `cardOverlayLinkClassName`）实现，卡内其它按钮仍可独立点击。
   */
  interactive?: boolean;
  /** 内边距 12 / 16 / 20，默认 `md`；带 CardHeader 的面板通常配合默认值使用。 */
  padding?: CardPadding;
  /** 圆角：面板/区块 `card`（12，默认），列表卡片 `md`（8）。 */
  radius?: CardRadius;
};

/** 卡片（规范 03 §3.17）：`surface` 底、1px `border`、默认无阴影。 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { children, className, elevated, interactive, padding, radius, ...props },
  ref,
) {
  return (
    <div
      className={cn('rx-card', className)}
      data-elevated={elevated ? 'true' : undefined}
      data-interactive={interactive ? 'true' : undefined}
      data-padding={padding}
      data-radius={radius === 'md' ? 'md' : undefined}
      ref={ref}
      {...props}
    >
      {children}
    </div>
  );
});

export type CardHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** 标题右侧的操作区（按钮、DropdownMenu 触发器等）。 */
  actions?: ReactNode;
  description?: ReactNode;
  /** 标题元素层级，默认 h3。 */
  headingLevel?: 2 | 3 | 4;
  /** `sm`：紧凑卡片头（上下 12，左右 20），用于正文较长、需把高度让给内容的面板；默认 `md`（四边 20）。 */
  size?: 'md' | 'sm';
  title: ReactNode;
  /** `primary`：教师端区块标题（朱砂红 16/600，规范 01 §2.7）；默认 `text`。 */
  tone?: 'default' | 'primary';
};

/** 卡片头：标题 16/600 + 可选说明 + 右侧操作，内边距 20（`size="sm"` 上下 12），底部 1px 分割线。 */
export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
  {
    actions,
    className,
    description,
    headingLevel = 3,
    size = 'md',
    title,
    tone = 'default',
    ...props
  },
  ref,
) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cn('rx-card-header', className)}
      data-size={size === 'sm' ? 'sm' : undefined}
      data-tone={tone === 'primary' ? 'primary' : undefined}
      ref={ref}
      {...props}
    >
      <div className="rx-card-header-text">
        <Heading className="rx-card-title">{title}</Heading>
        {description === undefined || description === null ? null : (
          <p className="rx-card-description">{description}</p>
        )}
      </div>
      {actions === undefined || actions === null ? null : (
        <div className="rx-card-actions">{actions}</div>
      )}
    </div>
  );
});

export type CardBodyProps = HTMLAttributes<HTMLDivElement>;

/** 卡片主体：在 CardHeader 与 CardFooter 之间，承接卡片内边距。 */
export const CardBody = forwardRef<HTMLDivElement, CardBodyProps>(function CardBody(
  { className, ...props },
  ref,
) {
  return <div className={cn('rx-card-body', className)} ref={ref} {...props} />;
});

export type CardFooterProps = HTMLAttributes<HTMLDivElement>;

/** 卡片底部操作行：顶部 1px 分割线，操作右对齐。 */
export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(function CardFooter(
  { className, ...props },
  ref,
) {
  return <div className={cn('rx-card-footer', className)} ref={ref} {...props} />;
});

/** 给 Next `<Link>` 等自定义链接元素套用覆盖链接样式时使用。 */
export const cardOverlayLinkClassName = 'rx-card-overlay-link';

export type CardOverlayLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/**
 * 整卡点击的覆盖链接：伪元素铺满卡片，链接文字即可读名称（通常是卡片标题）。
 * 放在 `interactive` 卡片里；卡内其它按钮/链接叠在它上方，仍可独立点击。
 */
export const CardOverlayLink = forwardRef<HTMLAnchorElement, CardOverlayLinkProps>(
  function CardOverlayLink({ className, ...props }, ref) {
    return <a className={cn(cardOverlayLinkClassName, className)} ref={ref} {...props} />;
  },
);
