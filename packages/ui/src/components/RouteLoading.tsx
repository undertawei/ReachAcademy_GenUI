import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';
import { BrandLoader } from './BrandLoader';
import { Skeleton } from './Skeleton';

export type RouteLoadingProps = HTMLAttributes<HTMLDivElement> & {
  description?: ReactNode;
  label: string;
};

export function RouteLoading({ className, description, label, ...props }: RouteLoadingProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn('rx-route-loading', className)}
      role="status"
      {...props}
    >
      <div className="rx-route-loading-heading">
        <BrandLoader size="lg" />
        <div>
          <strong>{label}</strong>
          {description === undefined ? null : <p>{description}</p>}
        </div>
      </div>
      <div aria-hidden="true" className="rx-route-loading-skeletons">
        <Skeleton height="1.25rem" width="42%" />
        <Skeleton lines={3} />
        <Skeleton height="5rem" variant="rectangle" />
      </div>
    </div>
  );
}
