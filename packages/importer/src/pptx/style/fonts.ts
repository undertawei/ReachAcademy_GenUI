import type { PptxDiagnostic, PptxDiagnosticLocation } from '../diagnostics.js';

export type PptxFontScript = 'latin' | 'eastAsia' | 'complexScript' | 'symbol';

export const PPTX_FONT_SCRIPTS: readonly PptxFontScript[] = Object.freeze([
  'latin',
  'eastAsia',
  'complexScript',
  'symbol',
]);

export interface PptxFontFamilyDefinition {
  readonly family: string;
  readonly aliases: readonly string[];
  readonly scripts: readonly PptxFontScript[];
}

export interface PptxFontSubstitutionRule {
  readonly requestedFamily: string;
  /** Ordered, version-controlled candidates. */
  readonly candidates: readonly string[];
}

export interface PptxFontCatalogInput {
  readonly version: string;
  readonly families: readonly PptxFontFamilyDefinition[];
  readonly substitutions: readonly PptxFontSubstitutionRule[];
  readonly fallbacksByScript: Readonly<Record<PptxFontScript, readonly string[]>>;
}

export interface PptxFontCatalog extends PptxFontCatalogInput {
  readonly families: readonly Readonly<PptxFontFamilyDefinition>[];
  readonly substitutions: readonly Readonly<PptxFontSubstitutionRule>[];
}

export interface PptxThemeFontSet {
  readonly latin: string;
  readonly eastAsia: string;
  readonly complexScript: string;
  readonly symbol: string;
}

export interface PptxThemeFontScheme {
  readonly major: PptxThemeFontSet;
  readonly minor: PptxThemeFontSet;
}

export type PptxFontSource =
  | { readonly kind: 'direct'; readonly family: string }
  | { readonly kind: 'theme'; readonly set: 'major' | 'minor' };

export interface PptxFontRequest {
  readonly source: PptxFontSource;
  readonly script: PptxFontScript;
}

export type PptxFontResolutionReason =
  | 'requested-available'
  | 'theme-resolved'
  | 'catalog-substitution'
  | 'script-fallback';

export interface PptxFontFamilyResolution {
  readonly requestedFamily: string;
  readonly resolvedFamily: string;
  readonly reason: Exclude<PptxFontResolutionReason, 'theme-resolved'>;
}

export interface PptxResolvedFont {
  readonly catalogVersion: string;
  readonly source: PptxFontSource;
  readonly script: PptxFontScript;
  /** Concrete direct or theme-derived family requested by the source document. */
  readonly requestedFamily: string;
  readonly resolvedFamily: string;
  readonly reason: PptxFontResolutionReason;
}

export type PptxFontResolutionResult =
  | {
      readonly ok: true;
      readonly font: PptxResolvedFont;
      readonly diagnostics: readonly PptxDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly PptxDiagnostic[] };

const canonicalFamily = (family: string): string =>
  family.trim().replace(/\s+/g, ' ').toLowerCase();

const requireFamilyName = (family: string, label: string): string => {
  const normalized = family.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) throw new Error(`${label} must be non-empty.`);
  return normalized;
};

export const definePptxFontCatalog = (input: PptxFontCatalogInput): PptxFontCatalog => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.version)) {
    throw new Error('PPTX font catalog version must be a stable non-empty token.');
  }

  const knownNames = new Set<string>();
  const families = input.families.map((family) => {
    const familyName = requireFamilyName(family.family, 'Font family');
    const aliases = family.aliases.map((alias) => requireFamilyName(alias, 'Font alias'));
    const scripts = [...new Set(family.scripts)];
    if (scripts.length === 0 || scripts.some((script) => !PPTX_FONT_SCRIPTS.includes(script))) {
      throw new Error(`Font family ${familyName} must declare recognized scripts.`);
    }
    for (const name of [familyName, ...aliases]) {
      const key = canonicalFamily(name);
      if (knownNames.has(key)) throw new Error(`Duplicate PPTX font catalog name: ${name}`);
      knownNames.add(key);
    }
    return Object.freeze({
      family: familyName,
      aliases: Object.freeze(aliases),
      scripts: Object.freeze(scripts),
    });
  });

  const substitutionKeys = new Set<string>();
  const substitutions = input.substitutions.map((rule) => {
    const requestedFamily = requireFamilyName(rule.requestedFamily, 'Substitution source');
    const key = canonicalFamily(requestedFamily);
    if (substitutionKeys.has(key)) {
      throw new Error(`Duplicate PPTX font substitution rule: ${requestedFamily}`);
    }
    substitutionKeys.add(key);
    const candidates = rule.candidates.map((candidate) =>
      requireFamilyName(candidate, 'Substitution candidate'),
    );
    return Object.freeze({ requestedFamily, candidates: Object.freeze(candidates) });
  });

  const fallbacksByScript = Object.fromEntries(
    PPTX_FONT_SCRIPTS.map((script) => [
      script,
      Object.freeze(
        input.fallbacksByScript[script].map((family) =>
          requireFamilyName(family, `${script} fallback`),
        ),
      ),
    ]),
  ) as Record<PptxFontScript, readonly string[]>;

  return Object.freeze({
    version: input.version,
    families: Object.freeze(families),
    substitutions: Object.freeze(substitutions),
    fallbacksByScript: Object.freeze(fallbacksByScript),
  });
};

