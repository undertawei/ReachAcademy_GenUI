export type ReachDeckTranslationValues = Record<string, string | number>;

export type ReachDeckTranslate = (key: string, replacements?: ReachDeckTranslationValues) => string;

export function translateReachDeck(
  translate: ReachDeckTranslate | undefined,
  key: string,
  fallback: string,
  replacements: ReachDeckTranslationValues = {},
): string {
  const translated = translate?.(key, replacements);
  const template = translated === undefined || translated === key ? fallback : translated;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}
