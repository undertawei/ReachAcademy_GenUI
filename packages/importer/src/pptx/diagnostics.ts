export type PptxDiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export type PptxDiagnosticFeature =
  | 'package'
  | 'relationship'
  | 'presentation'
  | 'theme'
  | 'master'
  | 'layout'
  | 'geometry'
  | 'transform'
  | 'text-frame'
  | 'font-substitution'
  | 'shape'
  | 'connector'
  | 'group'
  | 'image'
  | 'audio'
  | 'video'
  | 'table'
  | 'chart'
  | 'formula'
  | 'diagram'
  | 'notes'
  | 'transition'
  | 'animation'
  | 'unknown-ooxml';

export interface PptxDiagnosticLocation {
  /** Canonical OPC part name with a leading slash. */
  partPath: string;
  slideId?: string;
  nodePath?: string;
  relationshipId?: string;
}

export type PptxDiagnosticDetail =
  | string
  | number
  | boolean
  | null
  | readonly PptxDiagnosticDetail[]
  | { readonly [key: string]: PptxDiagnosticDetail };

export interface PptxDiagnostic {
  /** Stable machine-readable identifier. Messages are explanatory, not API keys. */
  code: `pptx.${string}`;
  severity: PptxDiagnosticSeverity;
  feature: PptxDiagnosticFeature;
  message: string;
  location?: PptxDiagnosticLocation;
  details?: Readonly<Record<string, PptxDiagnosticDetail>>;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const diagnosticSortKey = (diagnostic: PptxDiagnostic): readonly string[] => [
  diagnostic.location?.partPath ?? '',
  diagnostic.location?.slideId ?? '',
  diagnostic.location?.nodePath ?? '',
  diagnostic.location?.relationshipId ?? '',
  diagnostic.code,
  diagnostic.severity,
  diagnostic.message,
];

export const sortPptxDiagnostics = (diagnostics: readonly PptxDiagnostic[]): PptxDiagnostic[] =>
  [...diagnostics].sort((left, right) => {
    const leftKey = diagnosticSortKey(left);
    const rightKey = diagnosticSortKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      const comparison = compareText(leftKey[index]!, rightKey[index]!);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });

/**
 * Whether something was genuinely lost: an element or page dropped (`error`) or
 * the package unreadable (`fatal`). Mapping code uses it to decide whether an
 * element survived its own mapping; it is *not* the import gate — a lost
 * picture is reported, not a reason to refuse the rest of the deck.
 */
export const hasBlockingPptxDiagnostics = (diagnostics: readonly PptxDiagnostic[]): boolean =>
  diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
  );

/**
 * The import gate. Only a package that cannot be read at all — corrupt archive,
 * malformed XML, unresolvable theme — refuses import; every other loss travels
 * with the candidate as a diagnostic for the teacher to see.
 */
export const hasFatalPptxDiagnostics = (diagnostics: readonly PptxDiagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'fatal');
