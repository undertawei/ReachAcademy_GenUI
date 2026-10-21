'use client';

import { ArrowLeft } from 'lucide-react';
import {
  forwardRef,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { ScrollArea, type ScrollAreaProps } from './ScrollArea';

/**
 * 页面骨架积木（规范 02 §2–3）。组合方式：
 *
 *   <AppViewport header={<RoleHeader … />}>          ← 各 app 角色布局，body 不再滚动
 *     <PageLayout template="overview">                 ← 每个页面
 *       <PageHeader title="课程广场" actions={…} />    ← 固定
 *       <PageContent>…卡片栅格…</PageContent>          ← 唯一主滚动容器
 *     </PageLayout>
 *   </AppViewport>
 *
 * 带侧栏/右面板的页面用 PageColumns + PageColumn，每列各自滚动。
 */

export interface AppViewportProps extends HTMLAttributes<HTMLDivElement> {
  /** 通常是共享 RoleHeader。 */
  header?: ReactNode;
  /** 透传给 <main> 的属性（id、aria-label 等）。 */
  mainProps?: HTMLAttributes<HTMLElement>;
}

/**
 * 应用壳：高度恰好等于视口（100dvh），`html`/`body` 不滚动；Header 下方的 <main> 占满剩余高度，
 * 滚动只发生在页面内声明的 ScrollArea 里（规范 02 §2、§4 S1）。
 */
export function AppViewport({
  children,
  className,
  header,
  mainProps,
  ...props
}: AppViewportProps) {
  return (
    <div className={cn('rx-app-viewport', className)} {...props}>
      {header}
      <main {...mainProps} className={cn('rx-app-main', mainProps?.className)}>
        {children}
      </main>
    </div>
  );
}

export type PageTemplate = 'detail' | 'manage' | 'overview' | 'player' | 'wizard' | 'workbench';

export interface PageLayoutProps extends HTMLAttributes<HTMLDivElement> {
  /** 页面骨架模板 T1–T6（规范 02 §3），写到 data-template 上便于检查与微调。 */
  template?: PageTemplate;
}

/** 页面根：占满 <main> 的纵向 flex 列，内部固定区在上、滚动区 flex:1。 */
export const PageLayout = forwardRef<HTMLDivElement, PageLayoutProps>(function PageLayout(
  { className, template, ...props },
  ref,
) {
  return <div className={cn('rx-page', className)} data-template={template} ref={ref} {...props} />;
});

export type PageContentProps = ScrollAreaProps & {
  /** 内容区最大宽度与左右页边距，默认 true；全宽画布（工作台）传 false。 */
  padded?: boolean;
};

/** 页面主滚动容器：带页面左右边距（40 / 1280–1439 为 24），≥ 1920 时内容最大宽 1760 居中。 */
export const PageContent = forwardRef<HTMLDivElement, PageContentProps>(function PageContent(
  { children, className, padded = true, ...props },
  ref,
) {
  return (
    <ScrollArea className={cn('rx-page-content', className)} ref={ref} {...props}>
      {padded ? <div className="rx-page-content-inner">{children}</div> : children}
    </ScrollArea>
  );
});

export interface PageColumnsProps extends HTMLAttributes<HTMLDivElement> {
  /** 列之间的间距与页面边距；嵌在卡片里或贴边布局时传 false。 */
  padded?: boolean;
}

/** 左右分栏（二级侧栏 / 主面板 / 右面板），各列独立滚动，页面不滚动。 */
export function PageColumns({ className, padded = true, ...props }: PageColumnsProps) {
  return (
    <div
      className={cn('rx-page-columns', className)}
      data-padded={padded ? 'true' : undefined}
      {...props}
    />
  );
}

export type PageColumnWidth = 'auto' | 'overview' | 'side-nav' | 'side-panel';

export interface PageColumnProps extends HTMLAttributes<HTMLDivElement> {
  /** 固定列宽：side-nav 160、overview 376、side-panel 400（1280–1439 为 360）；auto 占满剩余。 */
  width?: PageColumnWidth;
  /** 列内是否自带滚动容器（列头固定时传 false，自行放 ScrollArea）。默认 true。 */
  scroll?: boolean;
}

export function PageColumn({
  children,
  className,
  scroll = true,
  width = 'auto',
  ...props
}: PageColumnProps) {
  return (
    <div className={cn('rx-page-column', className)} data-width={width} {...props}>
      {scroll ? <ScrollArea className="rx-page-column-scroll">{children}</ScrollArea> : children}
    </div>
  );
}

export interface BackBarProps {
  className?: string;
  /** 链接地址；与 onBack 二选一。 */
  href?: string;
  /** 「返回××」文案。 */
  label: ReactNode;
  /** Next.js 的 Link 等自定义链接组件；默认 <a>。 */
  linkComponent?: ElementType;
  onBack?: MouseEventHandler<HTMLElement>;
  /** 右侧区域（如向导的全局操作）。 */
  actions?: ReactNode;
  /** 面包屑后的当前标题。 */
  title?: ReactNode;
}

/** 返回条（规范 02 §8）：← + 「返回××」；有标题时后接分割线和当前标题。整块可点、键盘可达。 */
export function BackBar({
  actions,
  className,
  href,
  label,
  linkComponent: LinkComponent = 'a',
  onBack,
  title,
}: BackBarProps) {
  const content = (
    <>
      <ArrowLeft aria-hidden="true" className="rx-back-bar-icon" />
      <span className="rx-back-bar-label">{label}</span>
    </>
  );
  return (
    <div className={cn('rx-back-bar', className)}>
      {href === undefined ? (
        <button className="rx-back-bar-link" onClick={onBack} type="button">
          {content}
        </button>
      ) : (
        <LinkComponent className="rx-back-bar-link" href={href} onClick={onBack}>
          {content}
        </LinkComponent>
      )}
      {title === undefined ? null : (
        <>
          <span aria-hidden="true" className="rx-back-bar-divider" />
          <span className="rx-back-bar-title">{title}</span>
        </>
      )}
      {actions === undefined ? null : <div className="rx-back-bar-actions">{actions}</div>}
    </div>
  );
}

export interface ActionFooterBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 左侧提示文字。 */
  hint?: ReactNode;
}

/** 向导底部深色操作栏（规范 02 §3 T3）：header 色底、顶部圆角 24、高 80；右侧放 inverse 次操作 + primary 主操作。 */
export function ActionFooterBar({ children, className, hint, ...props }: ActionFooterBarProps) {
  return (
    <div className={cn('rx-action-footer', className)} {...props}>
      <div className="rx-action-footer-hint">{hint}</div>
      <div className="rx-action-footer-actions">{children}</div>
    </div>
  );
}

/** 课程卡片栅格（规范 02 §3 T1）：auto-fill minmax(320px, 1fr)，间距 20。 */
export function CardGrid({
  className,
  minItemWidth,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { minItemWidth?: number }) {
  return (
    <div
      className={cn('rx-card-grid', className)}
      style={
        minItemWidth === undefined
          ? style
          : ({ ...style, '--rx-card-grid-min': `${minItemWidth}px` } as CSSProperties)
      }
      {...props}
    />
  );
}
