/** Only schema-owned paths and static descriptions may enter provider feedback or worker logs. */
export const OUTLINE_DIAGNOSTIC_MAX_ISSUES = 16;
export const OUTLINE_DIAGNOSTIC_MAX_BYTES = 8192;
const MAX_NODES = 6000;
const MAX_DEPTH = 48;
const MAX_ARRAY_ITEMS = 200;

const DESCRIPTIONS = {
  'schema-shape': 'No allowed shape matched; use the required object variant.',
  'schema-enum': 'Invalid enum; use one of the schema values.',
  'schema-literal': 'Invalid literal; use the schema constant.',
  'schema-type': 'Incorrect value type; use the type required by the schema.',
  'schema-required': 'Required field is missing; include it using the schema type.',
  'schema-unknown-field': 'Unknown field; remove properties not declared by the schema.',
  'schema-array-size': 'invalid array size; satisfy the schema item limits.',
  'schema-string-length': 'invalid Unicode character length; satisfy the schema text limits.',
  'schema-number': 'Invalid number; satisfy the schema numeric bounds.',
  'asset-prompt-invalid': 'Provide nonempty plain text within the planned asset prompt limit.',
  'asset-invalid': 'Provide a complete planned visual asset matching its selected kind.',
  'reference-invalid': 'Use a reference ID from this field’s category in the supplied library.',
  'reference-duplicate': 'Remove the duplicate reference ID within this field.',
  'page-invalid': 'This page failed canonical validation; satisfy every page contract field.',
  'page-too-large': 'Page exceeds 32 KiB limit; shorten the page planning content.',
  'frozen-context-mismatch': 'Preserve the frozen generation design context exactly.',
  'outline-invalid': 'Outline failed canonical validation; satisfy the complete outline contract.',
} as const;
export type OutlineValidationIssueCode = keyof typeof DESCRIPTIONS;
export interface OutlineValidationIssue {
  /** JSON-style path; page and asset array indexes are zero-based. */
  readonly path: string;
  readonly code: OutlineValidationIssueCode;
  readonly message: string;
}

export class OutlineValidationError extends Error {
  readonly code = 'structure-invalid';
  constructor(
    readonly issues: readonly OutlineValidationIssue[],
    readonly truncated: boolean,
  ) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'OutlineValidationError';
  }
}

export class OutlineIssueCollector {
  readonly issues: OutlineValidationIssue[] = [];
  truncated = false;
  constructor(private readonly budget = { nodes: 0 }) {}
  fork(): OutlineIssueCollector {
    return new OutlineIssueCollector(this.budget);
  }
  private bytes = 0;
  visit(depth = 0): boolean {
    if (++this.budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
      this.truncated = true;
      return false;
    }
    return true;
  }
  /** Preflight semantic parsers/JSON serialization with bounded depth, nodes and text. */
  canInspect(value: unknown, maxTextUnits: number): boolean {
    let textUnits = 0;
    const walk = (child: unknown, depth: number): boolean => {
      if (!this.visit(depth)) return false;
      if (typeof child === 'string') textUnits += child.length;
      if (textUnits > maxTextUnits) return false;
      if (child && typeof child === 'object') {
        for (const key in child) {
          textUnits += key.length;
          if (textUnits > maxTextUnits || !walk((child as Record<string, unknown>)[key], depth + 1))
            return false;
        }
      }
      return true;
    };
    const bounded = walk(value, 0);
    if (!bounded) this.truncated = true;
    return bounded;
  }
  add(path: string, code: OutlineValidationIssueCode): void {
    if (this.issues.some((issue) => issue.path === path && issue.code === code)) return;
    const issue = { path, code, message: DESCRIPTIONS[code] };
    const bytes = Buffer.byteLength(JSON.stringify(issue), 'utf8') + 1;
    if (
      this.issues.length >= OUTLINE_DIAGNOSTIC_MAX_ISSUES ||
      this.bytes + bytes > OUTLINE_DIAGNOSTIC_MAX_BYTES - 128
    ) {
      this.truncated = true;
      return;
    }
    this.bytes += bytes;
    this.issues.push(issue);
  }
  error(): OutlineValidationError {
    if (!this.issues.length) this.add('outline', 'outline-invalid');
    return new OutlineValidationError(this.issues, this.truncated);
  }
}

