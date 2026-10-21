'use client';

import type { HTMLAttributes } from 'react';

import { cn } from '../cn';
import { BrandLoader } from './BrandLoader';
import { useLoadingIndicatorVariant } from './LoadingIndicatorProvider';

export type SpinnerSize = 'lg' | 'md' | 'sm';

export type SpinnerProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  label?: string;
  size?: SpinnerSize;
};

export function Spinner({ className, label, size = 'md', ...props }: SpinnerProps) {
  const brand = useLoadingIndicatorVariant() === 'brand';
  return (
    <span
      aria-hidden={label === undefined ? 'true' : undefined}
      className={cn(brand ? 'rx-spinner-brand' : 'rx-spinner', `rx-spinner-${size}`, className)}
      role={label === undefined ? undefined : 'status'}
      {...props}
    >
      {brand ? <BrandLoader size={size} /> : null}
      {label === undefined ? null : <span className="rx-visually-hidden">{label}</span>}
    </span>
  );
}
