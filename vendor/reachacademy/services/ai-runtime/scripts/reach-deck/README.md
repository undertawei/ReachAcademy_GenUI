# Reach Deck Offline Generation Acceptance

These scripts exercise the production Reach Deck prompts, schemas, parsers, worked-example
retrieval, static layout judge, NativeV2 compiler, and real Player renderer without starting the AI
Runtime HTTP server, model-service, content-service, or workers. The optional `--narration real`
mode calls the existing narration/TTS boundary and requires real word timestamps.

The harness injects the configured cloud LiteLLM and image endpoints directly. Production persists
generated media through content-service and OSS; offline acceptance stores image bytes and all other
artifacts only below `tmp/` or `.tmp/`.

The one exception is the **four-stage deck harness** below. It exists precisely to exercise the real
API, worker, and persistence without a login, so that what is observed there transfers to Teacher
unchanged. It has its own prerequisites and its own data impact; read that section before running it.

## Login-free real Player harness

Use the deterministic mixed fixture for the fastest end-to-end check. This command loads no env
file, calls no cloud model, and starts no product service. It mounts the complete
`reach-deck-document/v2` in the real `ReachDeckPlayer`, uses the Player's audio-free monotonic clock,
and then exits after desktop/mobile browser smoke:

```bash
pnpm --filter @reachany/ai-runtime accept:player-harness -- \
  --fixture mixed --smoke --output-dir tmp/reach-deck-player-harness
```

The mixed fixture covers a native entrance animation, a pointer-passive slide-level
`scientificVisual`, narration anchor fallback, the repository-owned function-plot dependency,
managed resource bytes, and a separate learner Interactive page that emits one learning event
and explicit completion. Use `--fixture scientific` to omit the learner page.

Keep the same viewer open for manual inspection:

```bash
pnpm --filter @reachany/ai-runtime accept:player-harness -- \
  --fixture mixed --serve --output-dir tmp/reach-deck-player-harness
```

The command prints a loopback URL and chooses a free port by default. `--port <number>` fixes it.
The local server exposes only prepared artifacts, bounded repository fonts, and the approved
content-addressed function-plot and Interactive science-kit chunks. Automated smoke additionally
aborts and reports any arbitrary external HTTP(S) request.

## Login-free four-stage deck harness

### Same-generation Slide evidence

The default workbench runs through the shared client/BFF, real API, queue and worker.
For Slide-only inspection, set `REACH_DECK_HARNESS_MODE=on` and
`REACH_DECK_HARNESS_SLIDES_ONLY=on` on the API, worker and workbench. Leave
`REACH_DECK_HARNESS_HTML_LAYOUT` unset. Slide-only mode disables narration/TTS rather
than relying on a prompt to avoid paid calls. Outline generation defaults to Slide pages;
adoption is a separate action with explicit page checkboxes (the first three are selected).
Adopting those pages starts the real generation chain and remains billable.

The same-generation evidence view lists individual jobs, including automatically advanced
pages and failed compilation attempts. It shows the immutable input request (outline and
design choices), actual provider prompt/version, original HTML, developer diagnostics and
the Native artifact from that exact job. It never regenerates or recompiles the page merely
to preview it. Visual diagnostics do not block a page or trigger model correction.

Evidence lives only in `tmp/reach-deck-generation-evidence/`, behind the harness gate, with
hashed scope/job filenames and a 12 MiB per-record bound. The loopback, same-origin
`GET /harness/generation-evidence?runId=...` route returns bounded task metadata; adding
`jobId=...` returns one record for the configured actor, role grant and module scope.
There is no production document or result schema addition. Local evidence contains source
and prompt text: do not commit, publish or share this directory as ordinary application logs.
The HTML preview is a script-disabled sandbox with server-allowlisted media hydration.

### Standalone HTML compiler trial (#579)

The existing workbench also supports a stage-three-only experiment. It calls cloud LiteLLM
directly, compiles a single static HTML slide to Native V2 in the browser, and renders it with
the real Player. Source, HTML, and V2 results stay in browser memory and disappear on refresh.
No login, AI Runtime API/worker, content-service, or database writes are needed. Model calls
are real and billable; this is not validation of the production generation chain.

From the repository root in PowerShell:

