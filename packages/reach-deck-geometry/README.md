# Reach Deck Geometry Evaluator

Candidate P1 numerical engine for `reach-euclidean-geometry/v1`. This package does not register
Player assets or enable generation/publication of the candidate kits.

`createGeometryEngine(envelope)` validates the canonical DSL envelope and creates one JSXGraph
1.13.2 graph with NoRenderer. Native points, line directions, ordered plane frames, circles and
transformations own all geometric state. Snapshots are deeply frozen derived data. The module
does not export JSXGraph, native objects, a DOM shim, or a mutable coordinate map.

- `snapshot()` returns revision, validity, input values, public object geometry, measurements,
  passive assertion results and at most 32 diagnostics.
- `applyInputs({ parameters, freedoms })` validates the entire batch before adopting it.
  Parameter IDs must appear in `interaction.parameters`; freedom IDs must be declared.
  Free points take `{ x, y }`, plane coordinates take `{ u, v }`, translations take exactly their
  declared axes, and line/circle freedoms take a number. Shared parameter aliases cannot receive
  conflicting values. Values need not align to the UI step.
- `reset()` restores initial inputs and increments revision.
- `dispose()` releases native objects; subsequent state operations fail. Call it in `finally`.
- `evaluateGeometry(envelope)` returns `{ valid, diagnostics, snapshot }` and always disposes.

Undefined scalar and geometry states remain recoverable. Their dependents expose null coordinates
or values and canonical reason codes. Defined false assertions produce `assertion_failed` without
moving geometry. Publication validation checks initial numerical validity, which is distinct from
allowing a learner to explore and recover from a declared degenerate input state.

The `./worker` export resolves to the bundled trusted ESM asset `dist/worker.mjs`, containing the
engine, DSL and JSXGraph. It sends `ready`, accepts one `evaluate` message containing 1-4 validated
markers, and emits only bounded per-instance validity/diagnostics or `failed`. The caller owns
authentication, digest binding, body limits, deadline enforcement and termination. Import
`resolveGeometryWorkerPath` from `./worker-path` to resolve this asset from an external package
without loading the engine into the API process.

Server code that evaluates geometry synchronously imports `createGeometryEngine` or
`evaluateGeometry` from `./server`. This separate Node ESM bundle resolves JSXGraph module interop
consistently for native Node and TypeScript loaders. It does not change the browser runtime assets.

Run from the repository root:

```sh
pnpm --filter @reachany/reach-deck-geometry build
pnpm --filter @reachany/reach-deck-geometry lint
pnpm --filter @reachany/reach-deck-geometry test
```

Tests consume shared DSL fixtures and cover all frozen operations, atomic updates, 1,000 seeded
analytical cases, degeneracy/recovery, native lifecycle, fresh-process replay and the bundled
Worker. JSXGraph is pinned and distributed under its MIT or LGPL-3.0-or-later license; the Worker
bundle retains upstream legal comments.
