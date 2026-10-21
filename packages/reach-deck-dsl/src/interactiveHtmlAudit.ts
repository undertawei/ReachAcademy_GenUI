export const INTERACTIVE_DOCUMENT_MAX_BYTES = 512 * 1024;

export type InteractiveHtmlAuditCode =
  | 'document_empty'
  | 'document_too_large'
  | 'document_incomplete'
  | 'malformed_markup'
  | 'external_resource'
  | 'network_api'
  | 'worker_api'
  | 'nested_document'
  | 'policy_override';

export interface InteractiveHtmlAuditIssue {
  code: InteractiveHtmlAuditCode;
  message: string;
}

export interface InteractiveHtmlAuditResult {
  status: 'pass' | 'fail';
  issues: InteractiveHtmlAuditIssue[];
  byteLength: number;
}

interface HtmlToken {
  name: string;
  closing: boolean;
  attributes: Map<string, string>;
  content?: string;
}

const decodeAuditEntities = (value: string): string =>
  value.replace(
    /&#(?:x([0-9a-f]+)|([0-9]+));?|&(colon|sol|period|tab|newline|amp);/gi,
    (_match, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex || decimal) {
        const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '';
      }
      return (
        (
          { colon: ':', sol: '/', period: '.', tab: '\t', newline: '\n', amp: '&' } as Record<
            string,
            string
          >
        )[named?.toLowerCase() ?? ''] ?? ''
      );
    },
  );

const parseAttributes = (source: string): Map<string, string> | undefined => {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '/') break;
    const nameMatch = /^[^\s=/>]+/.exec(source.slice(index));
    if (!nameMatch) return undefined;
    const name = nameMatch[0].toLowerCase();
    if (attributes.has(name)) return undefined;
    index += nameMatch[0].length;
    while (/\s/.test(source[index] ?? '')) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const end = source.indexOf(quote, index);
        if (end < 0) return undefined;
        value = source.slice(index, end);
        index = end + 1;
      } else {
        const valueMatch = /^[^\s>]+/.exec(source.slice(index));
        if (!valueMatch) return undefined;
        value = valueMatch[0];
        index += value.length;
      }
    }
    attributes.set(name, decodeAuditEntities(value));
  }
  return attributes;
};

const findTagEnd = (html: string, start: number): number => {
  let quote: string | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
};

const tokenizeHtml = (html: string): { tokens: HtmlToken[]; malformed: boolean } => {
  const tokens: HtmlToken[] = [];
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return { tokens, malformed: true };
      index = end + 3;
      continue;
    }
    const end = findTagEnd(html, start + 1);
    if (end < 0) return { tokens, malformed: true };
    const raw = html.slice(start + 1, end).trim();
    if (/^!doctype\s+html$/i.test(raw)) {
      index = end + 1;
      continue;
    }
    if (raw.startsWith('!') || raw.startsWith('?')) return { tokens, malformed: true };
    const match = /^(\/)?\s*([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(raw);
    if (!match) return { tokens, malformed: true };
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    const attributes = closing ? new Map<string, string>() : parseAttributes(match[3]);
    if (!attributes) return { tokens, malformed: true };
    const token: HtmlToken = { name, closing, attributes };
    index = end + 1;
    if (!closing && (name === 'script' || name === 'style')) {
      const closePattern = new RegExp(`<\\/\\s*${name}\\s*>`, 'ig');
      closePattern.lastIndex = index;
      const close = closePattern.exec(html);
      if (!close) return { tokens, malformed: true };
      token.content = html.slice(index, close.index);
      index = close.index + close[0].length;
    }
    tokens.push(token);
  }
  return { tokens, malformed: false };
};

const issue = (code: InteractiveHtmlAuditCode, message: string): InteractiveHtmlAuditIssue => ({
  code,
  message,
});

const resourceAttributes = new Set([
  'action',
  'formaction',
  'href',
  'poster',
  'src',
  'srcset',
  'xlink:href',
]);
const nestedDocumentTags = new Set(['embed', 'frame', 'iframe', 'object']);
const MAIC_KATEX_BUNDLE_BYTES = 276592;
const MAIC_KATEX_BUNDLE_SHA256 = 'edad612acc62d4af72674aa72764852b9d2399410ce7b026edaf499ffcdc49e6';
const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const sha256Hex = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  const rotateRight = (word: number, amount: number): number =>
    (word >>> amount) | (word << (32 - amount));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15]!;
      const sigma0 = rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
      const previous = words[index - 2]!;
      const sigma1 = rotateRight(previous, 17) ^ rotateRight(previous, 19) ^ (previous >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
};