type Schema = Record<string, any>;
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Diagnostic-only schema walk. Acceptance remains owned by the existing strict parser. */
export function collectOutlineSchemaIssues(
  value: unknown,
  schema: Schema,
  root: Schema,
  path: string,
  collector: OutlineIssueCollector,
  depth = 0,
): void {
  if (!collector.visit(depth)) return;
  if (schema.$ref) {
    const target = root.$defs[schema.$ref.split('/').at(-1)];
    collectOutlineSchemaIssues(value, target, root, path, collector, depth + 1);
    return;
  }
  if (schema.anyOf) {
    const resolve = (branch: Schema): Schema =>
      branch.$ref ? root.$defs[branch.$ref.split('/').at(-1)] : branch;
    const branches: Schema[] = schema.anyOf.map(resolve);
    let matching = branches.filter((branch) => {
      if (branch.type === 'null') return value === null;
      if (value === null) return false;
      if (!record(value) || !branch.properties) return true;
      // Route identity is distinct from constraints within a route. In particular, an invalid
      // code format must stay on the code route so feedback can identify the format field.
      // Enum routes (svg/html/geometry) must not act as a catch-all for typed diagrams.
      return ['sceneType', 'kind', 'representation'].every((key) => {
        const route = branch.properties[key] as Schema | undefined;
        if (route?.const !== undefined) return value[key] === route.const;
        if (route?.enum) return route.enum.includes(value[key]);
        return true;
      });
    });
    // Within a route family, preserve a recognized finite discriminator (for example GIF vs
    // JPG or scatter vs polyline) even when that variant has more missing/invalid fields.
    // If the supplied discriminator is itself invalid, keep the family for field-level feedback.
    if (record(value) && matching.length > 1) {
      for (const key of Object.keys(matching[0]!.properties ?? {})) {
        if (!Object.hasOwn(value, key)) continue;
        const choices = matching.map((branch) => {
          const field = branch.properties?.[key] as Schema | undefined;
          return field?.const !== undefined ? [field.const] : field?.enum;
        });
        if (!choices.every(Array.isArray)) continue;
        const recognized = matching.filter((_branch, index) =>
          choices[index]!.includes(value[key]),
        );
        if (recognized.length) matching = recognized;
      }
    }
    // Strict variants can also be selected by a declared field, such as animation. Preserve
    // that explicit intent instead of preferring a sibling that merely asks to delete the field.
    // Iterate schema-owned keys only: arbitrary unknown model properties never select a branch.
    if (
      record(value) &&
      matching.length > 1 &&
      matching.every((branch) => branch.additionalProperties === false)
    ) {
      const declared = new Set(matching.flatMap((branch) => Object.keys(branch.properties ?? {})));
      for (const key of declared) {
        if (!Object.hasOwn(value, key)) continue;
        const supporting = matching.filter((branch) => Object.hasOwn(branch.properties, key));
        if (supporting.length) matching = supporting;
      }
    }
    if (matching.length === 1) {
      collectOutlineSchemaIssues(value, matching[0]!, root, path, collector, depth + 1);
    } else if (matching.length > 1) {
      // Some variants share discriminants (static/animated function plots). Probe the complete
      // shapes with a shared traversal budget; a valid alternative must not produce feedback.
      let best: OutlineIssueCollector | undefined;
      for (const branch of matching) {
        const probe = collector.fork();
        collectOutlineSchemaIssues(value, branch, root, path, probe, depth + 1);
        if (probe.truncated) {
          collector.truncated = true;
          return; // An unfinished alternative is not evidence that this union is invalid.
        }
        if (!probe.issues.length) return;
        if (!best || probe.issues.length < best.issues.length) best = probe;
      }
      if (best?.issues.length) {
        for (const issue of best.issues) collector.add(issue.path, issue.code);
      } else collector.add(path, 'schema-shape');
    } else collector.add(path, 'schema-shape');
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) collector.add(path, 'schema-enum');
  if (schema.const !== undefined && value !== schema.const) collector.add(path, 'schema-literal');
  if (schema.type === 'object') {
    if (!record(value)) return collector.add(path, 'schema-type');
    for (const key of schema.required ?? []) {
      if (!(key in value)) collector.add(`${path}.${key}`, 'schema-required');
    }
    // Do not put arbitrary model property names into a diagnostic path.
    for (const key in value) {
      if (!collector.visit(depth)) break;
      if (!Object.hasOwn(schema.properties, key)) collector.add(path, 'schema-unknown-field');
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key))
        collectOutlineSchemaIssues(
          value[key],
          child as Schema,
          root,
          `${path}.${key}`,
          collector,
          depth + 1,
        );
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return collector.add(path, 'schema-type');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity))
      collector.add(path, 'schema-array-size');
    if (value.length > MAX_ARRAY_ITEMS) collector.truncated = true;
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index++)
      collectOutlineSchemaIssues(
        value[index],
        schema.items,
        root,
        `${path}[${index}]`,
        collector,
        depth + 1,
      );
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return collector.add(path, 'schema-type');
    // Count only as far as needed, without allocating a copy of untrusted text.
    let length = 0;
    const countLimit = schema.maxLength ?? schema.minLength ?? 0;
    for (const _character of value) {
      if (++length > countLimit) break;
    }
    if (length > (schema.maxLength ?? Infinity) || length < (schema.minLength ?? 0))
      collector.add(path, 'schema-string-length');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity) ||
      (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
    )
      collector.add(path, 'schema-number');
  } else if (
    (schema.type === 'boolean' && typeof value !== 'boolean') ||
    (schema.type === 'null' && value !== null)
  )
    collector.add(path, 'schema-type');
}
