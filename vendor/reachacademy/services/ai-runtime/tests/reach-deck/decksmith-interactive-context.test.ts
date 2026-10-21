import { createHash } from 'node:crypto';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import { createBlankReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';
import { interactiveScene } from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';
import {
  assertDecksmithProviderDispatchCapacity,
  buildDecksmithInitialProviderInput,
  convertDecksmithMessagesForProvider,
  measureDecksmithModelInput,
  measureDecksmithProviderPayload,
} from '../../lib/reach-deck/decksmith/agent.js';
import { estimateDeterministicCapacity } from '../../lib/reach-deck/decksmith/capacity.js';
import { DecksmithDocumentSession } from '../../lib/reach-deck/decksmith/session.js';
import { createDecksmithTools } from '../../lib/reach-deck/decksmith/tools.js';
import {
  decksmithActiveScientificCapabilities,
  decksmithScientificCapabilityDetails,
  projectDecksmithScientificContext,
} from '../../lib/reach-deck/decksmith/scientific-context.js';
import {
  decksmithInteractivePrompt,
  decksmithInteractivePromptLegacy,
} from '../../lib/reach-deck/prompts/decksmith-interactive.js';
import {
  GEOMETRY_INTERACTIVE_API_GUIDANCE,
  scientificInteractivePrompt,
} from '../../lib/reach-deck/prompts/scientific-generation.js';
import { INTERACTIVE_SCIENCE_KIT_DETAILS } from '../../lib/reach-deck/prompts/interactive-runtime-contract.js';
import {
  JSON_OUTPUT_RULES_SNIPPET,
  SOURCE_AND_LANGUAGE_SNIPPET,
} from '../../lib/reach-deck/prompts/corpus/local-snippets.js';
import {
  composeInteractivePromptSections,
  INTERACTIVE_PROMPT,
} from '../../lib/reach-deck/prompts/stages.js';
import {
  buildScientificGenerationContext,
  scientificContextRuntimeDependencies,
  trimScientificContextSnapshot,
} from '../../lib/reach-deck/scientific-generation-context.js';
import {
  SCIENTIFIC_GEOMETRY_EXAMPLES,
  scientificExampleHtml,
} from '../../lib/reach-deck/scientific-generation-examples.js';

const THREE_PAGE_GEOMETRY_EDIT_INPUT_LIMIT = 160_000;

describe('Decksmith shared Interactive contract', () => {
  it('only projects geometry signatures when the context enables them or the page owns a marker', () => {
    const ordinary = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
      pageIntent: { sceneType: 'interactive', title: 'Narrative comparison' },
      teacherRequest: 'Clarify the reflection prompt',
    });
    expect(decksmithActiveScientificCapabilities(ordinary)).toEqual([]);
    const ordinaryCatalog = projectDecksmithScientificContext(ordinary, [])
      .scientificToolRegistry as { columns: string[]; capabilities: unknown[][] };
    const capabilityColumn = ordinaryCatalog.columns.indexOf('capability');
    const signatureColumn = ordinaryCatalog.columns.indexOf('signature');
    expect(
      ordinaryCatalog.capabilities
        .filter((row) => String(row[capabilityColumn]).startsWith('euclidean-geometry-'))
        .map((row) => row[signatureColumn]),
    ).toEqual([]);

    const geometry = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
      pageIntent: { sceneType: 'interactive', title: 'Triangle midpoint construction' },
      teacherRequest: 'Fix the midpoint measurements',
      approachHints: ['euclidean-geometry-2d'],
    });
    expect(decksmithActiveScientificCapabilities(geometry)).toContain('euclidean-geometry-2d');
  });

  it('pins the effective capability prompt while editing retains shared strict contracts', () => {
    expect(INTERACTIVE_PROMPT.version).toBe('interactive/v39-flat-event-fields');
    expect(createHash('sha256').update(INTERACTIVE_PROMPT.text).digest('hex')).toBe(
      '3b159ce95d542b577ba4f4a7dff1a92ba2fded5e7f4048aed62d75940811e754',
    );
    const editing = decksmithInteractivePrompt({
      scientificContext: true,
      geometryEnabled: true,
      activeCapabilities: ['euclidean-geometry-2d', 'euclidean-geometry-3d'],
    });
    const standalone = scientificInteractivePrompt({ geometryEnabled: true });
    expect(editing.text).toContain('load_scientific_capability');
    expect(editing.text).not.toContain(decksmithScientificCapabilityDetails('mechanics-2d'));
    const active = decksmithInteractivePrompt({
      scientificContext: true,
      geometryEnabled: true,
      activeCapabilities: ['mechanics-2d', 'cartesian-plot'],
    });
    expect(active.text).toContain(decksmithScientificCapabilityDetails('mechanics-2d'));
    expect(active.text).toContain(decksmithScientificCapabilityDetails('cartesian-plot'));
    expect(editing.version).toBe('decksmith-interactive/v6-active-contracts');
    expect(editing.text).toContain('A signature of load is discoverable but not yet loaded');
    expect(standalone.text).not.toContain('check_and_commit_interactive_page');
    expect(editing.text).toContain(
      'Objects, measurements, relations and assertions are records keyed by stable ID, not arrays',
    );
    expect(editing.text).toContain('Use a reading only when status==="valid"');
    expect(editing.text).toContain('line-line intersecting/parallel/coincident/skew');
    expect(editing.text).toContain('snapshots must remain below 64 KiB');
    expect(editing.text).toContain('each learning-event payload below 4 KiB');
    expect(editing.text).toContain('Use comfortably spaced touch targets');
    expect(editing.text).toContain('inspect_interactive_geometry');
    expect(editing.text).toContain('propose_interactive_geometry_edit');
    expect(editing.text).toContain(
      'The host injects window.ReachInteractive before author scripts run',
    );
    expect(editing.text).toContain('read');
    expect(editing.text).toContain('TEACHING AND CREATIVE OWNERSHIP');
  });

  it('injects active capability details once and leaves inactive details to the loader', () => {
    const noActive = decksmithInteractivePrompt({ scientificContext: true, geometryEnabled: true });
    for (const details of Object.values(INTERACTIVE_SCIENCE_KIT_DETAILS))
      expect(noActive.text).not.toContain(details);
    expect(noActive.text).not.toContain('getComputedState(instanceId)');
    expect(noActive.text).not.toContain('reach-function-plot/v2');
    expect(noActive.text).toContain('load_scientific_capability');
    expect(noActive.text).toContain('assign the boolean return from setState');
    const geometry = decksmithInteractivePrompt({
      scientificContext: true,
      geometryEnabled: true,
      activeCapabilities: [
        'euclidean-geometry-2d',
        'euclidean-geometry-3d',
        'euclidean-geometry-2d',
      ],
    });
    expect(geometry.text.split(GEOMETRY_INTERACTIVE_API_GUIDANCE)).toHaveLength(2);
    expect(geometry.text).toContain('classic kits use 1; euclidean-geometry-2d/3d v2 uses 2');
    expect(geometry.text).not.toContain('"kitVersion":1, "spec"');
    const kits = decksmithInteractivePrompt({
      scientificContext: true,
      geometryEnabled: false,
      activeCapabilities: ['mechanics-2d', 'cartesian-plot', 'mechanics-2d'],
    });
    expect(kits.text.split(decksmithScientificCapabilityDetails('mechanics-2d'))).toHaveLength(2);
    expect(kits.text.split('HOST FUNCTION PLOT CAPABILITY')).toHaveLength(2);
  });

  it('selects output and repair rules for the generation or editing host', () => {
    const editing = decksmithInteractivePrompt({
      scientificContext: true,
      geometryEnabled: false,
    }).text;
    for (const obsolete of [
      'Create one complete reach-interactive-scene',
      'one correction response',
      'never return a patch',
      'return the complete scene',
      JSON_OUTPUT_RULES_SNIPPET,
    ])
      expect(editing).not.toContain(obsolete);
    expect(editing).toContain('precise working-file edits');
    expect(editing).not.toMatch(/(?:Always return|Return) runtimeDependencies/);
    expect(editing).not.toContain('Return eventManifest as');
    expect(editing).toContain('The host infers runtimeDependencies from the working HTML');
    expect(editing).toContain('pass eventManifestJson to check_and_commit_interactive_page');
    expect(editing).toContain('check_and_commit_interactive_page');
    expect(editing).toContain('There is no zero-scroll requirement');
    expect(editing).not.toContain('Prefer a registered typed scientific capability');
    for (const text of [editing, INTERACTIVE_PROMPT.text]) {
      expect(text.split('REACHINTERACTIVE BRIDGE CONTRACT')).toHaveLength(2);
      expect(text.split(SOURCE_AND_LANGUAGE_SNIPPET)).toHaveLength(2);
    }
    expect(INTERACTIVE_PROMPT.text.split(JSON_OUTPUT_RULES_SNIPPET)).toHaveLength(2);
    expect(INTERACTIVE_PROMPT.text).toContain('one correction response');
    expect(INTERACTIVE_PROMPT.text).toContain('never return a patch');
    expect(
      scientificInteractivePrompt({ geometryEnabled: true }).text.split(
        'getComputedState(instanceId)',
      ),
    ).toHaveLength(2);
  });

  it.each([
    [
      { scientificContext: false, geometryEnabled: false },
      'fd6670431640add0f02238768c3eb3287889c214307a628e11d81a86de571d15',
    ],
    [
      { scientificContext: true, geometryEnabled: false },
      '6ad29ba90a589f8ba28248a2633910fb27d67ab48a03a6e241064bc40d2dfc65',
    ],
    [
      { scientificContext: true, geometryEnabled: true },
      '004a193161dd1ce7a6e885425040f7e8d3b34e2352dac3b321a69093e630c9e7',
    ],
    [
      {
        scientificContext: true,
        geometryEnabled: true,
        activeCapabilities: ['euclidean-geometry-2d', 'euclidean-geometry-3d'],
      },
      '33b69b787de03d6d7c85a23f399e9c7eed374583916a5c03e8fe8522ade36c1d',
    ],
    [
      {
        scientificContext: true,
        geometryEnabled: false,
        activeCapabilities: ['mechanics-2d', 'cartesian-plot'],
      },
      'e35faac3bb46044e9f42c70ded55afee4578ca3aeb199dbcadd6c1ba491efad6',
    ],
  ])('preserves frozen v1-v7 prompt bytes for %j', (options, sha) => {
    const legacy = decksmithInteractivePromptLegacy(options);
    expect(legacy.version).toBe('decksmith-interactive/v5-deck-design');
    expect(createHash('sha256').update(legacy.text).digest('hex')).toBe(sha);
  });

  it('rejects unknown or empty section overrides', () => {
    expect(() => composeInteractivePromptSections({ unknown: 'text' } as never)).toThrow(
      'interactive_prompt_section_unknown',
    );
    expect(() => composeInteractivePromptSections({ 'PAGE RESPONSIBILITY': ' ' })).toThrow(
      'interactive_prompt_section_empty',
    );
  });

  it('fits a three-page geometry edit through real read, edit, reread and commit provider turns', async () => {
    const selected = [2, 3].map(
      (dimension) =>
        SCIENTIFIC_GEOMETRY_EXAMPLES.find((example) => example.dimension === dimension)!,
    );
    let snapshot = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
      pageIntent: { sceneType: 'interactive', title: 'Triangle midpoint exploration' },
      teacherRequest: 'Fix current measurements and restore the midpoint construction',
      currentEnvelopes: [selected[0]!.envelope],
    });
    const base = createBlankReachDeckDocument({
      id: 'geometry-edit',
      title: 'Geometry exploration',
    });
    const document: ReachDeckDocument = {
      ...base,
      pages: [
        base.pages[0]!,
        ...selected.map((example, index) => {
          const pageId = `geometry-${index + 2}`;
          const html = scientificExampleHtml(example);
          // P4's authored pages are 7.6-7.9KB; retain an 8KB complete HTML read in this regression.
          const documentHtml = html.replace(
            '</body>',
            `<!--${'x'.repeat(Math.max(0, 8192 - Buffer.byteLength(html)))}--></body>`,
          );
          return {
            pageId,
            order: index + 2,
            revision: 3,
            sceneType: 'interactive' as const,
            title: example.brief,
            scene: {
              ...interactiveScene(pageId),
              title: example.brief,
              documentHtml,
              runtimeDependencies: [...scientificContextRuntimeDependencies(snapshot)],
            },
          };
        }),
      ],
    };
    const input = {
      capability: 'reach-deck-decksmith/v2' as const,
      prompt: 'Fix current measurements and restore the midpoint construction',
      document,
      pageId: document.pages[1]!.pageId,
      scientificContextSnapshot: snapshot,
    };
    while (
      estimateDeterministicCapacity(measureDecksmithModelInput(input)) >=
      THREE_PAGE_GEOMETRY_EDIT_INPUT_LIMIT
    ) {
      const trimmed = trimScientificContextSnapshot(snapshot);
      if (trimmed === null) break;
      snapshot = trimmed;
      input.scientificContextSnapshot = trimmed;
    }
    const initial = buildDecksmithInitialProviderInput(input);
    const session = new DecksmithDocumentSession(document, input.capability);
    const read = session.readPageView(input.pageId);
    const afterRead = {
      ...initial,
      messages: [
        ...initial.messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'read-1',
              type: 'function',
              function: { name: 'read_page', arguments: JSON.stringify({ pageId: input.pageId }) },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'read-1', content: JSON.stringify(read) },
      ],
    };
    const guarantee = {
      capacityProfileVersion: 'p4-provider-160k',
      estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
      capacityUnit: 'model-token-upper-bound',
      guaranteedInputCapacity: 160_000,
      reservedOutputCapacity: 16_384,
    };
    expect(estimateDeterministicCapacity(measureDecksmithModelInput(input))).toBeLessThan(
      THREE_PAGE_GEOMETRY_EDIT_INPUT_LIMIT,
    );
    expect(() => assertDecksmithProviderDispatchCapacity(afterRead, guarantee)).not.toThrow();
    expect(JSON.stringify(afterRead)).toContain('reach-euclidean-geometry/v2');
    expect(initial.messages[1]!.content).toContain('geometryGrammar');
    expect(initial.tools).toHaveLength(29);
    const repeatedRead = {
      ...afterRead,
      messages: [
        ...afterRead.messages,
        // Enough repeated full-HTML reads to exceed the guarantee regardless of tool-schema size.
        ...Array.from({ length: 3 }, () => afterRead.messages.slice(-2)).flat(),
      ],
    };
    expect(
      estimateDeterministicCapacity(measureDecksmithProviderPayload(repeatedRead)),
    ).toBeGreaterThan(guarantee.guaranteedInputCapacity);
    expect(() => assertDecksmithProviderDispatchCapacity(repeatedRead, guarantee)).toThrow();

    const activePage = document.pages.find((page) => page.pageId === input.pageId);
    const activeHtml =
      activePage?.sceneType === 'interactive' && activePage.scene.sceneType === 'interactive'
        ? activePage.scene.documentHtml
        : undefined;
    const tools = createDecksmithTools(
      session,
      snapshot,
      decksmithActiveScientificCapabilities(snapshot, activeHtml),
    );
    const messages: Parameters<typeof convertDecksmithMessagesForProvider>[0] = [
      { role: 'user', content: initial.messages[1]!.content as string, timestamp: 1 },
    ];
    const calls = [
      ['read_page', { pageId: input.pageId }],
      ['read_interactive_html', { pageId: input.pageId }],
      ['load_scientific_capability', { capabilityId: 'euclidean-geometry-2d' }],
      [
        'load_scientific_capability',
        {
          capabilityId: 'euclidean-geometry-2d',
          teacherRequest: 'Restore the midpoint construction',
        },
      ],
      ['load_scientific_capability', { capabilityId: 'euclidean-geometry-2d' }],
      [
        'edit_interactive_html',
        {
          pageId: input.pageId,
          edits: [{ oldText: '</body>', newText: '<!-- verified edit --></body>' }],
        },
      ],
      ['read_interactive_html', { pageId: input.pageId }],
      [
        'edit_interactive_html',
        {
          pageId: input.pageId,
          edits: [{ oldText: '<!-- verified edit -->', newText: '<!-- verified second edit -->' }],
        },
      ],
      ['read_interactive_html', { pageId: input.pageId }],
      ['check_and_commit_interactive_page', { pageId: input.pageId }],
    ] as const;
    for (const [name, args] of calls) {
      const id = `call-${messages.length}`;
      messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id, name, arguments: args }],
        api: 'openai-completions',
        provider: 'openai',
        model: 'test',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: messages.length,
      });
      const result = await tools.find((tool) => tool.name === name)!.execute(id, args);
      messages.push({
        ...result,
        role: 'toolResult',
        toolCallId: id,
        toolName: name,
        isError: false,
        timestamp: messages.length,
      });
      let dispatched: unknown;
      const stream = streamOpenAICompletions(
        {
          id: 'reachany-model-service',
          name: 'No-network capacity regression',
          api: 'openai-completions',
          provider: 'reachany-model-service',
          baseUrl: 'http://model.invalid/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 111616,
          maxTokens: 16384,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens',
            supportsStrictMode: false,
          },
        },
        {
          systemPrompt: initial.messages[0]!.content,
          messages: convertDecksmithMessagesForProvider(messages),
          tools: initial.tools.map((tool) => tool.function),
        },
        {
          apiKey: 'test-not-a-secret',
          onPayload(payload) {
            dispatched = payload;
            throw new Error('Stop before network');
          },
        },
      );
      await stream.result();
      expect(dispatched).toBeDefined();
      expect(() => assertDecksmithProviderDispatchCapacity(dispatched, guarantee)).not.toThrow();
    }
  });

  it('retains the frozen catalog and loads inactive contracts without widening old-kit permissions', async () => {
    const snapshot = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
    });
    const original = JSON.stringify(snapshot);
    const projection = projectDecksmithScientificContext(snapshot, ['mechanics-2d']);
    const registry = JSON.parse(snapshot.serializedInjection).scientificToolRegistry;
    expect(projection.scientificToolRegistry.capabilities.map((row: unknown[]) => row[0])).toEqual(
      registry.capabilities.map((row: unknown[]) => row[0]),
    );
    expect(projection.frozenContextDigest).toBe(snapshot.digest);
    expect(JSON.stringify(snapshot)).toBe(original);
    const session = new DecksmithDocumentSession(
      createBlankReachDeckDocument({ id: 'loader', title: 'Loader' }),
      'reach-deck-decksmith/v2',
      {
        interactiveValidationOptions: {
          scientificCapabilityPolicy: 'normal',
          allowedRuntimeDependencies: scientificContextRuntimeDependencies(snapshot),
        },
      },
    );
    const pins = JSON.stringify(session.interactiveValidationOptions.allowedRuntimeDependencies);
    const loader = createDecksmithTools(session, snapshot).find(
      (tool) => tool.name === 'load_scientific_capability',
    )!;
    for (const capabilityId of [
      'geometry-board',
      'dynamic-geometry',
      'mechanics-2d',
      'molecule-2d',
      'bio-network',
      'geo-map',
      'solid-3d',
      'molecule-3d',
      'sequence-track',
      'cartesian-plot',
    ]) {
      const result = await loader.execute('load', { capabilityId });
      const text = result.content.find((item) => item.type === 'text')!;
      expect(JSON.parse((text as { text: string }).text).guidance).toBe(
        decksmithScientificCapabilityDetails(capabilityId),
      );
      expect(JSON.stringify(result.content)).not.toContain('AUTHORING COMPONENT MARKERS');
      expect(JSON.stringify(session.interactiveValidationOptions.allowedRuntimeDependencies)).toBe(
        pins,
      );
    }
    await expect(loader.execute('unknown', { capabilityId: 'not-a-kit' })).rejects.toThrow(
      'Unknown scientific capability',
    );
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it('replays a historical capability from the frozen registry after the current catalog removes it', async () => {
    const current = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
    });
    const injection = JSON.parse(current.serializedInjection) as {
      scientificToolRegistry: { capabilities: unknown[][] };
      scientificCapabilityReferences: unknown[];
      selectedScientificExamples: unknown[];
    };
    const row = injection.scientificToolRegistry.capabilities.find(
      (candidate) => candidate[0] === 'custom-interactive-document',
    )!;
    row[0] = 'retired-scientific-kit';
    row[1] = 'reach-retired-science/v7';
    row[3] = ['retired-runtime', '9.9.0'];
    row[5] = ['historical contract only'];
    row[7] = 'Historical internal runtime';
    row[8] = 'frozen';
    const serializedInjection = JSON.stringify(injection);
    const countStructure = (value: unknown): number =>
      1 +
      (value && typeof value === 'object'
        ? Object.values(value).reduce<number>((sum, item) => sum + countStructure(item), 0)
        : 0);
    const details = {
      scientificCapabilityReferences: injection.scientificCapabilityReferences,
      selectedScientificExamples: injection.selectedScientificExamples,
    };
    const capabilityVersions = injection.scientificToolRegistry.capabilities.map((candidate) => ({
      id: candidate[0],
      version: candidate[1],
    }));
    const unsigned = {
      schemaVersion: current.schemaVersion,
      promptVersion: current.promptVersion,
      catalogVersion: current.catalogVersion,
      retrievalRuleVersion: current.retrievalRuleVersion,
      policy: current.policy,
      stage: current.stage,
      capabilityVersions,
      referenceVersions: current.referenceVersions,
      exampleVersions: current.exampleVersions,
      serializedInjection,
      byteLength: Buffer.byteLength(serializedInjection, 'utf8'),
      detailsByteLength: Buffer.byteLength(JSON.stringify(details), 'utf8'),
      structureItemCount: countStructure(injection),
    };
    const historical = {
      ...current,
      capabilityVersions,
      serializedInjection,
      byteLength: unsigned.byteLength,
      digest: createHash('sha256').update(JSON.stringify(unsigned), 'utf8').digest('hex'),
      structureItemCount: unsigned.structureItemCount,
    };
    const session = new DecksmithDocumentSession(
      createBlankReachDeckDocument({ id: 'historical-loader', title: 'Historical loader' }),
      'reach-deck-decksmith/v2',
      {
        interactiveValidationOptions: { scientificCapabilityPolicy: 'normal' },
      },
    );
    const loader = createDecksmithTools(session, historical as typeof current).find(
      (tool) => tool.name === 'load_scientific_capability',
    )!;
    const result = await loader.execute('historical', { capabilityId: 'retired-scientific-kit' });
    const payload = JSON.parse(
      (result.content.find((item) => item.type === 'text') as { text: string }).text,
    );
    expect(payload.capability[0]).toBe('retired-scientific-kit');
    expect(payload.capability[1]).toBe('reach-retired-science/v7');
    expect(payload.guidance).toContain('FROZEN SCIENTIFIC CAPABILITY');
    expect(payload.frozenContextDigest).toBe(historical.digest);
    await expect(
      loader.execute('historical-again', { capabilityId: 'retired-scientific-kit' }),
    ).resolves.toBeDefined();
  });

  it('activates only valid current-page markers and frozen geometry capabilities', () => {
    const example = SCIENTIFIC_GEOMETRY_EXAMPLES.find((example) => example.dimension === 2)!;
    const html = scientificExampleHtml(example);
    expect(decksmithActiveScientificCapabilities(undefined, html)).toContain(
      'euclidean-geometry-2d',
    );
    expect(decksmithActiveScientificCapabilities(undefined, `<!--${html}-->`)).toEqual([]);
    expect(
      decksmithActiveScientificCapabilities(
        undefined,
        '<script type="application/json" data-reach-science-kit="fake">{"kitId":"mechanics-2d"}</script><div data-reach-science-kit-target="fake"></div><script type="application/json" data-reach-function-plot="plot">{}</script>',
      ),
    ).toEqual([]);
    const snapshot = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
      currentEnvelopes: [example.envelope],
    });
    expect(decksmithActiveScientificCapabilities(snapshot)).toContain('euclidean-geometry-2d');
  });
});
