# `@reachany/importer`

Node-runtime, service-neutral import package shared by ReachAny services. The package exposes the
PPTX package/XML/relationship parser through `@reachany/importer/pptx` and the bounded MAIC JSON
parser, offline interactive transform, deterministic Reach Deck v2 mapper, and capability reports
through `@reachany/importer/maic`.

```ts
import { analyzePptxCapabilities, parsePptx } from '@reachany/importer/pptx';

const parsed = await parsePptx(bytes);
if (!parsed.ok) return parsed.diagnostics;

const capabilityReport = analyzePptxCapabilities(parsed.ir);
```

The package does not perform authentication, network calls, object-storage writes, database writes,
queue work, or draft mutation. Binary assets are returned separately from the JSON-safe IR.
It currently uses Node's cryptographic implementation for deterministic SHA-256 hashing; runtime
neutrality here means independence from Reach Deck, OpenMAIC, and AI Runtime service state, not a
browser-compatible bundle.

## Fidelity contract

- Parsing, schema representability, native mapping, rendering, and editability are separate
  capabilities.
- `canApply` is false whenever the selected profile has a blocking diagnostic or an encountered
  unsupported feature.
- Within a canvas page, the first occurrence of an element id keeps that source identity. Later
  occurrences receive collision-free deterministic import identities, retain their unchanged source
  snapshots and z-order, and emit one warning per renamed element instead of dropping the page.
- There is no SVG/PNG screenshot fallback, media transcoding, icon substitution, unknown-object
  coercion, or skipped-node behavior.
- Source IDs and digests contain no random or clock input.
- Missing required package relationships or slide dimensions are errors; the parser does not invent
  fallback dimensions or style chains.

The MAIC mapper exports only the confirmed canvas, quiz, and offline interactive feature slice. It
does not perform media fetches or writes; callers must resolve allowlisted resources before mapping.
It retains short-answer reference answers and emits page warnings when canvas rich-text formatting
is flattened. Valid solid and linear/radial gradient backgrounds plus the confirmed nested
`{type:"image",image:{src,size:"cover"}}` form map to native fills after the caller resolves its
allowlisted media reference. Other image sizes and unknown or malformed backgrounds fall back to
white with an explicit page warning; an unresolved registered background resource is a page error.

## Safety limits

The bounded package reader validates input size, entry count, per-entry and aggregate expanded size,
compression ratio, encrypted entries, canonical paths, duplicate/case-colliding parts, ZIP
signatures, XML size/depth/node limits, DTD/entity declarations, and relationship count/targets.
Callers may provide narrower limits but cannot disable validation by using zero or invalid values.

## Provenance

OpenMAIC's importer architecture is the design reference for this work. Any materially adapted code
must retain a provenance header and the license notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The lossy OpenMAIC application transform and rendering fallback paths are explicitly excluded.
