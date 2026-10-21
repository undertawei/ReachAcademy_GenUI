import { createHash } from 'node:crypto';

const SHA256_PREFIX = 'sha256:';
const ID_NAMESPACE = 'pptx-source-identity/v1';

export type PptxSourceDigest = `sha256:${string}`;

export const canonicalizePptxPartPath = (input: string): string => {
  if (input.length === 0) throw new Error('PPTX package part path cannot be empty.');
  if (input.includes('\\')) throw new Error('PPTX package part path cannot contain a backslash.');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) {
    throw new Error('PPTX package part path cannot contain a URI scheme.');
  }
  if (/[?#\u0000-\u001f\u007f]/.test(input)) {
    throw new Error('PPTX package part path contains a forbidden character.');
  }

  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error('PPTX package part path escapes the package root.');
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) throw new Error('PPTX package part path must identify a part.');
  return `/${segments.join('/')}`;
};

export const createPptxSourceDigest = (input: Uint8Array): PptxSourceDigest =>
  `${SHA256_PREFIX}${createHash('sha256').update(input).digest('hex')}`;

export const createStablePptxId = (kind: string, components: readonly string[]): string => {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new Error('PPTX identity kind must be a lowercase kebab-case token.');
  }
  if (components.length === 0 || components.some((component) => component.length === 0)) {
    throw new Error('PPTX source identity requires non-empty components.');
  }

  const canonicalTuple = JSON.stringify([ID_NAMESPACE, kind, ...components]);
  const digest = createHash('sha256').update(canonicalTuple, 'utf8').digest('hex').slice(0, 32);
  return `pptx-${kind}-v1-${digest}`;
};
