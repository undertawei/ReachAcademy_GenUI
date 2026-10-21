type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  Object.freeze(value);
  Object.values(value as object).forEach((nestedValue) => {
    deepFreeze(nestedValue);
  });

  return value as DeepReadonly<T>;
};

export interface TypographyToken {
  fontSize: number;
  lineHeight: number;
  maxLines: number;
}

export type DeckTypographyTokenName = 'title' | 'body' | 'caption';
export type TypographyTokenSet = DeepReadonly<Record<DeckTypographyTokenName, TypographyToken>>;

export const DECK_STAGE = deepFreeze({ width: 1600, height: 900 } as const);

export const DECK_SAFE_AREA = deepFreeze({ x: 80, y: 64, width: 1440, height: 772 } as const);

export const STANDARD_ELEMENT_GAP = 24;

/** 唯一持久排版 token 集；枚举在编译时落成这里的具体 px 数值。 */
export const TYPOGRAPHY_TOKENS = deepFreeze({
  title: { fontSize: 64, lineHeight: 68, maxLines: 2 },
  body: { fontSize: 30, lineHeight: 42, maxLines: 8 },
  caption: { fontSize: 24, lineHeight: 32, maxLines: 2 },
} satisfies Record<string, TypographyToken>);

/** profile 字段仍可解析，但不再选择不同字号。 */
export const LEGACY_TYPOGRAPHY_TOKENS = TYPOGRAPHY_TOKENS;
export const V16_TYPOGRAPHY_TOKENS = TYPOGRAPHY_TOKENS;

export type DeckTypographyProfile = 'legacy' | 'v16';

export const typographyTokensForProfile = (
  _profile: DeckTypographyProfile | undefined,
): TypographyTokenSet => TYPOGRAPHY_TOKENS;

const LAYOUT_RULES = deepFreeze([
  'Return exactly one reach-deck/v1 DeckSlide.',
  'Use layout "freeform" for every composition.',
  'Give every element an absolute frame with numeric x, y, width, and height.',
  'Keep every element inside the safe area.',
  'Never overlap non-decorative elements.',
  'Never use scrollbars or shrink below typography tokens.',
  'Create one clear focal point and an intentional reading path.',
  'Group elements by semantic relationship and use visual weight to express hierarchy.',
  'Use whitespace and repeated rhythm to keep the composition legible.',
  'Use decoration only when it has teaching value.',
  'Adapt the supplied layout references to the slide semantics; never copy their coordinates.',
  'Delete optional content when needed to preserve the primary teaching goal and layout quality.',
  'Use only the text, constrained shape, constrained line, and current-page image element types.',
]);

const MANDATORY_LAYOUT_CONTRACT = deepFreeze({
  stage: DECK_STAGE,
  safeArea: DECK_SAFE_AREA,
  gap: STANDARD_ELEMENT_GAP,
  typography: TYPOGRAPHY_TOKENS,
  rules: LAYOUT_RULES,
});

const MANDATORY_LAYOUT_CONTRACT_MARKER = 'MANDATORY REACH DECK V1 LAYOUT CONTRACT';

const stripUntrustedContract = (prompt: string): string => {
  const markerIndex = prompt.indexOf(MANDATORY_LAYOUT_CONTRACT_MARKER);
  return (markerIndex >= 0 ? prompt.slice(0, markerIndex) : prompt).trim();
};

export const composeSlidePrompt = (
  userPrompt: string,
  profile: DeckTypographyProfile = 'legacy',
): string => {
  const editablePrompt = stripUntrustedContract(userPrompt);
  const contract = {
    ...MANDATORY_LAYOUT_CONTRACT,
    typography: typographyTokensForProfile(profile),
  };

  return [editablePrompt, MANDATORY_LAYOUT_CONTRACT_MARKER, JSON.stringify(contract)]
    .filter(Boolean)
    .join('\n\n');
};
