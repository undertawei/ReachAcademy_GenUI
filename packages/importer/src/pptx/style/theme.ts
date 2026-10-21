import type { PptxDiagnostic } from '../diagnostics.js';
import type { PptxParseFailure } from '../ir.js';
import type { PptxXmlElement } from '../package/xml.js';

export interface PptxThemeColorIR {
  readonly token: string;
  readonly sourceKind: 'srgb' | 'system';
  /** Deterministic six-digit sRGB value used after resolving system colors. */
  readonly value: string;
  readonly systemName?: string;
}

export interface PptxThemeColorSchemeIR {
  readonly name?: string;
  readonly colors: Readonly<Record<string, PptxThemeColorIR>>;
}

export interface PptxThemeFontFaceIR {
  readonly typeface: string;
  readonly panose?: string;
  readonly pitchFamily?: string;
  readonly charset?: string;
}

export interface PptxThemeFontSetIR {
  readonly latin?: PptxThemeFontFaceIR;
  readonly eastAsia?: PptxThemeFontFaceIR;
  readonly complexScript?: PptxThemeFontFaceIR;
  readonly supplemental: Readonly<Record<string, string>>;
}

export interface PptxThemeFontSchemeIR {
  readonly name?: string;
  readonly major: PptxThemeFontSetIR;
  readonly minor: PptxThemeFontSetIR;
}

export interface PptxThemeStyleIR {
  readonly colorScheme?: PptxThemeColorSchemeIR;
  readonly fontScheme?: PptxThemeFontSchemeIR;
}

export type PptxThemeStyleResult =
  | { readonly ok: true; readonly style: PptxThemeStyleIR }
  | PptxParseFailure;

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const childrenByLocalName = (element: PptxXmlElement, name: string): PptxXmlElement[] =>
  element.children.filter(
    (child) => localName(child.name) === name && child.namespaceUri === element.namespaceUri,
  );

const onlyChild = (
  parent: PptxXmlElement,
  name: string,
  partPath: string,
): PptxXmlElement | undefined | PptxParseFailure => {
  const children = childrenByLocalName(parent, name);
  if (children.length <= 1) return children[0];
  return failure(
    'pptx.theme.ambiguous_structure',
    `Theme contains more than one ${name} element.`,
    partPath,
  );
};

const isFailure = (
  value: PptxXmlElement | undefined | PptxParseFailure,
): value is PptxParseFailure => Boolean(value && 'ok' in value);

const failure = (code: `pptx.${string}`, message: string, partPath: string): PptxParseFailure => ({
  ok: false,
  diagnostics: [
    {
      code,
      severity: 'fatal',
      feature: 'theme',
      message,
      location: { partPath },
    } satisfies PptxDiagnostic,
  ],
});

const normalizedHex = (value: string | undefined): string | undefined => {
  if (!value || !/^[0-9a-f]{6}$/i.test(value)) return undefined;
  return value.toUpperCase();
};

const parseColorScheme = (
  colorScheme: PptxXmlElement,
  partPath: string,
): PptxThemeColorSchemeIR | PptxParseFailure => {
  const colors: Record<string, PptxThemeColorIR> = {};
  for (const colorSlot of colorScheme.children) {
    const token = localName(colorSlot.name);
    if (token in colors) {
      return failure(
        'pptx.theme.duplicate_color_token',
        `Theme color scheme contains duplicate token ${token}.`,
        partPath,
      );
    }
    if (colorSlot.children.length !== 1) {
      return failure(
        'pptx.theme.invalid_color',
        `Theme color ${token} must contain exactly one color value.`,
        partPath,
      );
    }
    const color = colorSlot.children[0]!;
    switch (localName(color.name)) {
      case 'srgbClr': {
        const value = normalizedHex(color.attributes.val);
        if (!value) {
          return failure(
            'pptx.theme.invalid_srgb_color',
            `Theme color ${token} has an invalid sRGB value.`,
            partPath,
          );
        }
        colors[token] = { token, sourceKind: 'srgb', value };
        break;
      }
      case 'sysClr': {
        const value = normalizedHex(color.attributes.lastClr);
        const systemName = color.attributes.val?.trim();
        if (!value || !systemName) {
          return failure(
            'pptx.theme.unresolved_system_color',
            `Theme system color ${token} requires both val and deterministic lastClr.`,
            partPath,
          );
        }
        colors[token] = { token, sourceKind: 'system', value, systemName };
        break;
      }
      default:
        return failure(
          'pptx.theme.unsupported_color_kind',
          `Theme color ${token} uses unsupported ${localName(color.name)} semantics.`,
          partPath,
        );
    }
  }
  if (Object.keys(colors).length === 0) {
    return failure(
      'pptx.theme.empty_color_scheme',
      'Theme color scheme must contain at least one color.',
      partPath,
    );
  }
  return {
    ...(colorScheme.attributes.name ? { name: colorScheme.attributes.name } : {}),
    colors,
  };
};

