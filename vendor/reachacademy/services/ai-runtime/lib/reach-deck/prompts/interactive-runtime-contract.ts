export const INTERACTIVE_SCIENCE_KIT_DETAILS = {
  'geometry-board':
    'geometry-board: schemaVersion reach-geometry-board/v1, ariaLabel, viewport {x:[min,max],y:[min,max],grid}, points [{id,label?,x,y,draggable}], shapes (segment/line/ray/vector with from/to; circle with center/through; polygon with pointIds; all with id/colorToken), measurements [].',
  'mechanics-2d':
    'mechanics-2d: schemaVersion reach-mechanics-2d/v1, ariaLabel, world {width,height,gravity:{x,y},fixedStepHz:60}, bodies use the flat discriminator shape:"circle" with radius or shape:"box" with width and height, followed by position:{x,y}, angle, velocity:{x,y}, angularVelocity, isStatic, mass, friction, restitution, colorToken; never nest shape dimensions. constraints use {id,bodyA,bodyB,anchorA:{x,y},anchorB:{x,y},length,stiffness,damping,colorToken}; parameters use {id,label,minimum,maximum,step,initial,target:{kind,targetId?}}, where kind is gravity-x|gravity-y|body-mass|body-velocity-x|body-velocity-y|body-restitution|constraint-stiffness.',
  'molecule-2d':
    'molecule-2d: schemaVersion reach-molecule-2d/v1, ariaLabel, layout single|comparison|grid, molecules [{id,label,smiles,highlights:[]}], selectionMode none|atom|bond.',
  'bio-network':
    'bio-network: schemaVersion reach-bio-network/v1, ariaLabel, layout grid|circle|concentric|breadthfirst, nodes [{id,label,group?,colorToken}], edges [{id,source,target,label?,relation,colorToken}], interaction {selectable,draggable,zoomable}.',
  'geo-map':
    'geo-map: schemaVersion reach-geo-map/v1, ariaLabel, baseMapId world-110m-v1, projection {kind,center:[lon,lat],rotate:[lambda,phi,gamma]}, layers (points/path/graticule), interaction {pan,zoom,rotate}.',
  'solid-3d':
    'solid-3d: schemaVersion reach-solid-3d/v1, ariaLabel, camera, solids [{id,kind,position:[x,y,z],rotation:[x,y,z],colorToken,opacity,...dimensions}], measurements [], interaction {orbit,zoom,selectable}; kind is exactly box|sphere|cylinder|cone|regular-prism|regular-pyramid, box uses dimensions:[width,height,depth], sphere uses radius, cylinder/cone use radius and height, and regular-prism/regular-pyramid use radius, height, and integer sides.',
  'molecule-3d':
    'molecule-3d: schemaVersion reach-molecule-3d/v1, ariaLabel, structures [{id,label,format:pdb|sdf|mol2,data}], representations [{id,structureId,style:line|stick|sphere|cartoon,colorScheme}], selections [], interaction {orbit,zoom,selectableAtoms}; data is inline and bounded, never a URL.',
  'sequence-track':
    'sequence-track: schemaVersion reach-sequence-track/v1, ariaLabel, alphabet protein|dna|rna, uppercase sequence, tracks [{id,label,features}], interaction {zoom,pan,selectable}; feature coordinates are one-based.',
  'dynamic-geometry':
    'dynamic-geometry: schemaVersion reach-dynamic-geometry/v1, ariaLabel, board {boundingBox:[xmin,ymax,xmax,ymin],axes,grid,snapSize}, points [{id,label?,x,y,mobility:fixed|free}], constructions use kind (never type or a generic points array): segment|line|ray|vector use {id,kind,from,to,colorToken}, circle uses center/through, polygon uses pointIds, midpoint uses a/b, intersection uses firstObject/secondObject/branch, and parallel|perpendicular use through/line; measurements []. IDs use letters/digits/underscore, references must exist, and colorToken is ink|muted|accent|success|warning.',
} as const;

