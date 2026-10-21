import { describe, expect, it } from 'vitest';
import { auditInteractiveDocumentHtml } from '../src/interactiveHtmlAudit.js';

const document = (script: string): string =>
  `<html><head></head><body><script>${script}</script></body></html>`;
const longTrivia = ` ${'\t \n'.repeat(128)}/* ${'inert'.repeat(128)} */ `;

describe('Interactive HTML lexical-context regressions', () => {
  it.each(['if', 'while', 'for'])(
    'keeps regex literals inert after a %s header separated by long trivia',
    (keyword) => {
      const header = keyword === 'for' ? ';;' : 'true';
      const script = `${'const n=(Math.sin(1));'.repeat(128)}${keyword}${longTrivia}(${header}) /fetch|Worker/.test('safe');`;
      expect(auditInteractiveDocumentHtml(document(script)).status).toBe('pass');
    },
  );

  it.each(['return', 'throw', 'yield', 'await'])(
    'retains regex-prefix keyword %s across long trivia',
    (keyword) => {
      expect(
        auditInteractiveDocumentHtml(
          document(`function* f(){ ${keyword}${longTrivia}/fetch|Worker/; }`),
        ).status,
      ).toBe('pass');
    },
  );

  it.each(['globalThis', 'navigator', 'self', 'window'])(
    'rejects a computed %s capability separated by long trivia',
    (global) => {
      const script = `${global}${longTrivia}?.${longTrivia}[${longTrivia}\`fe\${name}tch\`]('x');`;
      expect(auditInteractiveDocumentHtml(document(script)).issues.map(({ code }) => code)).toEqual(
        ['network_api', 'worker_api'],
      );
    },
  );

  it('retains quoted bracket capabilities on either side of long whitespace', () => {
    const padding = ' \t\n'.repeat(128);
    const script = `window[${padding}'fetch'${padding}]('x'); window[${padding}\`Worker\`${padding}]();`;
    expect(auditInteractiveDocumentHtml(document(script)).issues.map(({ code }) => code)).toEqual([
      'network_api',
      'worker_api',
    ]);
  });

  it('does not interpret suffixes of long identifiers or method names as control headers', () => {
    for (const prefix of ['x'.repeat(128) + 'if', 'object.if']) {
      const result = auditInteractiveDocumentHtml(document(`${prefix}(1) / fetch('x') / 2;`));
      expect(result.issues.map(({ code }) => code)).toContain('network_api');
    }
  });

  it('does not interpret a long identifier ending in a browser-global name as that global', () => {
    expect(
      auditInteractiveDocumentHtml(document(`${'x'.repeat(128)}globalThis[\`fe\${name}tch\`]();`))
        .status,
    ).toBe('pass');
  });

  it('reports both capability families from the same script and event handler', () => {
    const script = `fetch('x'); new Worker('x');`;
    const html = `<html><head></head><body><button onclick="${script}">go</button><script>${script}</script></body></html>`;
    const result = auditInteractiveDocumentHtml(html);
    expect(result.issues).toHaveLength(4);
    expect(result.issues.filter(({ code }) => code === 'network_api')).toHaveLength(2);
    expect(result.issues.filter(({ code }) => code === 'worker_api')).toHaveLength(2);
  });

  it('audits a large call-heavy offline script with a forbidden capability at the end', () => {
    // Large enough to expose repeated full-prefix regex scans; the default test timeout guards
    // the regression without asserting machine-dependent millisecond measurements.
    const script = 'Math.sin(1);Math.cos(2);'.repeat(18_000);
    expect(auditInteractiveDocumentHtml(document(script)).status).toBe('pass');
    expect(
      auditInteractiveDocumentHtml(document(`${script}window['fetch']('x');`)).issues.map(
        ({ code }) => code,
      ),
    ).toEqual(['network_api']);
  });

  it.each([
    String.raw`const p=/fetch\/Worker/gi;`,
    String.raw`const p=/[\/fetchWorker]/;`,
    String.raw`const p=/[/fetchWorker]/;`,
    String.raw`const p=/\[fetch\]Worker/;`,
    String.raw`const p=/[a[fetchWorker]b/;`,
    String.raw`const p=/[\]fetchWorker]/;`,
    'const value=`safe ${/[}/fetchWorker]/.test("x") ? 1 : 0}`;',
  ])('keeps regex class/escape text inert: %s', (script) => {
    expect(auditInteractiveDocumentHtml(document(script)).status).toBe('pass');
  });

  it.each(['\n', '\r'])(
    'does not hide executable capabilities after regex newline %j',
    (newline) => {
      const script = '/[unterminated' + newline + 'fetch("x"); new Worker("x");';
      expect(auditInteractiveDocumentHtml(document(script)).issues.map(({ code }) => code)).toEqual(
        ['network_api', 'worker_api'],
      );
    },
  );

  it('audits repeated unterminated regex candidates without hiding trailing capabilities', () => {
    const script = '/[ '.repeat(100_000) + 'fetch("x"); new Worker("x");';
    expect(auditInteractiveDocumentHtml(document(script)).issues.map(({ code }) => code)).toEqual([
      'network_api',
      'worker_api',
    ]);
  });
});
