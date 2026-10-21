import type { ReactNode } from 'react';

export type StudentImportClassification = 'existing' | 'invalid' | 'new';

export type StudentImportStatistics = {
  existing: number;
  invalid: number;
  new: number;
  total: number;
};

export type StudentImportResultRow = {
  classification: StudentImportClassification;
  content: ReactNode;
  key: string;
};

export type StudentImportResultsProps = {
  labels: {
    existing: string;
    invalid: string;
    new: string;
    total: string;
  };
  rows?: StudentImportResultRow[];
  statistics: StudentImportStatistics;
};

const STATE_CLASS: Record<StudentImportClassification, string> = {
  existing: 'border-amber-300 bg-amber-50 text-amber-950',
  invalid: 'border-red-300 bg-red-50 text-red-950',
  new: 'border-emerald-300 bg-emerald-50 text-emerald-950',
};

export function StudentImportResults({ labels, rows = [], statistics }: StudentImportResultsProps) {
  const cards: Array<{ key: keyof StudentImportStatistics; className: string }> = [
    { key: 'total', className: 'border-slate-300 bg-slate-50 text-slate-950' },
    { key: 'new', className: STATE_CLASS.new },
    { key: 'existing', className: STATE_CLASS.existing },
    { key: 'invalid', className: STATE_CLASS.invalid },
  ];
  return (
    <section className="col-span-full">
      <dl
        className="grid grid-cols-4 gap-3"
        style={{
          display: 'grid',
          gap: '0.75rem',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        }}
      >
        {cards.map(({ key, className }) => (
          <div
            className={`rounded-lg border p-3 text-center ${className}`}
            data-import-statistic={key}
            key={key}
          >
            <dd className="text-xl font-bold">{statistics[key]}</dd>
            <dt className="text-xs font-semibold">{labels[key]}</dt>
          </div>
        ))}
      </dl>
      {rows.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li
              aria-label={labels[row.classification]}
              className={`rounded-lg border p-3 text-sm ${STATE_CLASS[row.classification]}`}
              data-import-classification={row.classification}
              key={row.key}
            >
              {row.content}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