```powershell
$env:REACH_DECK_HARNESS_MODE = 'on'
$env:REACH_DECK_HARNESS_HTML_LAYOUT = 'on'
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- pnpm --filter @reachany/ai-runtime harness:deck -- --port 4180
```

Linked worktrees must resolve the canonical `infra/env/dev.env` from the main checkout when
needed, per AGENTS.md. Open `http://127.0.0.1:4180`, enter one slide's content in the existing
source field, choose an optional layout reference, and generate. HTML, Player, V2 JSON,
the exact submitted prompt, and diagnostics are available in stage three.

`REACH_DECK_E2E_MODEL` overrides the default `openrouter/openai/gpt-5.6-terra`.
The demo core prompt and four compiler/sample files under `html-layout/` are verbatim snapshots
from `html-deck-v2`; adaptation is appended as separate context. This trial supports static
SVG/figure content, not scientificVisual asset slots, narration, or TTS. Production migration
remains governed by `docs/plans/2026-09-20-issue-579-html-slide-layout.md`.

The other harnesses on this page replace the generation pipeline to isolate one boundary. This one
keeps the pipeline and replaces everything around it: the lesson plan, paged outline, page
artifacts, and narration are produced by the real AI Runtime API, the real worker, the real queue,
and the real model calls — the same code Teacher drives. What gets replaced is the login and,
optionally, the storage behind it.

Use it to change a prompt or the generation code, watch the effect end to end, and only then port
the change to the Teacher UI.

### What it adds over Teacher

Three things Teacher deliberately does not expose:

- every stage's intermediate data structure, as raw JSON;
- the complete prompt actually sent to the provider for that stage, read-only;
- per-snippet prompt overrides, so a stage can be rerun with different wording without a restart.

Snippet overrides are the only prompt editing offered. Stage templates assemble their snippets in
code, so changing **how** they are assembled still means editing `lib/reach-deck/prompts/stages.ts`
or `snippets.ts` and the corresponding frontend. An override naming a snippet the stage you asked
for does not use is rejected rather than silently ignored.

### In-memory content-service

Real content-service authorizes every Reach Deck call against a real course and a real role grant,
then persists the draft workspace, materialized document, and generated media to the shared
PostgreSQL/MongoDB/OSS. Running the pipeline through it would mean owning a real course, a real
teacher account with module management permission, and writing into a database everyone shares.

`harness:content` serves the same HTTP contract entirely in memory. The course, the permissions and
the storage are fake; generation, model calls, queue, and worker stay real. AI Runtime needs no code
change — only `REACHANY_CONTENT_BASE_URL` pointed at it. Everything is lost when the process exits,
and generated image/audio bytes are also written under `tmp/` so they can be inspected afterwards.

It implements what the pipeline uses: the resource context, workspace CRUD with the same
compare-and-set revisions, workspace recovery, materialize/rematerialize, the materialized document,
generated media (including narration word timestamps, lookup by idempotency key, and idempotent
re-posts), material assets, and the default voice selection. Module publication and teacher media
presigning return 501 — they are product features, not part of generation.

### One-time setup: a real organization and actor

The course, node, and module ids are fake and need no setup. **The organization and actor ids are
not.** AI Runtime projects every run into its own `public.ai_run` table, which has foreign keys to
`public.organization` and `public.account`; that table is not behind content-service, so the stub
cannot fake it. With the built-in defaults the first stage fails with:

```
insert or update on table "ai_run" violates foreign key constraint "ai_run_actor_account_id_fkey"
```

Borrow an organization and account that already appear in `ai_run`:

```bash
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
   -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
     SELECT actor_account_id, organization_id, count(*) AS runs
     FROM public.ai_run GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 3;"'
```

Put one pair in `infra/env/dev.env`. Both the harness and the in-memory content-service read the
same variables, so they must agree on the organization:

```
REACH_DECK_HARNESS_ORGANIZATION_ID=<organization_id from the query>
REACH_DECK_HARNESS_ACTOR_ID=<actor_account_id from the query>
```

Nothing is written to that organization or account beyond ordinary AI Runtime run rows and usage
accounting, which every generation produces anyway. The remaining `REACH_DECK_HARNESS_*` variables
only matter when pointing at the real content-service.

