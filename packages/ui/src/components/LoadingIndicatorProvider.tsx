'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { BrandLoader, type BrandLoaderProps } from './BrandLoader';

const LoadingIndicatorContext = createContext<'spinner' | 'brand'>('spinner');

/** Opt in per application; portals inherit the same visual without changing other apps. */
export function LoadingIndicatorProvider({
  children,
  variant,
}: {
  children: ReactNode;
  variant: 'spinner' | 'brand';
}) {
  return (
    <LoadingIndicatorContext.Provider value={variant}>{children}</LoadingIndicatorContext.Provider>
  );
}

export function useLoadingIndicatorVariant() {
  return useContext(LoadingIndicatorContext);
}

/** Keep each consumer's original graphic unless its application opts into the brand. */
export function LoadingIndicator({
  children,
  ...props
}: BrandLoaderProps & { children: ReactNode }) {
  return useLoadingIndicatorVariant() === 'brand' ? <BrandLoader {...props} /> : children;
}