export const INTERACTIVE_SCIENCE_KIT_EVENTS = {
  'geometry-board': 'geometry-board and dynamic-geometry {kind:"point-moved",pointId,x,y}',
  'dynamic-geometry': 'geometry-board and dynamic-geometry {kind:"point-moved",pointId,x,y}',
  'mechanics-2d':
    'mechanics-2d {kind:"parameter",parameterId,value} or {kind:"body-moved",bodyId,x,y,angle}',
  'solid-3d': 'solid-3d and molecule-3d {kind:"view",...}',
  'molecule-3d': 'solid-3d and molecule-3d {kind:"view",...}',
  'geo-map': 'geo-map {kind:"rotation",rotation}, {kind:"pan",center}, or {kind:"zoom",scale}',
  'sequence-track':
    'sequence-track {kind:"pan",scrollLeft,zoom}, {kind:"zoom",zoom}, or {kind:"feature-selected",trackId,featureId,start,end,selectedFeatureIds}',
  'molecule-2d':
    'molecule-2d atom selection {kind:"atom-selected",moleculeId,atomId,element,neighborCount,carbonNeighborCount,selectedCount,total} and bond selection {kind:"bond-selected",moleculeId,bondId,sourceAtomId,targetAtomId,sourceElement,targetElement,bondOrder,selectedCount,total}',
  'bio-network':
    'bio-network {kind:"node-selected"|"node-unselected",nodeId,selected,incomingIds,outgoingIds,undirectedIds} or {kind:"node-moved",nodeId,x,y}.',
} as const;

export const OFFLINE_RUNTIME_REGISTRY = `OFFLINE RUNTIME REGISTRY
- Always return runtimeDependencies as an array containing only the exact pinned runtimes the document actually uses. General entries are { "id": "tailwind-browser", "version": "4.3.0" }, { "id": "animate-css", "version": "4.1.1" }, { "id": "expression", "version": "3.0.3" }, and { "id": "function-plot", "version": "1.25.4" }. Approved science-kit entries are geometry-mathigon, mechanics-matter, molecule-smiles, network-cytoscape, geo-d3, solid-three, molecule-3dmol, sequence-nightingale, and geometry-jsxgraph, each at version 1.0.0. Use [] when none are needed. Never invent another id or version.
- animate-css provides the bundled animate.css classes such as animate__animated and animate__fadeIn. Respect prefers-reduced-motion and do not use animation as the only feedback.
- expression provides window.ReachExpression.evaluate(source, variables), returning one finite number. Expressions are at most 512 characters and variables are a bounded map of finite numbers with simple identifiers; member access, assignment, function definitions, randomness, and undeclared symbols are rejected.
- function-plot is available only through the declarative marker contract below. Every function-plot marker requires the function-plot dependency, and that dependency must not be declared without a marker.
- The host injects only the requested pinned runtimes. External CDN or package URLs, network access, workers, and dynamic imports remain forbidden.`;

export const BUILT_IN_TAILWIND_AUTHORING = `BUILT-IN TAILWIND AUTHORING
- Tailwind is optional. Plain CSS, existing pages without Tailwind, and class names containing colons or brackets remain valid; never infer Tailwind intent from class-name syntax. Declare only capabilities the document actually uses.
- To use Tailwind, put exactly one marker on the sole authored HTML root, written as <html data-reach-tailwind-runtime="4.3.0">, and include exactly one runtime dependency { "id": "tailwind-browser", "version": "4.3.0" }. The marker and dependency must either both be absent or form that exact pair. Never emit only one, a wrong version, a duplicate, an extra field on the dependency, another authored HTML root, or a marker on a nested element or body.
- This is the existing host-served, pinned, offline Tailwind browser runtime. Never add a CDN, package URL, external stylesheet, script source, or second Tailwind runtime path.
- Do not write tailwind.config, globalThis.tailwind configuration, or equivalent global configuration. Do not author Tailwind config or plugins, @config, @plugin, @import, @reference, or arbitrary utilities containing url(...). These restrictions supplement all existing no-network, inline-only, and deterministic-runtime rules.
- Use Tailwind, when selected, to build polished but subject-appropriate visual hierarchy and responsive rearrangement or shrinkability across desktop and narrow widths. Required controls and content must remain usable before Tailwind compilation completes. Give controls clear visible focus, hover, active, and selected feedback without depending on hover alone.
- Tailwind preflight and cascade layers apply. When combining utilities with explicit author CSS, never define the same property on the same element in both an unlayered author rule and a utility. Use explicit author CSS for stable initial geometry and bounded keyframes only where needed; keep ownership of each property unambiguous.
- Use meaningful, bounded animation only when it makes a learner-driven state change or conceptual relationship easier to perceive. Provide an equivalent visible state without animation and an explicit @media (prefers-reduced-motion: reduce) alternative; animation must never be the only feedback.`;

