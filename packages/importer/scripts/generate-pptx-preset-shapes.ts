/**
 * Regenerate `src/pptx/geometry/presetShapeDefinitions.generated.ts` from the
 * DrawingML preset shape definitions published with the OOXML standard
 * (ECMA-376 Part 1 Annex D / ISO-IEC 29500-1 electronic insert
 * `OfficeOpenXML-DrawingMLGeometries.zip`, file `presetShapeDefinitions.xml`).
 *
 *   npx tsx packages/importer/scripts/generate-pptx-preset-shapes.ts \
 *     <path-to-presetShapeDefinitions.xml>
 *
 * The source XML is not vendored: it is a standards document artifact that the
 * generated table derives from, and the generator only runs when the standard
 * revision changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { XMLParser } from 'fast-xml-parser';

interface OrderedNode {
  readonly [key: string]: unknown;
}

const COMMAND_LETTERS: Readonly<Record<string, string>> = {
  moveTo: 'M',
  lnTo: 'L',
  cubicBezTo: 'C',
  quadBezTo: 'Q',
  arcTo: 'A',
  close: 'Z',
};

const sourcePath = process.argv[2];
if (sourcePath === undefined) {
  throw new Error('Usage: tsx scripts/generate-pptx-preset-shapes.ts <presetShapeDefinitions.xml>');
}

const parser = new XMLParser({
  attributeNamePrefix: '@',
  ignoreAttributes: false,
  preserveOrder: true,
  parseAttributeValue: false,
  trimValues: true,
});

const localName = (name: string): string => name.replace(/^.*:/, '');
const childrenOf = (node: OrderedNode): OrderedNode[] => {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@') || key === ':@' || key === '#text') continue;
    if (Array.isArray(value)) return value as OrderedNode[];
  }
  return [];
};
const tagOf = (node: OrderedNode): string => {
  for (const key of Object.keys(node)) {
    if (key.startsWith('@') || key === ':@' || key === '#text') continue;
    return localName(key);
  }
  return '';
};
const attributesOf = (node: OrderedNode): Readonly<Record<string, string>> => {
  const raw = (node[':@'] ?? {}) as Readonly<Record<string, string>>;
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('@')) continue;
    const name = localName(key.slice(1));
    if (name === 'xmlns') continue;
    attributes[name] = String(value);
  }
  return attributes;
};

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const parsed = parser.parse(readFileSync(resolve(sourcePath), 'utf8')) as OrderedNode[];
const root = parsed.find((node) => tagOf(node).startsWith('presetShapeDefinit'));
if (root === undefined) throw new Error('presetShapeDefinitons root element not found.');

const shapes: string[] = [];
for (const shape of childrenOf(root)) {
  const name = tagOf(shape);
  if (name.length === 0) continue;
  const adjust: string[] = [];
  const guides: string[] = [];
  const paths: string[] = [];
  for (const section of childrenOf(shape)) {
    const sectionName = tagOf(section);
    if (sectionName === 'avLst' || sectionName === 'gdLst') {
      for (const guide of childrenOf(section)) {
        if (tagOf(guide) !== 'gd') continue;
        const { name: guideName, fmla } = attributesOf(guide);
        if (guideName === undefined || fmla === undefined) continue;
        (sectionName === 'avLst' ? adjust : guides).push(
          sectionName === 'avLst'
            ? `${JSON.stringify(guideName)}: ${quote(fmla)}`
            : `[${quote(guideName)}, ${quote(fmla)}]`,
        );
      }
      continue;
    }
    if (sectionName !== 'pathLst') continue;
    for (const path of childrenOf(section)) {
      if (tagOf(path) !== 'path') continue;
      const attributes = attributesOf(path);
      const commands: string[] = [];
      for (const command of childrenOf(path)) {
        const letter = COMMAND_LETTERS[tagOf(command)];
        if (letter === undefined) {
          throw new Error(`Unsupported path command ${tagOf(command)} in ${name}.`);
        }
        if (letter === 'A') {
          const { wR, hR, stAng, swAng } = requiredAttributes(command, [
            'wR',
            'hR',
            'stAng',
            'swAng',
          ]);
          commands.push(`['A', ${quote(wR)}, ${quote(hR)}, ${quote(stAng)}, ${quote(swAng)}]`);
          continue;
        }
        if (letter === 'Z') {
          commands.push(`['Z']`);
          continue;
        }
        const coordinates: string[] = [];
        for (const point of childrenOf(command)) {
          if (tagOf(point) !== 'pt') continue;
          const { x, y } = attributesOf(point);
          if (x === undefined || y === undefined) {
            throw new Error(`Point without coordinates in ${name}.`);
          }
          coordinates.push(quote(x), quote(y));
        }
        commands.push(`['${letter}', ${coordinates.join(', ')}]`);
      }
      const pathFields: string[] = [];
      if (attributes.w !== undefined) pathFields.push(`w: ${quote(attributes.w)}`);
      if (attributes.h !== undefined) pathFields.push(`h: ${quote(attributes.h)}`);
      if (attributes.fill !== undefined) pathFields.push(`fill: ${quote(attributes.fill)}`);
      if (attributes.stroke === 'false' || attributes.stroke === '0') {
        pathFields.push('stroke: false');
      }
      pathFields.push(`commands: [${commands.join(', ')}]`);
      paths.push(`{ ${pathFields.join(', ')} }`);
    }
  }
  const fields: string[] = [];
  if (adjust.length > 0) fields.push(`adjust: { ${adjust.join(', ')} }`);
  if (guides.length > 0) fields.push(`guides: [${guides.join(', ')}]`);
  fields.push(`paths: [${paths.join(', ')}]`);
  shapes.push(`  ${JSON.stringify(name)}: { ${fields.join(', ')} },`);
}

function requiredAttributes(node: OrderedNode, names: readonly string[]): Record<string, string> {
  const attributes = attributesOf(node);
  const required: Record<string, string> = {};
  for (const attribute of names) {
    const value = attributes[attribute];
    if (value === undefined) throw new Error(`Missing ${attribute} attribute.`);
    required[attribute] = value;
  }
  return required;
}

const output = `/**
 * DrawingML preset shape definitions, generated by
 * \`scripts/generate-pptx-preset-shapes.ts\` from the preset geometry table
 * published with the OOXML standard (ECMA-376 Part 1 Annex D /
 * ISO-IEC 29500-1, \`presetShapeDefinitions.xml\`). Do not edit by hand.
 *
 * Guide formulas and path coordinates stay verbatim standard tokens; they are
 * evaluated per shape extent by \`./formula.ts\` and emitted as SVG by
 * \`./preset-shapes.ts\`.
 */
import type { PptxPresetShapeDefinition } from './preset-shapes.js';

export const PPTX_PRESET_SHAPE_DEFINITIONS: Readonly<Record<string, PptxPresetShapeDefinition>> = {
${shapes.join('\n')}
};
`;

const target = resolve(
  import.meta.dirname,
  '../src/pptx/geometry/presetShapeDefinitions.generated.ts',
);
writeFileSync(target, output, 'utf8');
process.stdout.write(`${shapes.length} preset shapes written to ${target}\n`);