### Run it

Five processes. Only model-service and the LiteLLM/image endpoints reach outside the machine.

```bash
# 1. model-service, for narration TTS and word timestamps
cd java && npx -y @dotenvx/dotenvx run -f ../infra/env/dev.env -- ./gradlew :model-service:bootRun

# 2. in-memory content-service
pnpm --filter @reachany/ai-runtime harness:content

# 3 and 4. AI Runtime API and worker, pointed at it, on their own queue namespace
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  env REACHANY_CONTENT_BASE_URL=http://127.0.0.1:8001 REACH_DECK_HARNESS_MODE=on \
  REACHANY_QUEUE_NAMESPACE=deck-harness AI_RUNTIME_WORKER_SCENES=teacher.deck \
  pnpm --filter @reachany/ai-runtime dev
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  env REACHANY_CONTENT_BASE_URL=http://127.0.0.1:8001 REACH_DECK_HARNESS_MODE=on \
  REACHANY_QUEUE_NAMESPACE=deck-harness AI_RUNTIME_WORKER_SCENES=teacher.deck \
  pnpm --filter @reachany/ai-runtime worker

# 5. the harness page
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime harness:deck -- --port 4180
```

From a linked worktree, pass the main checkout's env path (`-f /path/to/ReachAcademy/infra/env/dev.env`);
never copy the file.

Three of those environment variables are load-bearing:

- `REACH_DECK_HARNESS_MODE` must be exactly `on`, and must be set on the **API and the worker**, not
  just the harness: the worker is what calls the provider and records the composed prompt. Without
  it the four stages still run, but the prompt tab stays empty and any override is rejected with 400.
- `REACHANY_QUEUE_NAMESPACE` is not optional in practice. The deck queue lives in the shared dev
  Redis, so without its own namespace a worker started by any other checkout on the machine — or by
  a colleague against the same Redis — claims the harness's jobs, resolves them against the _real_
  content-service, and fails them with "course node not found for exact draft scope".
- `AI_RUNTIME_WORKER_SCENES=teacher.deck` keeps the worker on the deck lane; the worker refuses to
  start without it.

Open `http://127.0.0.1:4180`. Paste a source text, create the workspace, then run the stages. After
the outline is adopted, the real generation chain advances the remaining pages on its own, exactly
as it does for Teacher; the page and narration panels rerun a single page.

**Model and TTS calls are real and billable in every mode.** For reference, one eight-page run of a
short Chinese physics source costs roughly: lesson plan ~15s, paged outline ~60s, then each page
about a minute of layout plus a minute of narration, with layout and narration running as two
independent lanes.

### Tuning a prompt

Slide layout now uses the verbatim demo core in `html-layout/prompts.ts`, with teaching context,
layout references, asset manifests and teacher preferences passed separately. It generates constrained
HTML and compiles it to a Native V2 artifact; the legacy JSON Slide snippets below do not control
this new layout call. Other generation stages retain their existing JSON prompt contracts.

The Worker needs local Chrome, or `REACH_DECK_HTML_CHROME_PATH` pointing to a compatible browser.
The current deployed base image has not been validated for this compiler; local acceptance does
not authorize enabling it in an existing production image. Browser failures propagate as dependency
errors. Production Slide HTML is generated once; invalid HTML fails without a model correction
or visual repair call. A page with visual intentions separately makes one durable four-route
expansion call before generating its assets and HTML.

In the full harness, a completed workspace is automatically materialized through the existing API.
Set `REACH_DECK_HARNESS_CONTENT_URL` to the in-memory content service origin to preview its images
and audio through the same-origin media proxy. Restarting that content service still clears the run.

The loop is: change wording in the page, rerun one stage, read the prompt that actually went out,
compare the artifact — then land the wording in code.

Only snippets can be overridden from the page, and each stage template includes a different subset.
An override naming a snippet the stage you started does not include is rejected, which is the fast
way to learn the mapping:

