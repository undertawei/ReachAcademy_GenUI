import type { ReactNode } from 'react';

export type StudentImportGuideProps = {
  title: string;
  schema: string;
  formats: string;
  limits: string;
  downloadLabel: string;
  onDownload: () => void;
  downloadIcon?: ReactNode;
  className?: string;
};

/** Shared five-column student-import guidance; applications own copy and actions. */
export function StudentImportGuide({
  title,
  schema,
  formats,
  limits,
  downloadLabel,
  onDownload,
  downloadIcon,
  className,
}: StudentImportGuideProps) {
  return (
    <section className={className ?? 'student-import-guide'}>
      <h3>{title}</h3>
      <p>{schema}</p>
      <p>{formats}</p>
      <p>{limits}</p>
      <button onClick={onDownload} type="button">
        {downloadIcon}
        {downloadLabel}
      </button>
    </section>
  );
}