const findFamily = (
  catalog: PptxFontCatalog,
  requested: string,
  script: PptxFontScript,
): Readonly<PptxFontFamilyDefinition> | undefined => {
  const key = canonicalFamily(requested);
  return catalog.families.find(
    (family) =>
      family.scripts.includes(script) &&
      [family.family, ...family.aliases].some((name) => canonicalFamily(name) === key),
  );
};

/**
 * Resolve a concrete (already theme-resolved) family name to a catalog family.
 * Returns undefined when neither the catalog, its substitution rules, nor the
 * script fallbacks cover the request — the caller decides whether that blocks.
 */
export const resolvePptxCatalogFamily = (
  catalog: PptxFontCatalog,
  requestedFamily: string,
  script: PptxFontScript,
): PptxFontFamilyResolution | undefined => {
  const requested = requestedFamily.trim().replace(/\s+/g, ' ');
  if (requested.length === 0) return undefined;
  const available = findFamily(catalog, requested, script);
  if (available !== undefined) {
    return {
      requestedFamily: requested,
      resolvedFamily: available.family,
      reason: 'requested-available',
    };
  }
  const substitution = catalog.substitutions.find(
    (rule) => canonicalFamily(rule.requestedFamily) === canonicalFamily(requested),
  );
  const substitutionFamily = substitution?.candidates
    .map((candidate) => findFamily(catalog, candidate, script))
    .find((candidate) => candidate !== undefined);
  if (substitutionFamily !== undefined) {
    return {
      requestedFamily: requested,
      resolvedFamily: substitutionFamily.family,
      reason: 'catalog-substitution',
    };
  }
  const fallbackFamily = catalog.fallbacksByScript[script]
    .map((candidate) => findFamily(catalog, candidate, script))
    .find((candidate) => candidate !== undefined);
  if (fallbackFamily !== undefined) {
    return {
      requestedFamily: requested,
      resolvedFamily: fallbackFamily.family,
      reason: 'script-fallback',
    };
  }
  return undefined;
};

const fontDiagnostic = (
  code: `pptx.font.${string}`,
  severity: 'warning' | 'error',
  message: string,
  details: Readonly<Record<string, string>>,
  location?: PptxDiagnosticLocation,
): PptxDiagnostic => ({
  code,
  severity,
  feature: 'font-substitution',
  message,
  details,
  ...(location ? { location } : {}),
});

const requestedFamilyFor = (request: PptxFontRequest, theme: PptxThemeFontScheme): string =>
  request.source.kind === 'direct'
    ? requireFamilyName(request.source.family, 'Requested font family')
    : requireFamilyName(theme[request.source.set][request.script], 'Theme font family');

export const resolvePptxFont = (
  request: PptxFontRequest,
  catalog: PptxFontCatalog,
  theme: PptxThemeFontScheme,
  location?: PptxDiagnosticLocation,
): PptxFontResolutionResult => {
  if (!PPTX_FONT_SCRIPTS.includes(request.script)) {
    return {
      ok: false,
      diagnostics: [
        fontDiagnostic(
          'pptx.font.unsupported_script',
          'error',
          'The requested PowerPoint font script is unsupported.',
          { script: String(request.script), catalogVersion: catalog.version },
          location,
        ),
      ],
    };
  }

  let requestedFamily: string;
  try {
    requestedFamily = requestedFamilyFor(request, theme);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        fontDiagnostic(
          'pptx.font.request_missing',
          'error',
          error instanceof Error ? error.message : 'The requested font family is missing.',
          { script: request.script, catalogVersion: catalog.version },
          location,
        ),
      ],
    };
  }

  const available = findFamily(catalog, requestedFamily, request.script);
  if (available) {
    return {
      ok: true,
      font: Object.freeze({
        catalogVersion: catalog.version,
        source: request.source,
        script: request.script,
        requestedFamily,
        resolvedFamily: available.family,
        reason: request.source.kind === 'theme' ? 'theme-resolved' : 'requested-available',
      }),
      diagnostics: [],
    };
  }

  const substitution = catalog.substitutions.find(
    (rule) => canonicalFamily(rule.requestedFamily) === canonicalFamily(requestedFamily),
  );
  const substitutionFamily = substitution?.candidates
    .map((candidate) => findFamily(catalog, candidate, request.script))
    .find((candidate) => candidate !== undefined);
  const fallbackFamily = catalog.fallbacksByScript[request.script]
    .map((candidate) => findFamily(catalog, candidate, request.script))
    .find((candidate) => candidate !== undefined);
  const resolvedFamily = substitutionFamily ?? fallbackFamily;
  if (!resolvedFamily) {
    return {
      ok: false,
      diagnostics: [
        fontDiagnostic(
          'pptx.font.unresolved',
          'error',
          `No deterministic ${request.script} substitute is available for ${requestedFamily}.`,
          { requestedFamily, script: request.script, catalogVersion: catalog.version },
          location,
        ),
      ],
    };
  }

  const reason: PptxFontResolutionReason = substitutionFamily
    ? 'catalog-substitution'
    : 'script-fallback';
  const font = Object.freeze({
    catalogVersion: catalog.version,
    source: request.source,
    script: request.script,
    requestedFamily,
    resolvedFamily: resolvedFamily.family,
    reason,
  });
  return {
    ok: true,
    font,
    diagnostics: [
      fontDiagnostic(
        'pptx.font.substituted',
        'warning',
        `Substituted ${requestedFamily} with ${resolvedFamily.family}.`,
        {
          requestedFamily,
          resolvedFamily: resolvedFamily.family,
          reason,
          script: request.script,
          catalogVersion: catalog.version,
        },
        location,
      ),
    ],
  };
};