| snippet id                            | stages that include it                               |
| ------------------------------------- | ---------------------------------------------------- |
| `json-output-rules`                   | all seven                                            |
| `source-and-language`                 | all seven                                            |
| `single-session-continuity`           | paged-outline, slide, narration, quiz, interactive   |
| `scientific-representation-integrity` | paged-outline, slide, interactive, scientific-visual |
| `scientific-tool-selection`           | paged-outline, interactive, scientific-visual        |
| `learning-interaction-integrity`      | paged-outline, interactive                           |
| `text-field-rules`                    | slide                                                |
| `semantic-context`                    | slide                                                |
| `media-intent-resolution`             | slide                                                |
| `slide-authoring-quality`             | slide                                                |
| `previous-page-narration`             | narration                                            |

That rejection covers the stage you started, not the ones the chain reaches on its own. A page
generation auto-advances narration, and a narration rerun auto-advances the next page's layout;
the overrides travel with them so the chain does not fall back to default wording. Since those
templates include different subsets, the entries that do not apply to the stage being advanced into
are skipped there rather than failing a chain whose earlier model call has already billed. The
prompt tab is what tells you which ones actually landed.

Everything else lives in code. The stage templates themselves are in
`lib/reach-deck/prompts/stages.ts` (`LESSON_PLAN_PROMPT` … `SCIENTIFIC_VISUAL_PROMPT`), the snippet
bodies in `prompts/snippets.ts`, and the per-stage payloads — worked examples, previous-page
summaries, the theme catalogue, the resolved media manifest — are assembled in
`lib/reach-deck/generation-pipeline.ts` at each `generateStructuredJsonWithModelService` call.
Changing orchestration, that is what a stage sends or when the chain advances, means editing
`generation-pipeline.ts` and `generation-chain.ts` and restarting the worker; there is no runtime
switch for it, by design.

When a change is settled, edit `stages.ts` or `snippets.ts` for real and **bump that stage's
`version`** in the same edit. The version is written into the llm span metadata, so leaving it stale
silently merges the old and new wording in observability. Harness overrides mark themselves with a
`+harness-snippet-override` suffix so they can never be mistaken for a real version.

The prompt tab shows the complete provider request, schema included, for every model call the stage
made — which is more than one when a stage hits its in-stage correction retry. Reading it is the
only reliable way to see what the assembled payload actually contained; the template alone does not
tell you.

### Driving it headlessly

The page is a thin shell over the same endpoints Teacher uses, so an agent or a script can run the
loop directly — useful for sweeping several wordings and diffing the artifacts. Every deck endpoint
takes the six scope ids as query parameters and must carry the harness origin:

```bash
H=http://127.0.0.1:4180
Q="organizationId=$ORG&courseId=$COURSE&courseWorkspaceType=draft&courseNodeId=$NODE&moduleId=$MODULE&moduleVersionId=$VERSION"
curl -s -X POST "$H/api/reach-deck/workspace?$Q" -H "origin:$H" \
  -H 'content-type:application/json' -H "idempotency-key: $(uuidgen | tr 'A-Z' 'a-z')" \
  -d '{"source":"…"}'
```

The ids are the ones `GET /harness/config` reports, which also lists every overridable snippet with
its default body. From there each stage is start → poll → read → apply:

```bash
# start; the response carries jobId and pollPath
curl -s -X POST "$H/api/reach-deck/generation/lesson-plan?$Q" -H "origin:$H" \
  -H 'content-type:application/json' \
  -d '{"expectedDraftRevision":0,"promptSnippetOverrides":{"source-and-language":"…"}}'

# poll until status is completed or failed
curl -s "$H/api/reach-deck/generation/$JOB?$Q" -H "origin:$H"

# read the artifact and the prompts that produced it
curl -s "$H/api/reach-deck/generation/$JOB/result?$Q" -H "origin:$H"

# adopt it, so the next stage has an input
curl -s -X POST "$H/api/reach-deck/workspace/apply/lesson-plan?$Q" -H "origin:$H" \
  -H 'content-type:application/json' -d "{\"expectedDraftRevision\":$REV,\"jobId\":\"$JOB\"}"
```

`page-outline` works the same way against `/generation/page-outline` and
`/workspace/apply/page-outline`. Applying the outline starts the real chain, after which
`GET /api/reach-deck/workspace` reports each page's state and the remaining two stages need no
further prodding.

Three things catch scripts out. `expectedDraftRevision` is a compare-and-set token, so re-read the
workspace after every apply rather than counting. Creating a workspace needs an `Idempotency-Key`
header unless the body carries a `runId`. And a stage must be applied before the next one starts,
or it is rejected with "requires a current lesson plan".