// The MAIC importer replaces its allowlisted KaTeX CDN references with this exact, repository-
// pinned inline compatibility bundle. Untrusted scripts cannot self-declare the privilege: both
// the marker shape and the bundle bytes must match the reviewed digest.
const isBundledMaicKatexScript = (token: HtmlToken): boolean => {
  if (
    token.name !== 'script' ||
    token.attributes.size !== 1 ||
    token.attributes.get('data-maic-offline-katex') !== ''
  )
    return false;
  const content = token.content ?? '';
  return (
    new TextEncoder().encode(content).byteLength === MAIC_KATEX_BUNDLE_BYTES &&
    sha256Hex(content) === MAIC_KATEX_BUNDLE_SHA256
  );
};

const isOfflineUrl = (value: string): boolean => {
  const normalized = decodeAuditEntities(value).trim().toLowerCase();
  return (
    normalized === '' ||
    normalized.startsWith('#') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:')
  );
};

const cssRequestsExternalResource = (source: string): boolean => {
  if (/@import\b/i.test(source)) return true;
  for (const match of source.matchAll(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi)) {
    if (!isOfflineUrl(match[2] ?? '')) return true;
  }
  return false;
};

const auditedJavaScriptPropertyNames = new Set([
  'EventSource',
  'SharedWorker',
  'WebSocket',
  'Worker',
  'XMLHttpRequest',
  'fetch',
  'importScripts',
  'sendBeacon',
  'serviceWorker',
]);
const javascriptRegexPrefixWord =
  /(?:^|[^\w$])(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)\s*$/;
const controlHeaderKeywords = new Set(['for', 'if', 'while']);

const isControlHeaderParenthesis = (scanned: string): boolean => {
  const executable = scanned.trimEnd();
  const match = /[A-Za-z_$][\w$]*$/.exec(executable);
  if (match === null || !controlHeaderKeywords.has(match[0])) return false;
  const preceding = executable[match.index - 1];
  return preceding !== '.';
};

const canStartJavaScriptRegex = (scanned: string): boolean => {
  const executable = scanned.trimEnd();
  if (executable === '') return true;
  const previous = executable.at(-1)!;
  return '([{:;,=!?&|+-*/%^~<>'.includes(previous) || javascriptRegexPrefixWord.test(executable);
};

const isBracketPropertyLiteral = (source: string, start: number, end: number): boolean => {
  let previous = start - 1;
  while (previous >= 0 && /\s/.test(source[previous]!)) previous -= 1;
  if (source[previous] !== '[') return false;
  let next = end;
  while (next < source.length && /\s/.test(source[next]!)) next += 1;
  return source[next] === ']';
};

