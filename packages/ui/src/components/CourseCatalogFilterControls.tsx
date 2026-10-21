'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Select, type SelectOption } from './Select';
import type { CourseCatalogFilterField, CourseCatalogFilterState } from './course-catalog-filters';

export interface CourseCatalogFilterControl {
  label: string;
  clearLabel: string;
  options: SelectOption<string>[];
}
export interface CourseCatalogFilterControlsProps {
  value: CourseCatalogFilterState;
  fields: Record<CourseCatalogFilterField, CourseCatalogFilterControl>;
  label: string;
  compactLabel: string;
  disabled?: boolean;
  search?: ReactNode;
  onChange(field: CourseCatalogFilterField, value: string): void;
  onOpenChange?(open: boolean): void;
}

/** Labels and classification choices belong to the application that owns the catalog. */
export function CourseCatalogFilterControls({
  value,
  fields,
  label,
  disabled = false,
  search,
  onChange,
  onOpenChange,
}: CourseCatalogFilterControlsProps) {
  const [openField, setOpenField] = useState<CourseCatalogFilterField | null>(null);
  const open = openField !== null;
  const openCallback = useRef(onOpenChange);
  openCallback.current = onOpenChange;
  useEffect(() => {
    openCallback.current?.(open);
  }, [open]);
  useEffect(() => () => openCallback.current?.(false), []);
  return (
    <div
      role="group"
      aria-label={label}
      className="rx-course-catalog-filters"
      data-course-library-filters
      data-modal-escape-boundary={open ? 'true' : undefined}
    >
      {(['sort', 'stage', 'grade', 'subject', 'source'] as const).map((field) => (
        <Select
          key={field}
          aria-label={fields[field].label}
          clearable
          clearLabel={fields[field].clearLabel}
          emptyValue={field === 'sort' ? 'updated' : 'all'}
          options={fields[field].options}
          value={value[field]}
          disabled={disabled}
          portal
          size="sm"
          variant="filter"
          onChange={(next) => {
            if (!disabled) onChange(field, next);
          }}
          onOpenChange={(next) =>
            setOpenField((current) => (next ? field : current === field ? null : current))
          }
        />
      ))}
      {search ? <div className="rx-course-catalog-filter-search">{search}</div> : null}
    </div>
  );
}