Artifacts land where they can be diffed: `result.candidate` or `result.artifact` holds the
intermediate structure, `result.capturedModelPrompts[].serializedModelInput` the exact provider
request, and generated images and audio are written under `tmp/reach-deck-harness-media/`.

### Troubleshooting

Every one of these was hit while bringing the harness up.

| symptom                                                         | cause                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ai_run_actor_account_id_fkey` or `ai_run_organization_id_fkey` | the one-time setup above was skipped                                                             |
| `course node not found for exact draft scope`                   | another worker on the shared Redis claimed the job; set `REACHANY_QUEUE_NAMESPACE`               |
| `AI_RUNTIME_WORKER_SCENES is required for a Runtime worker`     | missing from the worker command                                                                  |
| `A separate worker is not used in Runtime mock mode`            | `REACHANY_MOCK_MODE=1` is set; mock mode disables the separate worker, so it cannot be used here |
| `harness content-service does not implement …`                  | the stub deliberately stops at generation; anything past it is a product feature                 |
| prompt tab stays empty                                          | `REACH_DECK_HARNESS_MODE` is not `on` **on the worker**                                          |
| an override changes nothing                                     | it was rejected — check the response; a silently ignored override is not possible by design      |
| page-outline job requires a current lesson plan                 | the lesson plan was generated but never applied; apply each stage before starting the next       |

Restarting `harness:content` clears every workspace, so a run has to start from a fresh source text.

### If you point it at the real content-service

Drop step 2 and leave `REACHANY_CONTENT_BASE_URL` at its normal value. This is the only way to
exercise the real authorization and persistence contract, so it is worth doing once before trusting
a change. It then needs a real course reserved for debugging, configured through the full
`REACH_DECK_HARNESS_*` set, and **it writes to the shared draft workspace and OSS** — pointing it at
someone's real course will overwrite their draft.

### Boundaries

The harness server binds loopback only, accepts same-origin requests only, refuses to sign a token
for anything but a loopback AI Runtime, pins every request to the configured debug course, and
writes its bundle only below `tmp/`.

## Login-free clone SSML harness

Start model-service in local development mode, then run the standalone narration editor harness:

Set `REACH_DECK_LOCAL_DEV_CLONE_ID` on model-service to select a specific active, consented clone.
Without it, the diagnostic endpoint selects the most recently updated eligible clone.

```bash
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime accept:clone-speech-harness -- --port 4173
```

Open `http://127.0.0.1:4173`. The page is generated below `tmp/`, mounts the real
`@reachany/reach-deck-editor` package, and talks directly to the loopback-only model-service
diagnostic endpoint. It does not start or add a route to Teacher, and it does not persist a Deck,
generated media, OSS object, usage event, or audio file.

The harness exposes `break`, `sub`, `say-as`, and `phoneme`, including all 39 allowlisted `say-as`
interpretations and the `py`, `cmu`, and `ipa` phoneme alphabets. `soundEvent` and root `<speak>`
effects remain representable by the Reach Deck DSL; root effects are available in this local editor.
The parameter forms open from their toolbar buttons. Preview uses the selection when present and the
complete narration, split into legal provider chunks, when no text is selected. Use the harness to
observe the actual result and judge whether each successful reading is linguistically correct. A
preview is a real provider call and may be billable. The model-service endpoint still rejects
non-local environments and non-loopback callers; the normal product clone path keeps its own
production authorization policy and supports the same four tags for active, consented Chinese clones.

The workbench can send the same selection as SSML in `req_params.text` with `text_type=ssml`,
SSML in `req_params.ssml`, or plain text. Two independent switches control
`req_params.audio_params.enable_subtitle` and `req_params.additions.enable_timestamp`; the latter
is serialized into the `additions` JSON string. The page compares the default voice and the active
clone, shows the exact selected source text beside the provider's native subtitle words, and
exposes the spoken alignment transcript and serialized SSML for inspection. A Deck-style subtitle
timeline plots every returned word against the audio clock, keeps a visible playhead, and names
timestamp gaps explicitly. Clicking a word seeks to its reported start time; playback supports
0.5x and 0.75x speed and timeline zoom. Multi-chunk timestamps are offset by measured MP3 duration. An empty subtitle panel
means the provider returned no words for that parameter combination. Native subtitle timestamps
are diagnostic data: two Derican01 SSML probes placed the first native word 0.46-0.50 seconds later
than ASR and the last native word 0.525-0.565 seconds earlier on the exact same MP3s. Listen and
check alignment before using provider-native timing for production.

