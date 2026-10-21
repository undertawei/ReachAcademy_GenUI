import { CircleAlert, FileQuestionMark, Inbox, Lock, SearchX } from 'lucide-react';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';

export type EmptyVariant = 'error' | 'no-data' | 'no-permission' | 'no-results' | 'not-found';

const DEFAULT_ICONS: Record<EmptyVariant, typeof Inbox> = {
  error: CircleAlert,
  'no-data': Inbox,
  'no-permission': Lock,
  'no-results': SearchX,
  'not-found': FileQuestionMark,
};

export type EmptyProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** 可选主操作（「新建课程」「清空筛选」「重试」），通常是一个 Button。 */
  action?: ReactNode;
  description?: ReactNode;
  /** 标题元素层级；默认用 `<p>`，区块主标题时可传 2–4。 */
  headingLevel?: 2 | 3 | 4;
  /** 自定义图标（lucide 元素）；传 `null` 不显示图标。默认按 `variant` 取。 */
  icon?: ReactNode;
  title: ReactNode;
  /** 场景：只影响默认图标。默认 `no-data`。 */
  variant?: EmptyVariant;
};

/**
 * 空状态 / 结果（规范 03 §3.28、05 §3）：居中于容器，48px `text-tertiary` 图标 + 标题 14/500 +
 * 说明 12 `text-secondary` + 可选主操作。文案要友好具体，由调用方传入。
 */
export const Empty = forwardRef<HTMLDivElement, EmptyProps>(function Empty(
  { action, className, description, headingLevel, icon, title, variant = 'no-data', ...props },
  ref,
) {
  const DefaultIcon = DEFAULT_ICONS[variant] ?? Inbox;
  const Heading = headingLevel ? (`h${headingLevel}` as const) : 'p';
  return (
    <div className={cn('rx-empty', className)} data-variant={variant} ref={ref} {...props}>
      {icon === null ? null : (
        <span aria-hidden="true" className="rx-empty-icon">
          {icon ?? <DefaultIcon strokeWidth={1.5} />}
        </span>
      )}
      <Heading className="rx-empty-title">{title}</Heading>
      {description === undefined || description === null ? null : (
        <p className="rx-empty-description">{description}</p>
      )}
      {action === undefined || action === null ? null : (
        <div className="rx-empty-action">{action}</div>
      )}
    </div>
  );
});
