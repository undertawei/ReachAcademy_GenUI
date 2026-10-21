/** Validate decoded JSON text without rewriting authored facts, formulas, or examples. */
export class ReachDeckStructuredTextError extends Error {
  readonly code = 'INVALID_STRUCTURED_TEXT';

  constructor(
    readonly path: string,
    readonly character: string,
  ) {
    super(
      `Invalid structured text at ${path}: ${character}. Return meaningful text without NUL, control characters, or unpaired Unicode surrogates; preserve the intended teaching content.`,
    );
    this.name = 'ReachDeckStructuredTextError';
  }
}

function assertSafeString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new ReachDeckStructuredTextError(
        path,
        `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      );
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else throw new ReachDeckStructuredTextError(path, 'unpaired high surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ReachDeckStructuredTextError(path, 'unpaired low surrogate');
    }
  }
}

export function assertReachDeckStructuredTextSafe(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    assertSafeString(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => assertReachDeckStructuredTextSafe(child, `${path}[${index}]`));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      assertSafeString(key, childPath);
      assertReachDeckStructuredTextSafe(child, childPath);
    }
  }
}

/** A saved legacy plan remains readable, but cannot seed an invalid frozen JSONB input. */
export class ReachDeckOutlineInputTextError extends Error {
  readonly code = 'OUTLINE_INPUT_TEXT_INVALID';
  readonly path: string;

  constructor(cause: ReachDeckStructuredTextError) {
    super(
      `Page outline input contains invalid text at ${cause.path} (${cause.character}). Regenerate the lesson plan in Step 2, or correct the affected source/preferences, before generating the page outline again.`,
      { cause },
    );
    this.name = 'ReachDeckOutlineInputTextError';
    this.path = cause.path;
  }
}

export function assertReachDeckOutlineInputTextSafe(value: unknown): void {
  try {
    assertReachDeckStructuredTextSafe(value);
  } catch (error) {
    if (error instanceof ReachDeckStructuredTextError)
      throw new ReachDeckOutlineInputTextError(error);
    throw error;
  }
}