Each preview track automatically sends its exact MP3 to **ASR Fast** through the local model-service
proxy. Native words, raw ASR words, and source-text alignment share one audio clock. The alignment
uses ordered matching; numbers and explicit SSML readings may appear as one coarse cue when their
pronunciation differs from the source. Terms and formulas can use the same coarse cue. ASR blocks
do not require a particular reading; too many mismatched source tokens, excessive ASR block expansion,
source-only or ASR-only gaps, weak anchors, and large time gaps trigger a per-chunk retry through the
existing Seed 2.0 Lite subtitle aligner on that chunk's original MP3. The Lite result still checks
the source reading, including normalized numbers. If neither result passes validation, the chunk
remains unaligned instead of displaying guessed source text. The status
shows coarse ASR blocks, Seed fallback chunks, and failed chunks. Click a cue to seek; slow playback
helps check the result. The native-minus-ASR first/last differences remain diagnostic: a positive
value means the native timestamp is later. ASR and Seed calls are real provider calls and may be
billable.

### Real Interactive science-kit matrix

Generate one page through the production Interactive prompt, schema, parser, and correction path for
every registered science kit, then mount the resulting strict v2 document in the login-free Player
and run desktop/mobile Chromium acceptance:

```bash
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime accept:interactive-science-kits -- \
  --output-dir tmp/reach-deck-interactive-science-kits
```

The cases describe the required learner operation without naming a runtime id. Each page must select
the expected specialized kit instead of the custom-document fallback, emit one valid typed marker,
declare the matching pinned dependency, activate its bridge, render nonblank pixels at desktop and
mobile sizes, stay within the iframe viewport, and make no external request. The output keeps each
artifact, generation diagnostic, before/after screenshot, network evidence, strict `document.json`,
prepared Player, and aggregate `report.json` below the selected `tmp/` directory.

Use `--kits solid-3d,molecule-3d` for a bounded subset or `--skip-smoke` when only model contracts are
being investigated. Both still call the real configured LiteLLM endpoint and can incur model cost.

### Inject a v2 document from code

`--document-file` strictly parses a repository-local `reach-deck-document/v2`. If it declares media,
provide a JSON resource map whose keys are exactly the declared resource ids and whose values are
repository-local files:

```json
{
  "media-example": "tmp/my-deck-assets/reference.png"
}
```

```bash
pnpm --filter @reachany/ai-runtime accept:player-harness -- \
  --document-file tmp/my-deck/document.json \
  --resource-map tmp/my-deck/resource-map.json \
  --timing uniform-preview --smoke \
  --output-dir tmp/my-deck-player
```

`uniform-preview` clones the parsed document, adds audio-free three-second narration windows and
`harness-preview:` entrance animations, and writes both `source-document.json` and `document.json`.
Scientific visuals remain visible from time zero so the full internal timeline can be inspected;
other slide elements reveal in stages. The source digest is rechecked to prove it was not mutated.
Scientific anchors use the production effective-duration fallback. This verifies deterministic
play/pause/seek/anchor behavior; it does **not** validate real TTS timestamps. Use `--timing document`
to preserve the input timeline.

Each prepared harness writes the Player page/bundle/styles, strict document, local assets, byte-size
and SHA-256 evidence, and timing evidence. `--smoke` adds desktop/mobile screenshots and
`smoke-evidence.json` with nonblank pixel spread, forward/backward seek animation state, distinct
early/late scientific iframe pixels, scientific nonce/anchor/dependency evidence, Interactive
events, and network evidence.
The fixture's `harness_scientific_present` parent message is an acceptance-only observability probe;
it is intentionally not a sample of production-generated script, whose AST gate rejects
`parent`/`postMessage` access.

## Single run

