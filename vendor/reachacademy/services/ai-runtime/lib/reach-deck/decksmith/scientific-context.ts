import { Window } from 'happy-dom';
import {
  INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN,
  parseInteractiveScienceKitEnvelopeValue,
  parseReachFunctionPlotSpecValue,
} from '@reachany/reach-deck-dsl';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  parseGeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import { parseGeometryEnvelopeV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import {
  parseScientificContextSnapshot,
  scientificContextGeometryEnabled,
  type ScientificContextSnapshot,
} from '../scientific-generation-context.js';
import {
  INTERACTIVE_SCIENCE_KIT_DETAILS,
  INTERACTIVE_SCIENCE_KIT_EVENTS,
  REACH_FUNCTION_PLOT_PROMPT_CONTRACT,
} from '../prompts/stages.js';
import { GEOMETRY_INTERACTIVE_API_GUIDANCE } from '../prompts/scientific-generation.js';

const parserWindow = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableImageFileLoading: false,
    enableJavaScriptEvaluation: false,
  },
});

export function decksmithActiveScientificCapabilities(
  snapshot: ScientificContextSnapshot | undefined,
  html?: string,
): readonly string[] {
  const active = new Set<string>();
  if (snapshot !== undefined && scientificContextGeometryEnabled(snapshot)) {
    for (const capability of parseScientificContextSnapshot(snapshot).capabilityVersions)
      if (capability.id.startsWith('euclidean-geometry-')) active.add(capability.id);
  }
  if (html !== undefined) {
    const document = new parserWindow.DOMParser().parseFromString(html, 'text/html');
    const markers = [...document.querySelectorAll('[data-reach-science-kit]')];
    const targets = [...document.querySelectorAll('[data-reach-science-kit-target]')];
    for (const marker of markers) {
      try {
        const id = (marker.getAttribute('data-reach-science-kit') ?? '').trim();
        const matchingTargets = targets.filter(
          (target) => target.getAttribute('data-reach-science-kit-target')?.trim() === id,
        );
        if (
          marker.tagName !== 'SCRIPT' ||
          marker.getAttribute('type')?.trim().toLowerCase() !== 'application/json' ||
          !INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN.test(id) ||
          markers.filter(
            (candidate) => candidate.getAttribute('data-reach-science-kit')?.trim() === id,
          ).length !== 1 ||
          matchingTargets.length !== 1 ||
          matchingTargets[0]!.tagName === 'SCRIPT'
        )
          continue;
        const envelope: unknown = JSON.parse(marker.textContent ?? '');
        const kitId =
          envelope && typeof envelope === 'object' && 'kitId' in envelope
            ? String(envelope.kitId)
            : '';
        active.add(
          Object.hasOwn(EUCLIDEAN_GEOMETRY_CONTRACT.kits, kitId)
            ? (envelope as { kitVersion?: unknown }).kitVersion === 2
              ? parseGeometryEnvelopeV2(envelope).envelope.kitId
              : parseGeometryEnvelope(envelope).envelope.kitId
            : parseInteractiveScienceKitEnvelopeValue(envelope).kitId,
        );
      } catch {
        // Stored markup remains subject to the normal scene validators.
      }
    }
    const plots = [...document.querySelectorAll('[data-reach-function-plot]')];
    for (const marker of plots) {
      try {
        const id = (marker.getAttribute('data-reach-function-plot') ?? '').trim();
        if (
          marker.tagName !== 'SCRIPT' ||
          marker.getAttribute('type')?.trim().toLowerCase() !== 'application/json' ||
          !INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN.test(id) ||
          plots.filter(
            (candidate) => candidate.getAttribute('data-reach-function-plot')?.trim() === id,
          ).length !== 1
        )
          continue;
        parseReachFunctionPlotSpecValue(JSON.parse(marker.textContent ?? ''));
        active.add('cartesian-plot');
      } catch {
        // Invalid markers require repair through the normal validation boundary.
      }
    }
  }
  return [...active].sort();
}

export function projectDecksmithScientificContext(
  input: ScientificContextSnapshot,
  active: readonly string[],
) {
  const snapshot = parseScientificContextSnapshot(input);
  const injection = JSON.parse(snapshot.serializedInjection);
  const registry = injection.scientificToolRegistry;
  const signature = registry.columns.indexOf('signature');
  const capability = registry.columns.indexOf('capability');
  if (signature < 0 || capability < 0) throw new Error('scientific_catalog_columns_invalid');
  registry.capabilities = registry.capabilities.map((row: unknown[]) =>
    row.map((value, index) =>
      index === signature && !active.includes(String(row[capability])) ? 'load' : value,
    ),
  );
  return { frozenContextDigest: snapshot.digest, ...injection };
}

export function decksmithScientificCapabilityDetails(capabilityId: string): string {
  if (capabilityId.startsWith('euclidean-geometry-')) return GEOMETRY_INTERACTIVE_API_GUIDANCE;
  if (capabilityId === 'cartesian-plot')
    return `HOST FUNCTION PLOT CAPABILITY
Use a non-executable <script type="application/json" data-reach-function-plot="unique-id"> marker and the exact pinned function-plot runtime.
${REACH_FUNCTION_PLOT_PROMPT_CONTRACT}
Never put JavaScript, callbacks, DOM, HTML, SVG, CSS, plugins, resources, sampling, events or extra fields in marker JSON. Repair invalid marker JSON through edit_interactive_html, preserving its type/id, other markers, executable scripts, CSS, visible HTML, title, runtimePolicy and eventManifest.
The host injects ReachFunctionPlot only when a marker exists. Read its frozen config with ReachFunctionPlot.config('unique-id'), then ReachFunctionPlot.mount(targetElement,config); targetElement must be an HTMLElement, never a selector. The controller exposes setParameters with declared finite scalar updates, getParameters and destroy. Never hand-write a function parser, approximate curves with line fragments, call raw plotting APIs or use eval/Function. Validate controls against declared bounds before setParameters and report only settled meaningful changes through ReachInteractive.`;
  if (Object.hasOwn(INTERACTIVE_SCIENCE_KIT_DETAILS, capabilityId)) {
    const id = capabilityId as keyof typeof INTERACTIVE_SCIENCE_KIT_DETAILS;
    return `${INTERACTIVE_SCIENCE_KIT_DETAILS[id]}\nKit-origin event details: ${INTERACTIVE_SCIENCE_KIT_EVENTS[id]}`;
  }
  if (capabilityId === 'custom-interactive-document')
    return 'Use the shared self-contained HTML/CSS/JavaScript, safety, layout, bridge, narration and learning-event contracts. Custom rendering does not bypass scientific invariants or registered engine semantics.';
  throw new Error('scientific_capability_unknown');
}