export const BUILT_IN_SCIENCE_KITS = `BUILT-IN SCIENCE KITS
- Only when choosing a science kit, add exactly one non-script target with data-reach-science-kit-target="instance-id" and one <script type="application/json" data-reach-science-kit="instance-id"> marker. Its JSON is exactly { "schemaVersion":"reach-science-kit/v1", "kitId":"...", "kitVersion":1, "spec":{...} }. Declare the corresponding runtime pin: geometry-board→geometry-mathigon, mechanics-2d→mechanics-matter, molecule-2d→molecule-smiles, bio-network→network-cytoscape, geo-map→geo-d3, solid-3d→solid-three, molecule-3d→molecule-3dmol, sequence-track→sequence-nightingale, dynamic-geometry→geometry-jsxgraph.
- Each spec has exact top-level fields. ${INTERACTIVE_SCIENCE_KIT_DETAILS['geometry-board']} ${INTERACTIVE_SCIENCE_KIT_DETAILS['mechanics-2d']} ${INTERACTIVE_SCIENCE_KIT_DETAILS['molecule-2d']}
- ${INTERACTIVE_SCIENCE_KIT_DETAILS['bio-network']} ${INTERACTIVE_SCIENCE_KIT_DETAILS['geo-map']} ${INTERACTIVE_SCIENCE_KIT_DETAILS['solid-3d']}
- ${INTERACTIVE_SCIENCE_KIT_DETAILS['molecule-3d']} ${INTERACTIVE_SCIENCE_KIT_DETAILS['sequence-track']} ${INTERACTIVE_SCIENCE_KIT_DETAILS['dynamic-geometry']}
- The host validates and mounts kit specs. Do not call third-party APIs or raw library globals, do not put callbacks, HTML, URLs, arbitrary expressions, shaders, selectors, loaders, or plugin names in specs. A page may contain at most four kit markers and at most one of geo-map, solid-3d, molecule-3d, or sequence-track.
- Every mounted kit target emits bubbling-free CustomEvent("reach-science-kit-change") after a meaningful kit-origin action. Attach one listener directly to the target after it exists and use event.detail to update author-owned feedback, snapshots, and declared learning events. Do not guess kit state from pixels or add unrelated duplicate controls. Relevant details are: geometry-board and dynamic-geometry {kind:"point-moved",pointId,x,y}; mechanics-2d {kind:"parameter",parameterId,value} or {kind:"body-moved",bodyId,x,y,angle}; solid-3d and molecule-3d {kind:"view",...}; geo-map {kind:"rotation",rotation}, {kind:"pan",center}, or {kind:"zoom",scale}; sequence-track {kind:"pan",scrollLeft,zoom}, {kind:"zoom",zoom}, or {kind:"feature-selected",trackId,featureId,start,end,selectedFeatureIds}; molecule-2d atom selection {kind:"atom-selected",moleculeId,atomId,element,neighborCount,carbonNeighborCount,selectedCount,total} and bond selection {kind:"bond-selected",moleculeId,bondId,sourceAtomId,targetAtomId,sourceElement,targetElement,bondOrder,selectedCount,total}; bio-network {kind:"node-selected"|"node-unselected",nodeId,selected,incomingIds,outgoingIds,undirectedIds} or {kind:"node-moved",nodeId,x,y}.
- window.ReachScienceKits provides getState(instanceId) and setState(instanceId, state) for mounted kit instances; selected capabilities may expose additional versioned APIs declared by the registry. Include the returned kit state inside every ReachInteractive.stateChange snapshot for a stateful kit. On reach-interactive-initialize, validate any author-owned restoredSnapshot fields, assign the boolean return from setState to a local variable, and pass restored:true to ready only when that validation and the exact setState result are both true. A setState rejection must produce restored:false even when other author-owned snapshot fields are valid. Never persist a third-party object, DOM node, controller, or unvalidated event detail.

`;