Load the canonical `infra/env/dev.env` from the main checkout. A linked worktree must pass that
checkout's real env path rather than copying the file or falling back to process defaults.

```bash
npx dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime accept:generation-offline -- \
  --pages 5 --media auto --output-dir tmp/reach-deck-generation-e2e
```

Useful options:

- `--source-file <repository-path>` uses a UTF-8 source file inside the repository. Files below
  `infra/env/` are rejected.
- `--pages <3-10>` fixes the requested slide count.
- `--media auto` applies production per-page `visualAssets` planning and image generation;
  `--media off` forces a text-led comparison run.
- `--scientific off` is the compatible default. `--scientific auto` enables the default-off
  scientific producer for eligible pages; `--scientific required` also fails unless planning and
  compiled output contain at least one scientific visual. Both require `--media auto` for planned
  visual assets. Add `--narration real` to run the narration model plus real TTS word timestamps;
  missing timestamps fail the authoritative run. Real narration also requires
  `REACH_DECK_OFFLINE_TTS_VOICE` to name an enabled official voice compatible with the speech
  markup. The runner validates this setting before model calls and has no implicit Vivi default.
- `--model <id>` overrides `REACH_DECK_E2E_MODEL` and the built-in default.
- `--output-dir <tmp/path>` selects an isolated artifact directory. The runner clears that exact
  validated directory before each run.
- `--help` prints the command contract without calling cloud models.

Each run writes the lesson plan, paged outline, page artifacts, NativeV2 JSON, generated image/audio bytes,
individual static Player PNGs, an HTML gallery, a contact sheet, the complete strict `document.json`,
`resource-map.json`, a prepared real Player under `player/`, and `report.json`. The Player copy uses
document timing when `--narration real` is selected; otherwise uniform preview timing is explicitly
marked as non-authoritative. The report includes a source digest, image/scientific/narration plan
and generation counts, per-page image and warning counts,
model-output diagnostics, media diagnostics, layout reference ids, and timings.

To reopen a cloud-generated document without rerunning the model, inject its saved files:

```bash
pnpm --filter @reachany/ai-runtime accept:player-harness -- \
  --document-file tmp/reach-deck-generation-e2e/document.json \
  --resource-map tmp/reach-deck-generation-e2e/resource-map.json \
  --timing uniform-preview --serve \
  --output-dir tmp/reach-deck-generation-e2e-player
```

## Batch runs

Batch mode reads a JSON manifest, executes jobs sequentially, preserves every run independently, and
writes one aggregate `batch-report.json` plus an HTML gallery. Sequential execution keeps cloud cost,
rate limiting, and failure attribution bounded.

```bash
npx dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime accept:generation-offline:batch -- \
  --manifest services/ai-runtime/scripts/reach-deck/offline-generation-batch.example.json \
  --output-dir tmp/reach-deck-generation-batch
```

Before spending model/image quota, validate and expand a manifest without touching output files:

```bash
pnpm --filter @reachany/ai-runtime accept:generation-offline:batch -- \
  --manifest services/ai-runtime/scripts/reach-deck/offline-generation-batch.example.json \
  --output-dir tmp/reach-deck-generation-batch --validate-only
```

Manifest shape:

```json
{
  "name": "prompt-regression",
  "defaults": { "pages": 5, "media": "auto", "runs": 2 },
  "cases": [
    { "id": "default-newton" },
    {
      "id": "custom-topic",
      "sourceFile": "tmp/reach-deck-sources/custom-topic.txt",
      "pages": 6,
      "media": "off",
      "model": "openrouter/openai/gpt-5.6-terra",
      "runs": 3
    }
  ]
}
```

Case ids are path-safe lowercase identifiers. A manifest may contain 1-20 cases, each case may run
1-10 times, and the total is capped at 50 runs. Failures do not hide later cases: batch mode records
the failure, continues, writes the gallery/report, and exits non-zero after all jobs finish.

Image generation and model calls can incur cloud cost. Inspect the manifest and total run count
before execution. The harness does not add visual-quality repair or automatic generation retries.

## Worked-example previews

To render the deterministic few-shot catalog without cloud model calls:

```bash
pnpm --filter @reachany/ai-runtime render:layout-examples
```

This produces the separate worked-example gallery under `tmp/reach-deck-layout-examples/`.
