import {
  INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_TAILWIND_RUNTIME_ID,
  INTERACTIVE_TAILWIND_RUNTIME_VERSION,
  type InteractiveEventManifest,
  type InteractiveScene,
} from '@reachany/reach-deck-dsl';

export const INTERACTIVE_TAILWIND_FIXTURE_PAGE_ID = 'interactive-tailwind-fractions';
export const INTERACTIVE_TAILWIND_FIXTURE_TITLE = 'Fraction equivalence lab';

export const INTERACTIVE_TAILWIND_FIXTURE_EVENT_MANIFEST = {
  schemaVersion: 'reach-interactive-event-manifest/v1',
  events: [
    {
      name: 'fraction_selected',
      eventVersion: 1,
      meaning: 'The learner selected one fourth in the equivalence model.',
      payloadFields: [
        {
          name: 'choice',
          type: 'string',
          required: true,
          maxLength: 3,
          enum: ['one', 'two'],
        },
        {
          name: 'selected_count',
          type: 'integer',
          required: true,
          minimum: 1,
          maximum: 2,
        },
      ],
      delivery: { mode: 'immediate' },
    },
  ],
} as const satisfies InteractiveEventManifest;

export const INTERACTIVE_TAILWIND_FIXTURE_HTML = `<!doctype html>
<html lang="en" ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="${INTERACTIVE_TAILWIND_RUNTIME_VERSION}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; min-height: 100%; }
      body { background: #f8fafc; color: #172033; font-family: ui-sans-serif, system-ui, sans-serif; }
      #app { min-height: 100vh; }
      .fraction-bar { min-height: 112px; }
    </style>
  </head>
  <body>
    <main id="app" class="mx-auto grid min-h-screen max-w-6xl grid-cols-1 gap-6 p-5 md:grid-cols-2 md:items-center md:gap-10 md:p-10">
      <section class="space-y-4" aria-labelledby="lab-title">
        <p class="text-sm font-bold uppercase text-blue-700">Equivalence lab</p>
        <h1 id="lab-title" class="text-3xl font-extrabold text-slate-900 md:text-5xl">Build one half</h1>
        <p class="max-w-prose text-base leading-7 text-slate-600 md:text-lg">Select two fourths to show why 2/4 is equal to 1/2.</p>
        <div class="flex flex-wrap gap-3" role="group" aria-label="Fraction choices">
          <button id="choice-one" type="button" class="rounded-md border-2 border-blue-700 bg-white px-4 py-3 font-bold text-blue-800 shadow-sm aria-pressed:bg-blue-700 aria-pressed:text-white" aria-pressed="false">Choose 1/4</button>
          <button id="choice-two" type="button" class="rounded-md border-2 border-blue-700 bg-white px-4 py-3 font-bold text-blue-800 shadow-sm aria-pressed:bg-blue-700 aria-pressed:text-white" aria-pressed="false">Choose another 1/4</button>
          <button id="reset" type="button" class="rounded-md bg-slate-700 px-4 py-3 font-bold text-white shadow-sm">Reset</button>
        </div>
        <p id="feedback" class="min-h-8 rounded-md bg-blue-50 p-3 font-semibold text-blue-900" role="status" aria-live="polite">Select both fourths.</p>
      </section>
      <section class="self-start rounded-lg border border-slate-200 bg-white p-5 shadow-xl md:self-auto" aria-label="Fraction model">
        <div id="model-container" data-expanded="false" class="fraction-bar relative w-full overflow-hidden rounded-md border-2 border-slate-700 bg-slate-100 data-[expanded=true]:h-32">
          <canvas id="fraction-canvas" class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>
          <div class="relative grid h-full grid-cols-4" aria-label="Four equal parts">
            <div id="segment-one" data-selected="false" class="fraction-segment border-r border-white/80 bg-blue-500 transition-all duration-500 data-[selected=true]:-translate-y-2 data-[selected=true]:bg-green-600 motion-reduce:transition-none"></div>
            <div id="segment-two" data-selected="false" class="fraction-segment border-r border-white/80 bg-blue-200 transition-all duration-500 data-[selected=true]:-translate-y-2 data-[selected=true]:bg-green-600 motion-reduce:transition-none"></div>
            <div class="border-r border-white/80 bg-slate-200"></div>
            <div class="bg-slate-200"></div>
          </div>
        </div>
        <div class="mt-5 flex items-center justify-between gap-4">
          <span class="text-sm font-semibold text-slate-600">Selected</span>
          <strong id="equation" class="text-2xl text-slate-900">0/4</strong>
        </div>
      </section>
    </main>
    <script>
      (() => {
        const selected = new Set();
        const container = document.getElementById('model-container');
        const canvas = document.getElementById('fraction-canvas');
        const context = canvas.getContext('2d');
        const feedback = document.getElementById('feedback');
        const equation = document.getElementById('equation');
        let pendingFrame = 0;
        let lastWidth = 0;
        let lastHeight = 0;

        const bridge = window.ReachInteractive;
        const snapshot = () => ({
          selected: Array.from(selected).sort(),
          complete: selected.size === 2
        });
        const emitSnapshot = () => bridge.stateChange(snapshot());
        const emitSelection = (choice) => bridge.learningEvent('fraction_selected', {
          choice,
          selected_count: selected.size
        });

        const render = () => {
          ['one', 'two'].forEach((choice) => {
            const active = selected.has(choice);
            const button = document.getElementById('choice-' + choice);
            const segment = document.getElementById('segment-' + choice);
            button.setAttribute('aria-pressed', String(active));
            button.classList.toggle('bg-blue-700', active);
            button.classList.toggle('text-white', active);
            button.classList.toggle('bg-white', !active);
            button.classList.toggle('text-blue-800', !active);
            segment.dataset.selected = String(active);
          });
          equation.textContent = selected.size + '/4';
          feedback.textContent = selected.size === 2
            ? 'Matched: 2/4 covers the same amount as 1/2.'
            : selected.size === 1 ? 'One more fourth completes one half.' : 'Select both fourths.';
        };

        ['one', 'two'].forEach((choice) => {
          document.getElementById('choice-' + choice).addEventListener('click', () => {
            selected.add(choice);
            render();
            emitSelection(choice);
            emitSnapshot();
          });
        });
        document.getElementById('reset').addEventListener('click', () => {
          bridge.reset();
        });
        window.addEventListener('reach-interactive-reset', () => {
          selected.clear();
          render();
          emitSnapshot();
        });

        const redraw = () => {
          pendingFrame = 0;
          const width = Math.round(container.clientWidth);
          const height = Math.round(container.clientHeight);
          if (width === lastWidth && height === lastHeight) return;
          lastWidth = width;
          lastHeight = height;
          document.documentElement.dataset.resizeDraws = String(
            Number(document.documentElement.dataset.resizeDraws || 0) + 1
          );
          document.documentElement.dataset.lastCanvasSize = width + 'x' + height;
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          context.clearRect(0, 0, width, height);
          context.strokeStyle = '#334155';
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(width / 2, 0);
          context.lineTo(width / 2, height);
          context.stroke();
        };
        const observer = new ResizeObserver(() => {
          document.documentElement.dataset.resizeObserverCallbacks = String(
            Number(document.documentElement.dataset.resizeObserverCallbacks || 0) + 1
          );
          if (!pendingFrame) {
            document.documentElement.dataset.resizeRafRequests = String(
              Number(document.documentElement.dataset.resizeRafRequests || 0) + 1
            );
            pendingFrame = requestAnimationFrame(redraw);
          }
        });
        observer.observe(container);
        window.addEventListener('pagehide', () => {
          observer.disconnect();
          if (pendingFrame) cancelAnimationFrame(pendingFrame);
          document.documentElement.dataset.resizeObserverDisconnected = 'true';
        }, { once: true });
        window.addEventListener('reach-interactive-initialize', (event) => {
          const initialization = event.detail;
          if (!initialization || initialization.sceneId !== '${INTERACTIVE_TAILWIND_FIXTURE_PAGE_ID}' || initialization.attempt !== 1) {
            bridge.error({ code: 'invalid_initialization', detail: 'Expected the fixture scene and first attempt.' });
            return;
          }
          const restored = initialization.restoredSnapshot;
          let didRestore = false;
          if (restored && Array.isArray(restored.selected) && restored.selected.every((choice) => choice === 'one' || choice === 'two')) {
            restored.selected.forEach((choice) => selected.add(choice));
            didRestore = true;
          }
          document.documentElement.dataset.initialized = 'true';
          render();
          redraw();
          document.documentElement.dataset.initialCanvasSize =
            document.documentElement.dataset.lastCanvasSize;
          bridge.ready({
            restored: didRestore,
            ...(didRestore ? { restoreToken: initialization.restoreToken } : {})
          });
          emitSnapshot();
          requestAnimationFrame(() => {
            document.documentElement.dataset.resizeBaselineCallbacks =
              document.documentElement.dataset.resizeObserverCallbacks || '0';
            document.documentElement.dataset.resizeBaselineRafRequests =
              document.documentElement.dataset.resizeRafRequests || '0';
            document.documentElement.dataset.resizeBaselineDraws =
              document.documentElement.dataset.resizeDraws || '0';
            document.documentElement.dataset.tailwindResizeTriggered = 'true';
            container.dataset.expanded = 'true';
          });
        }, { once: true });
      })();
    </script>
  </body>
</html>`;

export const INTERACTIVE_TAILWIND_FIXTURE_SCENE = {
  schemaVersion: 'reach-interactive-scene/v2',
  id: INTERACTIVE_TAILWIND_FIXTURE_PAGE_ID,
  title: INTERACTIVE_TAILWIND_FIXTURE_TITLE,
  sceneType: 'interactive',
  documentHtml: INTERACTIVE_TAILWIND_FIXTURE_HTML,
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimePolicy: {
    completionMode: 'none',
    allowReset: true,
    maximumDurationSeconds: null,
  },
  eventManifest: INTERACTIVE_TAILWIND_FIXTURE_EVENT_MANIFEST,
  runtimeDependencies: [
    { id: INTERACTIVE_TAILWIND_RUNTIME_ID, version: INTERACTIVE_TAILWIND_RUNTIME_VERSION },
  ],
  narration: {
    schemaVersion: 'reach-interactive-narration/v1',
    text: 'Select two fourths and compare their combined area with one half.',
  },
} as const satisfies InteractiveScene;