const parseFontFace = (element: PptxXmlElement): PptxThemeFontFaceIR | undefined => {
  const typeface = element.attributes.typeface?.trim();
  if (!typeface) return undefined;
  return {
    typeface,
    ...(element.attributes.panose ? { panose: element.attributes.panose } : {}),
    ...(element.attributes.pitchFamily ? { pitchFamily: element.attributes.pitchFamily } : {}),
    ...(element.attributes.charset ? { charset: element.attributes.charset } : {}),
  };
};

const parseFontSet = (
  fontSet: PptxXmlElement,
  partPath: string,
): PptxThemeFontSetIR | PptxParseFailure => {
  const roleByElement = {
    latin: 'latin',
    ea: 'eastAsia',
    cs: 'complexScript',
  } as const;
  const faces: Partial<
    Record<(typeof roleByElement)[keyof typeof roleByElement], PptxThemeFontFaceIR>
  > = {};
  const supplemental: Record<string, string> = {};
  for (const child of fontSet.children) {
    const name = localName(child.name);
    if (name in roleByElement) {
      const role = roleByElement[name as keyof typeof roleByElement];
      if (faces[role]) {
        return failure(
          'pptx.theme.duplicate_font_face',
          `Theme font set contains duplicate ${name} face.`,
          partPath,
        );
      }
      const face = parseFontFace(child);
      if (face) faces[role] = face;
      continue;
    }
    if (name !== 'font') continue;
    const script = child.attributes.script?.trim();
    const typeface = child.attributes.typeface?.trim();
    if (!script || !typeface) {
      return failure(
        'pptx.theme.invalid_supplemental_font',
        'Theme supplemental fonts require non-empty script and typeface attributes.',
        partPath,
      );
    }
    if (script in supplemental) {
      return failure(
        'pptx.theme.duplicate_font_script',
        `Theme font set contains duplicate supplemental script ${script}.`,
        partPath,
      );
    }
    supplemental[script] = typeface;
  }
  return { ...faces, supplemental };
};

const parseFontScheme = (
  fontScheme: PptxXmlElement,
  partPath: string,
): PptxThemeFontSchemeIR | PptxParseFailure => {
  const majorElement = onlyChild(fontScheme, 'majorFont', partPath);
  if (isFailure(majorElement)) return majorElement;
  const minorElement = onlyChild(fontScheme, 'minorFont', partPath);
  if (isFailure(minorElement)) return minorElement;
  if (!majorElement || !minorElement) {
    return failure(
      'pptx.theme.incomplete_font_scheme',
      'Theme font scheme requires exactly one majorFont and one minorFont.',
      partPath,
    );
  }
  const major = parseFontSet(majorElement, partPath);
  if ('ok' in major) return major;
  const minor = parseFontSet(minorElement, partPath);
  if ('ok' in minor) return minor;
  return {
    ...(fontScheme.attributes.name ? { name: fontScheme.attributes.name } : {}),
    major,
    minor,
  };
};

/** Project deterministic theme colors/fonts while retaining the complete XML in the parent IR. */
export const parsePptxThemeStyle = (
  theme: PptxXmlElement,
  partPath: string,
): PptxThemeStyleResult => {
  const themeElements = onlyChild(theme, 'themeElements', partPath);
  if (isFailure(themeElements)) return themeElements;
  if (!themeElements) return { ok: true, style: {} };
  const colorSchemeElement = onlyChild(themeElements, 'clrScheme', partPath);
  if (isFailure(colorSchemeElement)) return colorSchemeElement;
  const fontSchemeElement = onlyChild(themeElements, 'fontScheme', partPath);
  if (isFailure(fontSchemeElement)) return fontSchemeElement;
  const colorScheme = colorSchemeElement
    ? parseColorScheme(colorSchemeElement, partPath)
    : undefined;
  if (colorScheme && 'ok' in colorScheme) return colorScheme;
  const fontScheme = fontSchemeElement ? parseFontScheme(fontSchemeElement, partPath) : undefined;
  if (fontScheme && 'ok' in fontScheme) return fontScheme;
  return {
    ok: true,
    style: {
      ...(colorScheme ? { colorScheme } : {}),
      ...(fontScheme ? { fontScheme } : {}),
    },
  };
};
