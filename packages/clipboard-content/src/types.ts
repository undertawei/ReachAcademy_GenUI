export type ClipboardTableMode = 'flatten' | 'preserve';

export type ClipboardDiagnosticCode =
  | 'formula-depth-limit'
  | 'formula-input-limit'
  | 'formula-node-limit'
  | 'formula-output-limit'
  | 'invalid-formula-xml'
  | 'omml-conversion-failed'
  | 'unsafe-formula-output'
  | 'unsupported-mathml'
  | 'unsupported-omml';

export type ClipboardFormulaSource = 'mathml' | 'omml';

export interface ClipboardDiagnostic {
  code: ClipboardDiagnosticCode;
  formulaSource: ClipboardFormulaSource;
}

export interface ClipboardTransformOptions {
  /** Replaces a visible image with plain text after Office fallback/metadata filtering. */
  imagePlaceholder?: () => string | undefined;
  onDiagnostic?: (diagnostic: ClipboardDiagnostic) => void;
  /** Reports visible images degraded to alt text, after Office fallback/metadata filtering. */
  onUnavailableImage?: () => void;
  tableMode?: ClipboardTableMode;
}

export type OfficeClipboardResult =
  | { kind: 'not-applicable' }
  | {
      diagnostics: readonly ClipboardDiagnostic[];
      html: string;
      kind: 'transformed';
      source: 'mathml' | 'office';
    };

export interface ClipboardTextStyle {
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: string;
}

export interface ClipboardInlineMarks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  subscript?: boolean;
  superscript?: boolean;
  textStyle?: ClipboardTextStyle;
  underline?: boolean;
}

export type ClipboardInline =
  | { kind: 'break' }
  | {
      display: boolean;
      fallbackText: string;
      kind: 'formula';
      latex: string;
      source: ClipboardFormulaSource;
    }
  | { kind: 'text'; marks?: ClipboardInlineMarks; text: string };

export interface ClipboardParagraph {
  align?: 'center' | 'justify' | 'left' | 'right';
  content: ClipboardInline[];
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  kind: 'paragraph';
}

export interface ClipboardList {
  items: ClipboardBlock[][];
  kind: 'list';
  ordered: boolean;
}

export interface ClipboardTableCell {
  blocks: ClipboardBlock[];
  colspan: number;
  header: boolean;
  rowspan: number;
}

export interface ClipboardTableRow {
  cells: ClipboardTableCell[];
}

export interface ClipboardTable {
  kind: 'table';
  rows: ClipboardTableRow[];
}

export type ClipboardBlock = ClipboardList | ClipboardParagraph | ClipboardTable;

export interface ClipboardDocument {
  blocks: ClipboardBlock[];
  kind: 'document';
}

export interface ClipboardSerializeOptions {
  tableMode?: ClipboardTableMode;
}