export const JAVASCRIPT_CORRECTNESS = `JAVASCRIPT CORRECTNESS
- Every inline script must be syntactically valid JavaScript as a complete script. Before returning the scene, check the complete script text for balanced delimiters and valid if/else, loop, function, event-listener, and initialization control flow.
- Always use braces around if, else, for, while, and do statement bodies, including one-line branches. Do not rely on automatic semicolon insertion where a following else, return, call, or expression could become ambiguous.
- The host allows one correction response, not an iterative retry loop. When validation feedback identifies a Tailwind declaration error, invalid inline JavaScript, or both, return one complete corrected scene. Preserve id, title, narration, learning objective, interaction intent, event manifest, runtime policy, every non-Tailwind dependency, visible text, class values, CSS, non-script layout, and every valid script. Change only the diagnosed Tailwind marker and dependency plus the initially diagnosed invalid executable script bodies. If either original declaration requested Tailwind, restore the exact marker/dependency pair instead of deleting both; never return a patch or an isolated script fragment.`;

/** Shared script constraints, with the host-specific repair boundary selected explicitly. */
export function interactiveJavaScriptCorrectness(editing: boolean): string {
  if (!editing) return JAVASCRIPT_CORRECTNESS;
  return (
    JAVASCRIPT_CORRECTNESS.split('\n- The host allows one correction response')[0]!.replace(
      'Before returning the scene',
      'Before validating the working HTML',
    ) +
    '\n- Repair diagnosed problems with precise working-file edits, preserving teaching content and unaffected behavior. Use validation diagnostics to correct the draft, then finish with check_and_commit_interactive_page. A failed validation does not commit the draft.'
  );
}

export function interactiveRuntimeRegistryForEditing(registry: string): string {
  return registry
    .replace(
      'Always return runtimeDependencies as an array containing only the exact pinned runtimes the document actually uses.',
      'The host infers runtimeDependencies from the working HTML; no editing tool accepts a runtimeDependencies argument. Use only the exact pinned runtimes the document actually uses.',
    )
    .replace('Use [] when none are needed.', 'The host infers [] when none are needed.')
    .replace('declarative marker contract below', 'loaded declarative capability contract');
}

/** Editing carries only shared kit safety; per-capability fields/events load on demand. */
export function interactiveScienceKitCommon(): string {
  return BUILT_IN_SCIENCE_KITS.split('\n')
    .filter(
      (line) =>
        !line.startsWith('- Each spec') &&
        !line.startsWith('- bio-network:') &&
        !line.startsWith('- molecule-3d:'),
    )
    .map((line) =>
      line
        .replace(
          'Its JSON is exactly { "schemaVersion":"reach-science-kit/v1", "kitId":"...", "kitVersion":1, "spec":{...} }.',
          'Its JSON contains exactly schemaVersion:"reach-science-kit/v1", kitId, kitVersion and spec. Use the loaded capability\'s exact kitId and kitVersion: classic kits use 1; euclidean-geometry-2d/3d v2 uses 2.',
        )
        .replace(
          / Declare the corresponding runtime pin:.*$/,
          ' Declare the exact runtime pin from the trusted catalog.',
        )
        .replace(
          / Relevant details are:.*$/,
          ' Use the event-detail contract of the active capability; load_scientific_capability supplies it for an inactive entry.',
        ),
    )
    .join('\n')
    .trim();
}

/** Existing host boundary retained while the creative authoring contract stays open. */
export const REACHINTERACTIVE_BRIDGE_CONTRACT_VERSION =
  'reach-interactive-runtime-contract/v3-window-listeners';