const isSecuritySensitiveGlobalBracket = (scanned: string): boolean =>
  /\b(?:globalThis|navigator|self|window)\s*(?:\?\.)?\s*\[\s*$/.test(scanned);

/**
 * Removes inert JavaScript trivia and string text while retaining executable template
 * interpolations and reserved quoted/static-template bracket names such as window['fetch'] and
 * window[`fetch`]. Interpolated bracket properties on browser globals are rejected conservatively
 * because their resolved capability name cannot be proven offline at publication time.
 */
const stripJavaScriptTriviaAndStrings = (source: string): string => {
  let regexLiteralEnds: Uint32Array | undefined;
  const findRegexLiteralEnd = (start: number): number => {
    if (!regexLiteralEnds) {
      // Precompute the original regex scanner's endpoint from each offset in both character-class
      // states. Failed candidates must not repeatedly scan the remaining source. All recursive
      // template scans share this lazy table; zero means newline/EOF without a closing slash.
      const outsideClass = new Uint32Array(source.length + 1);
      const insideClass = new Uint32Array(source.length + 1);
      for (let index = source.length - 1; index >= 0; index -= 1) {
        const character = source[index]!;
        if (character === '\\' && index + 1 < source.length) {
          outsideClass[index] = outsideClass[index + 2]!;
          insideClass[index] = insideClass[index + 2]!;
        } else if (character === '[') {
          outsideClass[index] = insideClass[index + 1]!;
          insideClass[index] = insideClass[index + 1]!;
        } else if (character === ']') {
          outsideClass[index] = outsideClass[index + 1]!;
          insideClass[index] = outsideClass[index + 1]!;
        } else if (character === '/') {
          outsideClass[index] = index + 1;
          insideClass[index] = insideClass[index + 1]!;
        } else if (character !== '\r' && character !== '\n') {
          outsideClass[index] = outsideClass[index + 1]!;
          insideClass[index] = insideClass[index + 1]!;
        }
      }
      regexLiteralEnds = outsideClass;
    }
    return regexLiteralEnds[start]!;
  };
  const scan = (start: number, templateExpression: boolean): { index: number; text: string } => {
    let index = start;
    let braceDepth = templateExpression ? 1 : 0;
    let text = '';
    // Lexical decisions only need the trailing token(s). Compress whitespace so arbitrarily long
    // trivia cannot displace them, and cap the suffix to avoid rescanning/flattening all prior text.
    // The guard preserves identifier boundaries if the cap cuts through a long identifier.
    let context = '';
    let contextTruncated = false;
    const append = (value: string): void => {
      text += value;
      const normalized = value.replace(/\s+/g, ' ');
      const combined =
        context +
        (context.endsWith(' ') && normalized.startsWith(' ') ? normalized.slice(1) : normalized);
      contextTruncated ||= combined.length > 64;
      context = combined.slice(-64);
    };
    const executableContext = (): string => (contextTruncated ? '_' : '') + context;
    let controlStatementStart = false;
    const controlHeaderParentheses: boolean[] = [];
    const blank = (value: string): string => value.replace(/[^\r\n]/g, ' ');
    while (index < source.length) {
      const character = source[index]!;
      const next = source[index + 1];
      if (character === '/' && next === '/') {
        const end = source.slice(index + 2).search(/[\r\n]/);
        const stop = end < 0 ? source.length : index + 2 + end;
        append(blank(source.slice(index, stop)));
        index = stop;
        continue;
      }
      if (character === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        const stop = end < 0 ? source.length : end + 2;
        append(blank(source.slice(index, stop)));
        index = stop;
        continue;
      }
      if (
        character === '/' &&
        (controlStatementStart || canStartJavaScriptRegex(executableContext()))
      ) {
        let end = findRegexLiteralEnd(index + 1);
        if (end !== 0) {
          while (/[a-z]/i.test(source[end] ?? '')) end += 1;
          append(blank(source.slice(index, end)));
          index = end;
          controlStatementStart = false;
          continue;
        }
      }
      if (character === "'" || character === '"') {
        controlStatementStart = false;
        const quote = character;
        let end = index + 1;
        let rawValue = '';
        while (end < source.length) {
          const candidate = source[end]!;
          if (candidate === '\\' && end + 1 < source.length) {
            rawValue += source.slice(end, end + 2);
            end += 2;
            continue;
          }
          if (candidate === quote) {
            end += 1;
            break;
          }
          rawValue += candidate;
          end += 1;
        }
        const preserved =
          isBracketPropertyLiteral(source, index, end) &&
          !rawValue.includes('\\') &&
          auditedJavaScriptPropertyNames.has(rawValue)
            ? ` ${rawValue} `
            : blank(source.slice(index, end));
        append(preserved);
        index = end;
        continue;
      }
      if (character === '`') {
        controlStatementStart = false;
        const start = index;
        const securitySensitiveGlobalBracket =
          isSecuritySensitiveGlobalBracket(executableContext());
        let templateText = ' ';
        let rawValue = '';
        let escaped = false;
        let interpolated = false;
        index += 1;
        while (index < source.length) {
          const candidate = source[index]!;
          if (candidate === '\\' && index + 1 < source.length) {
            escaped = true;
            rawValue += source.slice(index, index + 2);
            templateText += '  ';
            index += 2;
          } else if (candidate === '`') {
            templateText += ' ';
            index += 1;
            break;
          } else if (candidate === '$' && source[index + 1] === '{') {
            interpolated = true;
            templateText += '${';
            const expression = scan(index + 2, true);
            templateText += expression.text;
            index = expression.index;
          } else {
            rawValue += candidate;
            templateText += candidate === '\r' || candidate === '\n' ? candidate : ' ';
            index += 1;
          }
        }
        if (
          isBracketPropertyLiteral(source, start, index) &&
          !interpolated &&
          !escaped &&
          auditedJavaScriptPropertyNames.has(rawValue)
        ) {
          append(` ${rawValue} `);
        } else if (interpolated && securitySensitiveGlobalBracket) {
          // A computed property on a browser-global can assemble any blocked capability name.
          // Retain both capability sentinels so the conservative offline policy rejects it.
          append(` fetch Worker ${templateText}`);
        } else {
          append(templateText);
        }
        continue;
      }
      if (character === '(') {
        controlHeaderParentheses.push(isControlHeaderParenthesis(executableContext()));
        controlStatementStart = false;
        append(character);
        index += 1;
        continue;
      }
      if (character === ')') {
        controlStatementStart = controlHeaderParentheses.pop() === true;
        append(character);
        index += 1;
        continue;
      }
      if (templateExpression) {
        if (character === '{') braceDepth += 1;
        if (character === '}') {
          braceDepth -= 1;
          append(character);
          index += 1;
          if (braceDepth === 0) return { index, text };
          continue;
        }
      }
      append(character);
      index += 1;
      if (!/\s/.test(character)) controlStatementStart = false;
    }
    return { index, text };
  };
  return scan(0, false).text;
};

const scriptRequestsNetwork = (executable: string): boolean => {
  if (/\bimport\s*(?:\(|[\s\S]{0,120}?\bfrom\s*)/m.test(executable)) return true;
  return (
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/m.test(executable) ||
    /\[\s*(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\]/m.test(executable)
  );
};

const scriptRequestsWorker = (executable: string): boolean => {
  return (
    /\b(?:Worker|SharedWorker|importScripts|serviceWorker)\b/m.test(executable) ||
    /\[\s*(?:Worker|SharedWorker|importScripts|serviceWorker)\s*\]/m.test(executable)
  );
};

export const auditInteractiveDocumentHtml = (documentHtml: string): InteractiveHtmlAuditResult => {
  const byteLength = new TextEncoder().encode(documentHtml).byteLength;
  const issues: InteractiveHtmlAuditIssue[] = [];
  if (!documentHtml.trim()) issues.push(issue('document_empty', 'documentHtml must not be empty.'));
  if (byteLength > INTERACTIVE_DOCUMENT_MAX_BYTES) {
    issues.push(
      issue(
        'document_too_large',
        `documentHtml exceeds ${INTERACTIVE_DOCUMENT_MAX_BYTES} UTF-8 bytes.`,
      ),
    );
  }

  const { tokens, malformed } = tokenizeHtml(documentHtml);
  if (malformed)
    issues.push(
      issue('malformed_markup', 'documentHtml contains malformed or unsupported markup.'),
    );
  const opened = new Set(tokens.filter((token) => !token.closing).map((token) => token.name));
  if (!opened.has('html') || !opened.has('head') || !opened.has('body')) {
    issues.push(
      issue('document_incomplete', 'documentHtml must contain html, head, and body elements.'),
    );
  }

  for (const token of tokens) {
    if (token.closing) continue;
    if (nestedDocumentTags.has(token.name)) {
      issues.push(
        issue('nested_document', 'Nested browsing or plugin documents are not supported.'),
      );
    }
    if (token.name === 'base' || token.name === 'link') {
      issues.push(
        issue('external_resource', 'External or document-relative resources are not supported.'),
      );
    }
    if (
      token.name === 'meta' &&
      ['content-security-policy', 'refresh'].includes(
        (token.attributes.get('http-equiv') ?? '').trim().toLowerCase(),
      )
    ) {
      issues.push(issue('policy_override', 'Interactive documents cannot override host policy.'));
    }
    for (const [name, value] of token.attributes) {
      if (/^on[a-z][a-z0-9_-]*$/.test(name)) {
        const executable = stripJavaScriptTriviaAndStrings(value);
        if (scriptRequestsNetwork(executable)) {
          issues.push(
            issue('network_api', 'Interactive event handlers cannot use network APIs or imports.'),
          );
        }
        if (scriptRequestsWorker(executable)) {
          issues.push(issue('worker_api', 'Interactive event handlers cannot create workers.'));
        }
      }
      if (name === 'style' && cssRequestsExternalResource(value)) {
        issues.push(issue('external_resource', 'CSS cannot request external resources.'));
      }
      if (
        resourceAttributes.has(name) &&
        (name === 'srcset' ? value.trim() !== '' : !isOfflineUrl(value))
      ) {
        issues.push(
          issue('external_resource', 'External or document-relative resources are not supported.'),
        );
      }
    }
    if (token.name === 'script') {
      if (token.attributes.has('src')) {
        issues.push(issue('external_resource', 'External scripts are not supported.'));
      }
      const type = (token.attributes.get('type') ?? '').trim().toLowerCase();
      const executable =
        type === '' ||
        type === 'module' ||
        type === 'application/javascript' ||
        type === 'text/javascript' ||
        type === 'application/ecmascript' ||
        type === 'text/ecmascript';
      if (executable && !isBundledMaicKatexScript(token)) {
        const script = stripJavaScriptTriviaAndStrings(token.content ?? '');
        if (scriptRequestsNetwork(script)) {
          issues.push(
            issue('network_api', 'Interactive documents cannot use network APIs or imports.'),
          );
        }
        if (scriptRequestsWorker(script)) {
          issues.push(issue('worker_api', 'Interactive documents cannot create workers.'));
        }
      }
    }
    if (token.name === 'style' && cssRequestsExternalResource(token.content ?? '')) {
      issues.push(issue('external_resource', 'CSS cannot request external resources.'));
    }
  }

  const uniqueIssues = issues.filter(
    (entry, index) =>
      issues.findIndex(
        (candidate) => candidate.code === entry.code && candidate.message === entry.message,
      ) === index,
  );
  return { status: uniqueIssues.length === 0 ? 'pass' : 'fail', issues: uniqueIssues, byteLength };
};

export const assertInteractiveDocumentHtml = (documentHtml: string): void => {
  const result = auditInteractiveDocumentHtml(documentHtml);
  if (result.status === 'fail') {
    throw new Error(
      `Interactive document audit failed: ${result.issues.map((entry) => `${entry.code}: ${entry.message}`).join(' ')}`,
    );
  }
};
