import {
  composeInteractivePromptSections,
  composeLegacyInteractivePromptSections,
  INTERACTIVE_PROMPT_SECTIONS,
  type InteractivePromptSection,
  type ReachDeckStagePrompt,
} from './stages';

export const GEOMETRY_INTERACTIVE_API_GUIDANCE = `- New euclidean-geometry-2d/3d: kitVersion:2 with reach-euclidean-geometry/v2, valid reach-geometry-authoring/v1 bindings for intended teacher-editable IDs, and the exact catalog runtime pin. Existing stored v1 or unbound v2 geometry remains read-only; preserve its contract/runtime exactly, never synthesize bindings or implicitly upgrade; exploration/authoring requires explicit teacher-approved upgrade.
- v2 getComputedState(instanceId) returns frozen reach-geometry-computed/v2: revision,geometryRevision,modelRevision,valid,objects,measurements,relations,assertions,inputs,auxiliary,hiddenAuxiliary,selection,visibleGroups,camera. Objects, measurements, relations and assertions are records keyed by stable ID, not arrays. Use a reading only when status==="valid"; assertion pass means a?.status==="valid" && a.value===true. Undefined is not zero/no stale value. line-line intersecting/parallel/coincident/skew; line-plane intersecting/parallel/contained. Projection is not evidence; numeric relation is not proof.
- applyCommand: reach-geometry-command/v2 single or atomic commands[]+historyGroup?. Kinds: setParameter{id,value},setFreedom{id,value},select{objectId},setGroup{id,visible},setCamera{camera},reset{},undo{},redo{},addAuxiliary{auxiliary:{objects,measurements,relations,freedoms,presentation}},deleteAuxiliary{id},setAuxiliaryHidden{id,hidden},clearAuxiliary{}. interaction.exploration grants kinds/references/budgets. L_ learner IDs reference listed base or earlier L_ objects; validate the full graph atomically. Limits: 32 objects/8 measurements/8 relations/50 history steps.
- Every newly generated v2 marker requires reach-geometry-authoring/v1 with intended editable/deletable IDs; deletable is an editable subset and externalReferences are never deletable. A stored marker without bindings stays read-only. Marker edits use inspect_interactive_geometry then propose_interactive_geometry_edit with its exact HTML digest, never edit_interactive_html. Base IDs never start L_. A v2 proposal must pass parser/evaluator, then check_and_commit_interactive_page.
- v2 change detail={instanceId,revision,source,kind,inputKeys,viewKeys,structureKeys}. Read fresh computed state, not pixels/event coordinates; dedupe revision. getState() has no revision: persist only definitions,inputs,hidden,selection,groups,camera; never computed values/undo. Initialize only on reach-interactive-initialize, never eagerly call getInitialization(). Restore via boolean setState before controls/labels/ready; no initial stateChange; restored:true only if accepted; echo supplied restoreToken.
`;

function replaceOnce(text: string, old: string, replacement: string): string {
  if (text.split(old).length !== 2) throw new Error('scientific_prompt_baseline_drift');
  return text.replace(old, replacement);
}

export function scientificInteractivePrompt(
  options: {
    geometryEnabled?: boolean;
    sectionOverrides?: Partial<Record<InteractivePromptSection, string>>;
  } = {},
): ReachDeckStagePrompt {
  const registry = scientificInteractiveRuntimeRegistry();
  const text = composeInteractivePromptSections({
    'OFFLINE RUNTIME REGISTRY': registry,
    ...(options.geometryEnabled
      ? {
          'BUILT-IN SCIENCE KITS': INTERACTIVE_PROMPT_SECTIONS['BUILT-IN SCIENCE KITS'].replace(
            'Its JSON is exactly { "schemaVersion":"reach-science-kit/v1", "kitId":"...", "kitVersion":1, "spec":{...} }.',
            'Its JSON contains exactly schemaVersion:"reach-science-kit/v1", kitId, kitVersion and spec. Use the selected capability\'s exact kitId and kitVersion: classic kits use 1; euclidean-geometry-2d/3d v2 uses 2.',
          ),
        }
      : {}),
    ...options.sectionOverrides,
  });
  return {
    version: options.geometryEnabled
      ? 'interactive/v39-flat-event-fields+geometry-v2'
      : 'interactive/v39-flat-event-fields+scientific',
    text: `${text}\n\n${scientificInteractiveContextContract()}\n${options.geometryEnabled ? GEOMETRY_INTERACTIVE_API_GUIDANCE.replace('Marker edits use inspect_interactive_geometry then propose_interactive_geometry_edit with its exact HTML digest, never edit_interactive_html. Base IDs never start L_. A v2 proposal must pass parser/evaluator, then check_and_commit_interactive_page.', 'Base IDs never start L_. Generated v2 definitions must pass the host parser and evaluator.') : ''}`,
  };
}

export function scientificInteractiveContextContract(editing = false): string {
  return `TRUSTED SCIENTIFIC CONTEXT
- Decode scientificToolRegistry.capabilities using its columns. Engine and runtime tuples are exact id/version pins; runtime "engine" means reuse that row's engine tuple. limits names refer to commonLimits; inherits adds all named parent limits. Kit signatures list spec fields in addition to schemaVersion equal to contract and ariaLabel; retain every existing field/event contract above. ${editing ? 'A signature of load is discoverable but not yet loaded: call load_scientific_capability before using it. Only active capability details are included here.' : 'When supplied, geometryGrammar contains all geometry operation signatures even with zero retrieved examples.'} Dimensions and required field names are exact. Examples illustrate reusable mechanisms, not required content, layouts, controls or learning steps; never force their kit when a lighter allowed capability fits. Custom HTML/SVG/Canvas and freely composed geometry remain available within their declared limits.`;
}

export function scientificInteractiveRuntimeRegistry(): string {
  return replaceOnce(
    INTERACTIVE_PROMPT_SECTIONS['OFFLINE RUNTIME REGISTRY'],
    'Approved science-kit entries are geometry-mathigon, mechanics-matter, molecule-smiles, network-cytoscape, geo-d3, solid-three, molecule-3dmol, sequence-nightingale, and geometry-jsxgraph, each at version 1.0.0.',
    'The trusted scientificToolRegistry supplies the exact approved science-kit entries and runtime pins. A capability is available only when present in that registry; never infer permission from examples or approach hints.',
  );
}

/** Original generation assembly is retained only for frozen Decksmith v1-v7 sessions. */
export function scientificInteractivePromptLegacy(geometryEnabled: boolean): ReachDeckStagePrompt {
  const registry = scientificInteractiveRuntimeRegistry();
  const text = composeLegacyInteractivePromptSections({
    'OFFLINE RUNTIME REGISTRY': registry,
    'BUILT-IN SCIENCE KITS':
      INTERACTIVE_PROMPT_SECTIONS['BUILT-IN SCIENCE KITS'] +
      (geometryEnabled ? '\n' + GEOMETRY_INTERACTIVE_API_GUIDANCE : ''),
  });
  return {
    version: geometryEnabled
      ? 'interactive/v37-creative-capabilities+geometry-v2'
      : 'interactive/v37-creative-capabilities+scientific',
    text: `${text}\n\n${scientificInteractiveContextContract()}\n${geometryEnabled ? GEOMETRY_INTERACTIVE_API_GUIDANCE : ''}`,
  };
}

/** Explicit offline comparison adapter; normal generation uses scientificInteractivePrompt. */
export function candidateInteractivePrompt(): ReachDeckStagePrompt {
  return scientificInteractivePrompt({ geometryEnabled: true });
}