export const REACHINTERACTIVE_BRIDGE_CONTRACT = `REACHINTERACTIVE BRIDGE CONTRACT
- Contract schema: reach-interactive-bridge/v1. The event manifest remains reach-interactive-event-manifest/v1; use the host boundary below instead of inventing a transport.
- The host injects window.ReachInteractive before author scripts run. Do not implement postMessage or construct bridge envelopes yourself.
- The bridge first dispatches window event reach-interactive-initialize. Register all reach-interactive lifecycle listeners with window.addEventListener, never document.addEventListener. Collect every referenced DOM control (including reset/swap buttons) before binding listeners; report ready only after initialization succeeds. event.detail contains sceneId, sourceRevision, viewport { width, height }, policy { completionMode, allowReset, maximumDurationSeconds }, attempt, and optional restoredSnapshot plus restoreToken. The same object is available from ReachInteractive.getInitialization(). Restore supported state before reporting readiness.
- Call ReachInteractive.ready({ restored, restoreToken }) after initialization and restoration. Set restored to true only when restoredSnapshot was applied, and echo its restoreToken when present. When initialization has no restoreToken, omit the restoreToken property entirely; never send restoreToken as null. Otherwise report restored false.
- Do not send ready({ empty: true }) for generated content. The empty flag is reserved for the host-owned canonical blank template and cannot hide nonblank HTML.
- Call ReachInteractive.stateChange(snapshot) after meaningful state changes so bounded JSON state can be restored. Do not report numeric module progress. Call ReachInteractive.complete(payload) only when an explicit or automatic completion condition is actually reached; complete succeeds only once per attempt. Do not call complete when completionMode is none.
- If reset is allowed, a reset control may call ReachInteractive.reset(). Handle the reach-interactive-reset event, whose detail contains the new attempt, by restoring the activity's initial state. Do not call reset recursively from that handler.
- Listen for reach-interactive-resize and read event.detail { width, height } to reflow size-dependent surfaces. The bridge also dispatches reach-interactive-suspend, reach-interactive-resume, and reach-interactive-dispose lifecycle events; pause expensive motion while suspended and clean up on dispose.
- Report declared meaningful actions only through ReachInteractive.learningEvent(name, payload), using the exact manifest name, event version 1, and declared scalar fields. Raw interaction(payload) is not part of v2. ReachInteractive.error({ code, detail }) may report a bounded error with a short code. isSuspended() reports lifecycle state.
- learningEvent(name, payload) accepts only the manifest-declared scalar field map as its second argument. For a manifest event "record_replayed" whose payloadFields are "distance_a" and "distance_b", call ReachInteractive.learningEvent("record_replayed", { distance_a: 20, distance_b: 30 }). The host constructs the transport envelope and attaches eventVersion: 1; do not construct or copy that envelope as the second argument, or add undeclared version/name/nested payload metadata. A scalar field named name is valid when the manifest declares it. Every payload field name must match the manifest spelling and letter case exactly; distanceA does not match distance_a.
- Keep every bridge payload JSON-serializable, free of unsafe object keys, and compact; snapshots must remain below 64 KiB and each learning-event payload below 4 KiB.`;

export const HOST_FUNCTION_PLOT_CAPABILITY = `HOST FUNCTION PLOT CAPABILITY
- When choosing the optional bundled function-plot capability, include one non-executable <script type="application/json" data-reach-function-plot="unique-id"> marker containing one valid reach-function-plot/v2 object. Safe custom Canvas/SVG computation remains an equally valid choice.
- Never place JavaScript, callbacks, DOM, HTML, SVG, CSS, plugins, resources, sampling, events, or extra fields inside the marker JSON.
- If validation feedback identifies an invalid function-plot marker, return the complete scene but change only that marker's JSON text. Preserve its type and data-reach-function-plot id, every other marker, all executable scripts, CSS, visible HTML, title, runtimePolicy, and eventManifest exactly.
- The host validates every marker and, only when at least one is present, injects window.ReachFunctionPlot before author scripts. Obtain a frozen config with ReachFunctionPlot.config('unique-id'), then call ReachFunctionPlot.mount(targetElement, config). The target must be an actual HTMLElement, never a selector. The returned controller supports setParameters with declared finite scalar updates, getParameters, and destroy. When using this bundled capability, do not replace its parser, approximate its curves with decorative line fragments, or call the underlying plotting library directly. Never use eval or Function.
- Parameter controls and meaningful learning events remain author responsibilities. Call controller.setParameters only after validating the control value against the declared bounds, then record only the settled evidence-bearing change through the existing ReachInteractive bridge.`;
