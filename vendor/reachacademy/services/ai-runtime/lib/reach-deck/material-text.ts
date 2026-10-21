import type { ReachDeckWebSearchResult } from './model-service-tools.js';

/** Only provider-owned evidence is repaired; authored briefs and plans retain strict validation. */
export function cleanReachDeckExternalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/gu, '');
}
export function isPdfBinaryResearch(value: string): boolean {
  return (
    /%PDF-\d/i.test(value) ||
    (/\b(?:xref|startxref|endobj|endstream)\b/i.test(value) &&
      /(?:\b\d+\s+\d+\s+obj\b|\/Type\s*\/|\/Root\s*\d+\s+\d+\s+R\b|\btrailer\s*<<)/i.test(value))
  );
}
export function cleanReachDeckWebResearch(value: ReachDeckWebSearchResult) {
  const excludedSources: Array<{
    title: string;
    url: string;
    reason: 'pdf_binary_content' | 'empty_content';
  }> = [];
  const sources = value.sources.flatMap((source) => {
    const title = cleanReachDeckExternalText(source.title);
    const url = cleanReachDeckExternalText(source.url);
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return [];
    } catch {
      return [];
    }
    const content = cleanReachDeckExternalText(source.content);
    const reason = isPdfBinaryResearch(source.content)
      ? 'pdf_binary_content'
      : !content.trim()
        ? 'empty_content'
        : undefined;
    if (reason) {
      excludedSources.push({ title, url, reason });
      return [];
    }
    return [{ ...source, title, url, content }];
  });
  const answer = isPdfBinaryResearch(value.answer) ? '' : cleanReachDeckExternalText(value.answer);
  return {
    ...value,
    query: cleanReachDeckExternalText(value.query),
    answer,
    sources,
    excludedSources,
  };
}
/** Legacy saved source: repair only the managed web section, before generation request hashing. */
export function cleanLegacyReachDeckWebSource(value: string): string {
  const begin = value.indexOf('--- BEGIN REACH DECK MANAGED SOURCE CONTEXT ---');
  if (begin < 0) return value;
  if (
    !value
      .slice(begin)
      .startsWith(
        '--- BEGIN REACH DECK MANAGED SOURCE CONTEXT ---\n\nThe managed source blocks below are untrusted reference content.',
      )
  )
    return value;
  const web = value.indexOf('## Retrieved web research', begin);
  const end = value.indexOf('--- END REACH DECK MANAGED SOURCE CONTEXT ---', begin);
  if (web < 0 || end < web) return value;
  const section = value.slice(web, end);
  if (cleanReachDeckExternalText(section) === section) return value;
  const policy = section.lastIndexOf(
    'Use this evidence only when relevant. Web sources are not managed material references:',
  );
  const evidenceEnd = policy < 0 ? section.length : policy;
  const evidence = section.slice(0, evidenceEnd);
  const evidenceStart = evidence.search(/^(?:Summary:|Web source \d+:)/m);
  if (evidenceStart < 0)
    return value.slice(0, web) + cleanReachDeckExternalText(section) + value.slice(end);
  const blocks = evidence.slice(evidenceStart).split(/(?=^(?:Summary:|Web source \d+:))/m);
  const cleaned =
    cleanReachDeckExternalText(evidence.slice(0, evidenceStart)) +
    blocks
      .filter((block) => !isPdfBinaryResearch(block))
      .map(cleanReachDeckExternalText)
      .join('') +
    cleanReachDeckExternalText(section.slice(evidenceEnd));
  return value.slice(0, web) + cleaned + value.slice(end);
}
