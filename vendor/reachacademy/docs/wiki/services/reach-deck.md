# Reach Deck in AI Runtime

Reach Deck COPY restores saved teaching brief, lesson plan, and page outline values when the
source authoring workspace exists. Missing stages remain empty. A `copied` workspace contains the
selected published base document and optional saved authoring context, with no generation targets,
records, artifacts, or statuses. Opening it does not enqueue planning. Normal new-deck submission
still starts its first lesson plan automatically; explicit teacher generation remains available.
Legacy empty COPY shells are normalized on read without displaying their old provenance marker or
unrelated planning candidates. Compatible content-service, Teacher, and AI Runtime builds must be
deployed together for the new workspace stage. See [marketplace COPY](../product/marketplace.md).

An explicit single-page regeneration of a copied deck creates the page's first local request
(`attempt: 1`, `attemptReason: initial`); it does not import the source deck's generation history.
The request retains the regeneration idempotency key, advances the copied page's base revision,
and preserves the other pages. Later requests use the usual contiguous attempts and terminal-page
checks. Starting this first request requires a saved teaching brief, lesson plan, and outline
whose page identities and order match the copied base document. Missing context or a mismatched
outline produces a specific authoring error before any workspace write.

Narration eligibility is page-scoped: a materialized Native V2 slide without a local
generation request remains eligible for native narration and text-only rewriting
after another copied page starts generation. Slides with local requests retain the
workspace narration lifecycle, including ready pages and explicit failed retries.
Interactive pages retain their existing materialized narration lane. A new mixed
narration batch selects the lane with greater usable page coverage for the requested
operation (native must exceed workspace; positive ties retain workspace, while zero
coverage preserves an existing native-only lane and its per-page skips). Overwrite, readiness,
native bindings and unsupported workspace text-only operations affect coverage. It uses
the existing uniform batch source and reports pages outside that lane as skipped;
ordinary generated decks with a new native page retain workspace batches when that
lane covers more eligible pages. Exact accepted requests recover their original source and hash. Native
revision filtering requires proven job provenance, since native and workspace
requested revisions may coincide. Response-only source and affected-lane metadata
does not change the persisted recovery or batch schemas.

Bulk narration admission captures one authorized recovery snapshot and queue views
outside the writer lease (four concurrent reads, one-second read timeout, four-second
queue phase deadline). Inside the lease, latest descriptor identities and workspace
requests are checked without per-page queue calls. New or changed unresolved jobs and
queue failures return retryable `NARRATION_ADMISSION_RETRY` (409); missing/terminal
records and applied results release admission. Pending durable narration still owns
its source revision. Dispatch preserves claimed job identities and uses dependency
backoff for transient admission errors. Display reads remain bounded and independent:
20 payload provenance reads plus up to 40 additional live views share one queue;
registered jobs without proven terminal state conservatively count as activity.
An existing same-job queue retry can change execution state without a new descriptor,
so this snapshot does not guarantee exactly-once generation. Bounded close awaits
also cannot force-disconnect a hung connection through the current queue interface.

Classroom Quiz answer image upload, paste and camera capture use the configurable
[shared learner editor](../product/learner-editor.md), with the existing Deck answer
schema and authorized inline-image upload adapter.

Student also exposes authenticated, read-only learner content through
`GET /api/student/reach-deck/track-modules/{selectionId}/content`. The owning BFF calls
existing student-service APIs with the current student session, returns the published
document and current attempt with `no-store`, and checks selection/version identity.
It never creates an attempt or returns service tokens. This supports the
[test-environment load data preparation](../../../tools/student-load/PREPARE-TEST-DATA.md)
command; that command requires a compatible Student frontend release.

Reach Deck authoring and generation are native to `services/ai-runtime`. The private API listens on
`:3050`; browser requests retain the owning role frontend's `/api/reach-deck/*` BFF routes, which
forward to AI Runtime's `/api/reach-deck/*` namespace. The `teacher.deck` Scene has its own BullMQ
queue, concurrency, heartbeat, and worker deployment.

The durable learner document contract is v2-only: every producer, parser, materialization write,
Teacher Trial, publication gate, and Student playback path uses `reach-deck-document/v2`.
`reach-deck-document/v1` is not parsed, upgraded, regenerated, republished, or deleted. The cutover
inventory contains 42 retained v1 documents (24 draft and 18 published); all are unsupported after
the cutover, including the 18 published documents, which cannot be played. Scene-level names such as
`reach-quiz-scene/v1`, `fill_blanks/v1`, and `reach-interactive-bridge/v1` remain current nested v2
contracts and do not imply document/v1 compatibility.

The same fail-closed rule applies to any stored v2 document that still has a legacy `scene` projection
on a slide page (the former dual-representation shape). It is not converted, repaired, or bulk
rewritten. Teacher, Decksmith, publication, and Student boundaries reject it with an explicit v2
contract error; operators must replace or republish the content through a native-only producer. No
feature flag, staged rollout, rollback reader, or database migration is provided for this cutover.

## Default prompt versions

The approved 2026-09-24 revision in `prompts/corpus/` is the default source for future generation
and prompt changes. The corpus version is `reach-deck-capability-corpus/2026-09-24-v5`;
Stage 3 uses `paged-outline/v60-capabilities` composed from `paged-outline/v59-inquiry-scaffold`,
and scientific JPG/GIF authoring uses `genui-diagram-media/v2`. The derived
`genui-diagram-media/v2/routing-v3` visual policy changes media cache keys so new requests cannot
reuse v1 receipts. In limited space, the diagram prompt repositions labels to avoid obscuring the
main graphic.

API/worker processes must load the updated code through a restart or deployment. Existing completed
outlines and pages are preserved; new generation or explicit regeneration uses the new defaults.
The versioned corpus snapshot locks the approved content and versions. See the
[revision record](../../plans/2026-09-23-reach-deck-capability-integration.md#default-prompt-revision--2026-09-24).

### Unified editable page specification

Stage 3 emits `reach-deck-compact-outline/v4` (prompt `paged-outline/v67-scene-spec-v3`) using the
teacher-editable `reach-deck-instructional-spec/v3` contract. Each page carries `pageRole`,
`pageJob`, `keyPoints` and `knowledgePointIds`; Slides additionally keep `visibleTitleMode` and
density. The older `teachingMove` enum is derived from the role, not authored separately.

Rejected generated outlines retain strict canonical validation and collect bounded diagnostics:
`reasonCode=structure-invalid`, `issues` (schema-owned field path, stable code and static message),
and `issuesTruncated`. Paths use zero-based indexes, so `outline.pages[6]` identifies page 7.
The same issue list reaches the existing worker `output-correction` / `output-rejected` logs and
model correction feedback; the worker log retains job/run correlation. Collection includes independent
page, visual-asset prompt and reference-category errors, with at most 16 issues and 8 KiB of serialized
diagnostics, plus traversal limits. It never includes arbitrary input keys or values. Unrecognized
outline validation exceptions receive generic feedback. The default remains one correction attempt;
raw rejected-output evidence remains separately opt-in, and these diagnostics do not repair or accept
invalid outlines. This is outline planning, before individual page generation.

Page-stage contract rejections (slide, quiz, interactive, narration and the other non-outline
stages) add `detail` to the worker `output-correction` / `output-rejected` log lines: the validator
message, whitespace-collapsed and cut to 500 characters. The same bounded text is stored as
`failureDetail` on the `run.failed` and `run.retry_scheduled` events and on the `run.job.failed`
worker log line. It may quote fragments of the model output, so it never enters `ai_run.error`, the
public job error or any teacher-facing response; `teacher.deck` events are service-only and
Decksmith page history does not project `run.failed`.

Slides plan their complete `visualAssets` directly in the outline (reference-image, typed diagram
routes, scientific-visual and image); there is no separate visual-intent expansion call. Retired
`visualIntents` on old outlines become editable reference text, never a media plan. Quiz owns
optional answer evidence; Interactive uses `interactionBrief` (learner action, experience goal,
optional advisory hints). The Teacher form follows the page type and edits these fields directly.

Teacher adoption does not require complete teaching fields, titles, durations, references or Slide
classifications. Invalid optional planning structures are preserved as editable reference text.
Scene dispatch, identity, order, authorization, revision CAS and resource integrity remain enforced,
and fresh model output is still validated strictly. The Quiz stage keeps its existing question
types, including fill-in-the-blank. See the
[alignment plan](../../plans/2026-09-25-stage3-test-alignment.md) for the originating design.

### Course background artwork

Reference-design outlines register host-owned `backgroundGroups` (`{ id, slot }`, ids such as
`background-body-1`, never page ids) when the outline is adopted, and each slide page references
one by `courseBackground.groupId`: the first cover, agenda and closing pages get their own groups
and the remaining slides split into 1–3 contiguous body groups. Later inserts join the neighbouring
body group; edits, deletions and reordering never regroup pages or change a registered id. Artwork
is stored under the media segment `course-background:<outlineId>:<groupId>`. The first page of a group to be generated pays for one
16:9 image (`course-background/v1`), stored per run and group with the theme veil baked in (cover
0.2, agenda 0.78, closing 0.68, body 0.84); every other member and any regenerated page reuses it.
The slide's Native background becomes that image, so no extra element is added for teachers to
edit. A failed background is diagnostic-only and leaves the page on its solid theme background.

### Subject typography

The reference outline chooses `designContext.typographyProfile` once per deck (prompt
`compact-reference-v10-table-capacity`): `humanities` for Chinese literature, classical texts and
poetry, history, philosophy, ethics and the arts; `general` otherwise. It resolves to bundled
fonts only: general keeps Source Han Sans VF, humanities pairs Source Han Serif SC titles with LXGW
WenKai body text. The HTML model receives `StyleSpec.fontDisplay`/`fontBody`
(`html-native-v2/capabilities-reference-v7`), the compiler maps generic families to the body font
and still falls back to Source Han Sans VF per run for uncovered glyphs, even when Source Han Sans
VF itself lacks a character such as subscript digits (the glyph may then not render, but the page
does not fail), and the Native theme resource carries the pair. Snapshots saved without the field resolve to `general`.

## Generation lifecycle

### Material upload and admission

Teacher sends the complete first-stage multipart batch through its BFF to
`POST /api/reach-deck/tools/material-prepare`. AI Runtime validates actual file counts and bytes
before sequential server parsing, then owns deduplication, complete source composition, web
evidence, and reference manifests. The browser receives an opaque preparation ID, counts,
capacity diagnostics, and extraction warnings; it does not receive or reassemble parsed Markdown.
Raw originals exist only for the request. A scoped Redis record binds the actor, role grant,
module scope, original brief, and options for one hour. Workspace create/source update resolve
`materialPreparationId` from that record. Extraction diagnostics do not require confirmation;
the legacy `acceptMaterialWarnings` field is accepted and ignored. Expired preparation records
require re-uploading. Accepted source and bounded `materialSources` inspection metadata are
persisted through the existing private content-service workspace contract.
Material identity treats LF, CRLF and CR as equivalent line endings, while retaining the original
brief and source digest in the prepared record. Actor, billing group, role grant, complete draft
scope, language and web-search options still have to match. The reader also accepts the bounded
legacy identity variants for existing one-hour preparation records; it never derives caller
authorization from the stored source. Complete the AI Runtime API rollout before accepting the
multiline regression: an old API replica can still reject the equivalent JSON brief. Rolling back
the API can reintroduce this rejection; existing records expire normally without a data migration.
The complete material upload endpoint bypasses Teacher's 26 MiB proxy body clone, while its BFF
still authenticates the session and draft scope. Temporary image assets retain the existing
content-service lifecycle: the hourly janitor reclaims unused assets after the default 24-hour
retention; prepared images are promoted to stable material storage when bound to the workspace. Independent
preparation attempts use different upload run identities so candidate cleanup cannot delete a
concurrent winner's assets. Accepted prepared workspace creation is recovered by deterministic
request identity even after the Redis preparation expires.

The limits remain 50 MiB per document, 15 MiB per image, 200 MiB per batch, 64 files/references,
60,000 UTF-16 units per parsed document, and 95,000 for the composed source. Excess evidence is
rejected explicitly rather than prefix-truncated or omitted. The shared Office parser extracts
PPTX text and supported original images referenced by visible slides, excluding orphan package
media; Reach Deck explicitly enables original-image extraction and does not rasterize every slide.
Feedforward keeps its text-index preparation and on-demand slide rendering for complex
visual content. XLSX reference extraction remains text-only. DOCX embedded PNG/JPEG/WebP images
are identified by their actual signatures, including misdeclared WebP images. PDF extraction
continues to use model-service MinerU. The private legacy material-parse endpoint still accepts
one original file.

Generate immediately enters material preparation and teaching-plan loading. Stage 2 exposes a
read-only reference dialog when uploaded materials or web research were used, with one tab per
document and a separate research tab. Ordered text/image blocks, extraction diagnostics and
excluded search results survive refresh and Redis preparation expiry in private authoring metadata;
they never enter published learner documents. Image previews require current workspace membership
and module authorization and only issue temporary download URLs without mutating assets.
External evidence is cleaned of illegal control characters and malformed Unicode before admission;
PDF binary/index content is excluded while readable PDF research is retained. Polluted legacy
managed web evidence is cleaned at generation consumption before request hashing; already-valid
legacy source remains unchanged to preserve receipts. Authored briefs and teaching plans retain
strict validation.

Inspection metadata is limited to 1 MiB, 2,048 blocks per document and 4,096 per workspace; repeated
images share stable asset references. Deploy the compatible content-service preview endpoint,
Teacher, AI Runtime API and Courseware workers together: older workspace readers reject the new
optional metadata key. This change does not introduce a SQL schema or publication-data change.

Preparation, workspace create/source update, and lesson-plan enqueue check the full structured
lesson request against the authorized model-service capacity policy. Admission reserves two
thirds of the operational input budget for generated plans, page contexts and correction turns,
plus the largest staged output reserve. Every staged worker checks its actual finalized model
input again before dispatch, including correction rounds. Policy unavailability blocks generation;
workers retry the unpaid capacity preflight up to three times before applying the existing stage
retry policy, without replaying earlier provider turns. Capacity excess remains terminal.
the transport fallback does not authorize it. Estimates use serialized UTF-8 bytes plus structural
cost, not exact tokenizer counts. Images are referenced through scoped assets rather than all
being inserted as image pixels into each text-model request. Automatic chunked reading is not
implemented; the [Issue #714 plan](../../plans/2026-09-30-issue-714-deck-import-materials.md)
records the long-material skill research.

Stage 2/3 fresh model output is checked for invalid Unicode and control characters before DSL
normalization. The check rejects NUL and unpaired surrogates without rewriting facts or examples;
the existing bounded correction request can produce valid replacement text. Stored legacy lesson
plans remain readable. Outline preparation validates the full frozen input before replay or new
recovery registration, returning `OUTLINE_INPUT_TEXT_INVALID` with a field path when the teacher
must regenerate or correct the Step 2 plan. This avoids registering a recoverable job whose JSONB
input cannot be persisted. New lesson-plan and paged-outline provider calls, including corrections,
disable complete-response caching; completed durable task results retain their original idempotency.
See the [planning-output repair](../../plans/2026-09-24-deck-planning-output-safety.md).

A generation request creates one immutable BullMQ job. The worker owns the model turn and keeps running when a browser or role-frontend SSE connection disappears. Decksmith progress events are appended to a namespaced Redis Stream, while the durable job/result record remains the recovery source after the stream expires.

The Teacher editor shows streamed text and tool activity for both newly started and recovered
Decksmith jobs. After 10 seconds without visible text/tool progress it adds “可能正在排队，请耐心等待，
或停止后重试。” (with an English catalog equivalent), retaining the last progress label. New text,
tool start or tool completion restores the normal progress display and renews the waiting timer;
connection heartbeats and status polling do not. This is a model-independent waiting notice and
does not diagnose the provider's queue state. After a confirmed stop, the same row shows a stopped
state and replaces its stop button with a retry icon. Retry explicitly sends that page's stopped
request through the normal new-request path against the current draft. A successful new topic or
conversation deletion clears its retry entry, as does a new user request; a failed control does
not discard it. Cancellation failure keeps the running stop control. The notice and stop action
do not automatically replay a model call.

Within the live editor, retry retains the stopped request's selection and references, while the
host rebuilds authorized context from the current draft. Recovered jobs match their actual run's
user-message ID within the current topic; history alone retains the prompt, so this fallback uses
current-page context and does not guess an unavailable original selection. Retry is isolated by
page and topic, waits for confirmed cancellation and rejects duplicate clicks and late old results.

Slide generation has two independent, ordered lanes. The layout lane generates pages in outline
order and validates structural, resource and safety contracts. Once the first renderable page lands, Teacher performs the initial
draft materialization so ready pages can be displayed and edited while pending or failed siblings
remain native placeholders. The narration lane generates narration and TTS audio in page order;
slide pages additionally generate timestamp alignment and reveal animation, while Interactive pages
use one paragraph and explicitly request speech without timestamps. Subsequent landed
layout/narration/media results use digest-CAS backfill and never block later page layouts. Queue
priority favors layout work when both job kinds share one worker. Layout failures without a current
landed narration source do not block later pages' narration; narration failures with a valid source
still stop the narration lane. Previous-page context uses only the immediately preceding page's
available narration, never an earlier substitute. An explicitly regenerated earlier page takes its
normal place in narration order without regenerating already-landed later pages. An incomplete round is not
trialable or publishable until every target page has a real native binding and every present
Interactive narration has its declared audio resource.

### Reference design protocol

New outline jobs freeze `manifestVersion=reach-deck-reference-registry/v1` and carry the complete
reference coverage manifest, deck `designContext`, and page `designIntent`. The registry and source
snapshot live in `packages/reach-deck-dsl/src/reference-library/`; the generated Markdown coverage
is not a runtime input. The full library is imported through the `reference-library` package subpath.
All 251 entries remain addressable; advisory retrieval must not replace instructional relationships.

The saved resolved colors drive Native assembly, HTML, image prompts and function plots. Ordinary
outline adoption cannot change or strip the frozen design metadata. Every new outline job uses the
reference protocol; there is no environment switch or no-reference generation mode. HTML slide
generation requires the current library version and design metadata. Historical outlines lacking
them and mismatched library snapshots are rejected before model or media calls, with no fallback
composition, replacement reference geometry, or automatic data migration.
Reference pages normally use zero to three images and can use four when needed, with concurrency
still capped at three.

The versioned reference HTML adapter supplies safe text-token
pairs calculated from the saved opaque colors without changing that snapshot; these suggestions
do not replace actual composited contrast diagnostics (4.5:1 normal text, 3:1 large text/informative
graphics). Tables accept only semantic row/cell structure and inline cell text: captions remain
separate editable text, column widths belong on cells, and complex table backgrounds are rejected.
Small inline emphasis must use readable color pairs; structural style rejection diagnostics name
the invalid property.
New reference Interactive requests use the `/reference-v2` adapter, with intrinsic feedback sizing
and answered/restored/reset viewport checks. A one-item navigation layout is allowed when needed;
saved Interactive documents and legacy prompt paths are not rewritten.
The function-plot raster renderer `function-plot-png/v3` outlines labels using the bundled font
while preserving semantic text in its returned SVG. HTML mixed-size text retains explicit inline
line heights through Native and rich-text editing.

Reference HTML supports native semantic tables, seven trusted asset masks, and actual rendered
contrast checks. The table budget (8 rows, 6 columns, 48 grid positions, 240 codepoints per cell and
2400 per page) is a generation-side readability target, not a Native DSL limit. The outline
(`compact-reference-v10-table-capacity`) and layout adapter (`html-reference-layout/v19`) prompts
present it as a guideline: keep the source table's structure and orientation when it fits readably,
never transpose fields into rows, and combine adjacent related fields only when it would not fit. A
compiled table that still exceeds the row/column budget is kept when the browser measures it on the
slide with every cell's text inside its content box; otherwise cells beyond the budget are merged
into the last column/row (headers joined with `／`, data cells on a new line) and re-measured. Grid
and text budget overruns are diagnostics, not failures.
Ordinary slide HTML has exactly one generation call: no output-correction turn and no automatic
BullMQ replay, including transport or compiler failures and older queued jobs configured for three
attempts. A failed slide requires explicit teacher regeneration; other scene retry policies are
unchanged. Collision, overflow, clipping, out-of-canvas, contrast and table text-fit findings are
developer diagnostics only (at most 100 per page, five per element), not teacher warnings or gates.
Off-stage content can be clipped by the player and obscured HTML table text is still retained in
Native cells; inspect the actual HTML and Deck to assess quality. Safety, exact canvas dimensions,
finite positive geometry, schema, required asset/table identity and resource budgets remain hard
failures, without a paid correction.
The compiler recognizes standard LaTeX delimiters `\(...\)`, `\[...\]`, and `$$...$$`
in text regions. Single dollar signs remain currency. Host-owned KaTeX and bundled fonts render
formulas before measurement; Native output preserves editable `inlineMath`/`blockMath` source.
No model-authored script or CDN is required. Invalid, over-complex, or table-cell formulas retain
their literal source with a developer diagnostic rather than rejecting the slide.
V9 adds math-specific composition guidance: inline versus display use, separate captions,
structure-dependent height estimates, and spacing before surrounding text. These are design
suggestions, not validation thresholds; the v9 real replay still overlaps its main fraction caption.

After fonts load, bounded local autofit measures simple absolute text blocks. It first tries safe
width/height growth, including an unambiguous background carrier and its bottom inset, then at most
10% font reduction with an 18 px floor. Existing text below 18 px is not reduced further.
New overlap or canvas overflow prevents an adjustment. Implicit two-line wraps with a final line
of at most 1.5 characters also receive measured-width fitting, regardless of total text length;
explicit breaks remain unchanged. Standalone display formulas have a separate KaTeX-measured
height fit: grow safely first, then derive and remeasure a smaller font with a 24 px floor, without
further reducing already smaller formulas. Complex text, mixed-size shrinking, tables and inline
math mixed with prose are excluded; unresolved fit remains diagnostic-only, without model retries.
Real-sample replay and browser checks are recorded in the
[text investigation](../../plans/2026-09-21-reach-deck-text-width-investigation.md).
These generation limits do not truncate historical imported tables. Tables remain editable by cell
text only and expose one narration anchor. Image-fill shapes retain their resource ID and use
`ariaLabel` for narration. Text or cell edits preserve existing narration/audio and show a localized,
nonblocking stale hint; only explicit successful regeneration updates the narration content baseline.

After a current page failure is persisted, the sequential generation lane advances under the same
writer lease without retrying that failed page. Advancement is best effort: if advancement itself
throws, it is logged and the lane can remain pending until an explicit page retry. The structural
mutation reconciler does not retry this advancement. Cancellation does not advance the lane, and
an image-cache miss rechecks cancellation before dispatching a paid image request.

Implementation checks and real-generation acceptance are tracked separately in the
[verification report](../../plans/2026-09-21-reach-deck-reference-library-verification.md).
Failed provider output is not a successful sample, even when local unit tests pass.
The local four-stage workbench uses the shared client/BFF/API/worker and can retain same-call
outline, prompt/version, raw/prepared HTML, Native artifact and developer diagnostics per job under
`tmp/reach-deck-generation-evidence`. Capture requires `REACH_DECK_HARNESS_MODE=on`; raw HTML is
not added to production artifacts. Adding `REACH_DECK_HARNESS_SLIDES_ONLY=on` disables the local
narration lane and explicit narration jobs, without changing production narration behavior.
In that explicitly gated mode, a completed slide waiting for intentionally skipped narration can
be regenerated through the single-page route. The existing writer lease and revision check wrap
the atomic transition; ordinary production narration locks and incomplete layouts remain unchanged.
MAIC table font loading uses Node's native module resolver via `process.getBuiltinModule`
so Webpack cannot turn filesystem paths into internal module IDs. Fonts remain bundled
and covered by the existing MAIC output-tracing entries; there is no network font fallback.
Terminal failures in the automatic workspace page chain remain visible on the failed page while
the existing writer/CAS path advances later layout and narration pages. Narration uses an actual
immediate predecessor's narration when available and omits it otherwise. In-progress automatic
retries still belong to the current page; cancellation, paused or obsolete runs, and explicit
coordinated narration batches keep their existing dispatch boundaries. Capacity/admission failures
before a page job is registered retain the existing stop behavior.

“Regenerate this page” creates a new page attempt and job. Page model calls (including GenUI visual
routing/authoring and narration) bypass upstream complete-response caches; durable results and
generated-media receipts still protect completed work within the same job. This changes transport
cache policy, not model prompts or examples; lesson-plan and paged-outline calls bypass it as well.

### Content language and application locale

Teacher's `zh-CN` / `en-US` locale controls application-owned UI copy only. It is not a lesson
language selector and is not sent as the staged generation language. In the current generation
contract, learner-facing content, teacher-facing generated content, and narration use the dominant
language of the trusted teaching brief and supplied materials. A future explicit language override
would require its own trusted request-envelope contract rather than inference from the UI locale.

### Source material reference limits

One generation workspace accepts at most 64 material references at its browser preflight, create,
source-update, and queue-write boundaries. Durable workspace parsing deliberately has no count cap,
so an older or temporarily over-limit workspace remains openable and can be repaired by removing
sources. Text references are authoritative and selected first. Remaining image capacity is allocated
round-robin across PDFs after SHA-256 deduplication; duplicate and excess temporary image assets are
reported to the teacher and deleted through bounded, retryable cleanup.

The workspace limit is independent from the stable downstream limits: a generated page receives at
most 32 material references, an outline page may name at most eight reference ordinals, and one asset
cleanup request deletes at most 32 assets. Asset cleanup returns a result for every requested ID,
continues after individual failures, treats repeated temporary deletion and same-module stable assets
as idempotent success, and persists the deletion tombstone before removing the OSS object.

### Teacher authoring media uploads

Teacher-authored image, audio, video, and question attachment files upload through the same-origin
Teacher BFF, which sends upload metadata and Reach Deck resource scope to private AI Runtime.
Both Runtime authoring-media routes and its content-service client accept the `attachment` kind.
AI Runtime calls content-service to register a `pending` `public.object_storage_asset`. After the
Teacher BFF streams a presigned PUT to OSS, explicit finalize reauthorizes the course and draft module version, verifies declared
size and MIME with OSS `HEAD`, checks image/audio/video format signatures, and promotes the object into
`uploads/<organization>/reach-deck/<moduleVersion>/authoring/<kind>/...`. Deck documents persist only
that stable `objectKey`; Teacher preview and Student playback continue to issue short-lived GET URLs
after confirming the key is referenced by the authorized draft or published document.

The accepted pairs and limits are: PNG/JPEG/WebP/GIF images up to 15 MiB; MP3, WAV, OGG, AAC, FLAC,
MP4/M4A, and WebM audio up to 100 MiB; MP4, WebM, and QuickTime video up to 1 GiB. Filename extension,
declared MIME, byte count, and format/container signature must agree. Duration inspection and
transcoding are outside this upload boundary.

The `attachment` kind reuses Quiz's safe attachment upload type rules and permits at most 100 MiB.
Office requires the exact modern non-macro MIME/extension pair; archives and executables remain
rejected. Document attachments skip media-format magic checks. Finalize returns the asset identity,
stable object key, original name, content type and byte size; the asset ledger retains the original
filename. Attachment signing follows the
[shared presentation contract](content-service.md#attachment-presentation): the service decides
inline eligibility, Office/HTML/unknown types stay downloads, and downloads preserve cleaned names.

### Quiz question attachments

Teacher's native Quiz editor uploads and edits `question_attachments` through
`onUploadAuthoringMedia({ file, kind: 'attachment', signal })`. Shared DSL resource preparation
registers each referenced question attachment in `resources.media`, keyed by its exact object key,
alongside existing inline image resources. Documents contain asset metadata, not signed URLs.
Removing an attachment cleans generated attachment resource entries when no surviving document
reference uses them.

Student playback and Teacher Trial render question and short-answer attachments with the shared
attachment list/dialog and a host-provided `resolveAttachmentUrl(ref, disposition)` callback.
Editor preview/download uses its authorized authoring signer. Hosts without that callback use
the supplied media URL as an attachment signature: images/audio/video preview as subresources,
PDF/text offer download only, and no new-tab preview link is shown. Absent URLs remain
non-clickable. Default OSS follows the same policy even with a resolver; custom domains can
return actual inline previews. All labels come from the owning frontend's message mechanism.

Published learner media continues to require exact membership in `resources.media` and the owning
organization/asset scope. Marketplace signing includes referenced question attachments and Quiz
inline images by object key, without signing unrelated resources. Native question
`analysis_attachments` authoring/playback is outside this change; existing student documents already
contain analysis, so this change does not introduce a new server-side answer-release boundary.

While a workspace is still generating, Teacher uses the workspace plus a draft materialization as a
partial editor projection. Pending pages and compilation failures remain workspace status and may be
represented by explicit native placeholder bindings; a failed page with an older artifact keeps that
artifact visible. Placeholders are never accepted by Teacher Trial, publication, or Student playback,
and compilation diagnostics remain page-scoped while the failed page exposes retry/replace recovery.
Every playable or publishable slide requires exactly one real native binding. The current fixed `metadata.language: zh-CN` value is a
non-authoritative placeholder with no Player or generation-language consumer; it is not an assertion
about the language of the lesson content. Giving durable language metadata authoritative product
semantics would require a separate request and schema design.

Teacher editing and generation previews render the native v2 binding directly. Teacher Trial and
Student playback use the same native transport: poster before first play, deterministic
play/pause/seek, seven preset playback rates (`0.5` through `3`) plus a custom rate (`0.5`–`10`, step `0.05`), narration synchronization, and a frozen
current frame after playback has started. A static page with no authored timing uses the shared
five-second duration. There is no legacy `DeckPlayer` fallback.

Visual production runs after the paged outline and before HTML → Native V2 compilation. Every page
requires an explicit `visualAssets` array (empty is valid), with at most three assets, or four under
the reference design contract. The four routes are `reference-image`, `diagram`,
`scientific-visual`, and `image`. `mediaType` only classifies layout content. A planned image failure leaves a durable neutral bitmap in its planned slot and does not fail the layout.
The asset keeps its original route and frozen plan for explicit retry; cancellation and unknown paid
checkpoint outcomes still fail the task rather than being treated as ordinary image failures.
The obsolete `board-writing` and `renderFallback` generation fields have no compatibility reader.

`reference-image` calls model-service's managed Doubao image-search capability, checks every required
identity alias group in the title and independently in any nonempty description, excludes forbidden
terms, tries at most two safe HTTPS downloads, and immediately stores the image
as a managed PNG. One 15-second budget covers search and downloads, with at most one local transient
retry; a 429 is retried once only when Retry-After plus a useful request window fits the remaining budget. model-service maintains shared 10 QPS admission, Retry-After
cooldown, and a 30-second successful-candidate cache. Search profiles require a real effective rate
card (`requests` per provider call; cache hits record zero) and authorized Admin activation.
Tavily text research remains separate. Temporary signed image URLs never enter durable provenance.

`diagram` produces a complete static PNG before layout: restricted SVG/HTML, host-computed bar/pie
charts, function plots, bounded planar Euclidean geometry, or SMILES molecular depiction. Exact
geometry and molecular bonds use installed engines; free-form SVG is not a quantitative solver.
The renderer rejects scripts, external resources, blank output, overflow and unreadable/clipped
labels. It shares the compiler browser lock and bundled fonts. `scientific-visual` retains the
deterministic narration/playhead contract; `image` is reserved for imaginative or decorative art.

HTML layout v17 receives one semantic record per asset, with its displayed aspect ratio (including
EXIF rotation), source identity and invariants instead of source pixel dimensions or repeated planned
ratios. Transparent diagrams request a light carrier. Image styles go to image production only;
supporting and primary illustrations do not reserve space for slide text. Only an explicitly requested
hero overlay reserves it. New generated outlines minimally adjust muted text colors for 4.5:1 contrast
on the background and surface when a common black/white interpolation can satisfy both.

Layout failures without a current narration source do not block later pages' narration. A failed
narration with a current source still stops the narration lane. The local workbench displays layout
diagnostics as requiring manual inspection, without requesting model repair. Inline formulas use
bounded frame fitting without shrinking math or repositioning the composition.

Successful visuals expose stable `assetId` references and durable `resource.origin` metadata. The
same origin is projected into layout and initial/regenerated narration, preserved through content
storage and copying, and cleared when an editor replaces the underlying image. Missing source
licensing is stored as `unknown`; license display is deferred. Same-job persisted assets are reused
before billable work, and selected material references bind once without an extra search.

Slide attempts carry a shared ten-minute deadline and cancellation signal through model calls and
media production. Static source generation has a 120-second budget, followed by a 60-second
budget shared by browser scheduling and rendering; HTML compilation retains its 60-second limit.
API, Worker, model/content services, DSL and frontends must upgrade together after draining old jobs.
The Chromium base-image source is updated; building/publishing it and verifying the target pod's
non-root sandbox remain deployment gates. Local four-route acceptance progress is recorded in
`docs/plans/2026-09-24-deck-visual-integration-validation.md`.

Quantitative Cartesian visuals use the typed `reach-function-plot/v2` contract backed by
`function-plot@1.25.4`; Native chart elements remain outside the active generation profile. V2 keeps
the V1 evaluated-function form and adds bounded point series rendered as either scatter observations
or order-preserving data polylines. A series has at most 128 points, one plot has at most 256 points
across at most four series, every coordinate must be finite and inside the declared viewport, and
duplicate coordinates within a series are rejected. Parameters, markers, and intersections apply
only to function series. Readers continue to accept V1 artifacts, while new model output is V2-only.

Generated slide typography has three durable semantic tiers: `title` at 64/68 px, `body` at 30/42
px, and `caption` at 24/32 px (font size/line height). Both retained `legacy` and `v16`
`typographyProfile` values resolve to that same token set. Generated text uses the repository-owned
`Source Han Sans VF`; the generation model does not select a font. Formula nodes inherit the
containing tier rather than falling back to the browser's 16 px default. Capacity tables are
conservative, webfont-calibrated guidance for common CJK and Latin frames; rendered formulas are
treated as visual boxes rather than counted as ordinary LaTeX source characters.
Long formulas must receive a wider text frame or use a KaTeX-compatible aligned multiline display.
Player and Editor override the shared document-editor fallback so block formulas never create an
inner horizontal scroller; an over-wide residual formula remains visible for layout diagnosis.

The slide authoring toolbar exposes the same 15-family, self-hosted font catalog bundled by the
Player and PPTX importer. Its font-size control always represents a concrete numeric size: generated
tiers, compiled Native V2 runs, and imported PPTX runs retain their resolved numbers; non-preset
imported values are shown explicitly, and mixed selections use a non-actionable dash instead of a
misleading default-size option.

Native text `color` animations interpolate deterministically between `from.color` and `to.color` as
`#RRGGBB` values. The same computed override applies to ordinary rich text and inline/block formulas;
seeking backward recomputes the color from timeline time instead of retaining a later frame. Legacy
color effects without endpoints use the editor/player compatibility defaults.

A visible title text box is a generation soft constraint. Pages should normally include one. When a
composition genuinely does not need a title, the model must move, enlarge, or rebalance the other
elements so it does not leave an empty mechanical title band. Missing titles and real-DOM overflow
do not become production generation failures or retry triggers. The offline single-slide acceptance
tool waits for the self-hosted webfont and records per-frame DOM overflow and top-whitespace evidence
under `tmp/` or `.tmp/` for prompt and layout-contract iteration.

The first 2026-08-13 three-page offline comparison reduced DOM-overflowing text frames from 10 to 1
and the maximum vertical overflow from 35 px to 12 px after adding Source Han safe capacity and
complete line-box height guidance. A third real-model run after aligning the v1 CSS line heights
still varied to 8 overflowing frames with a 78 px maximum (2 offline-pass pages and 1
offline-warning page). These
runs demonstrate useful improvement as well as probabilistic residual quality; all deviations stay
visible in offline evidence for further prompt tuning and intentionally remain outside the
production completion/retry gate.

Narration is continuous speech split into short semantic segments around explanation and element
introduction points. A title element is always visible. Other top-level text, image, shape, and line
elements may selectively enter at a segment boundary; they are not required to animate, and text
boxes never animate internal word ranges. A bounded filled or stroked shape that visibly frames
instructional text is treated as that text's presentation container and should enter with it;
explicitly connected instructional arrows/lines may enter with their related content, while
full-page backgrounds, decorative dividers, and ambiguous lines remain static. Narration receives
existing generated line roles and Native connector/marker metadata, so an arrow may join a reveal
when its intent, semantic id, and the bounded-card topology agree; geometry alone does not establish
a relationship. The normal path derives segment timing from one whole-page TTS response with word
timestamps. Cache or upstream
failure paths may use the existing seven-second placeholder windows and must not be reported as real
alignment.

While a page is `narrating`, its landed layout is editable: elements can be selected, transformed,
text-edited, and changed through the timeline while narration/audio/animation generation continues.
Pages whose layout is still `pending` or `generating` remain locked. Existing-page edits are saved
through a page-scoped merge that includes both the published page and its optional Native V2 binding.
The browser serializes saves per page, coalesces rapid edits, and flushes before navigation, explicit
save, or publication. The server rechecks page locks on every content-digest CAS attempt and
preserves sibling pages, bindings, and resources. Late narration/media results do not reject a
genuine teacher layout edit: when the materialized page revision is newer, backfill preserves the
teacher's current native layout and merges only generated narration/duration/media fields. The
result is not automatically re-laid out; the teacher can explicitly stop or retry if regeneration
is needed. Identity changes such as a different run/attempt or narration digest still discard the
obsolete result. A theme change is accepted
only when no retained native slide binding needs to be carried forward. The v2 document does not
persist a native recompilation source or fingerprint for imported and teacher-edited bindings, so a
theme change alongside any retained slide fails explicitly. The system never silently mixes old baked
text colors with a new theme. This is an intentional capability boundary, not a deferred
compatibility path.

Both page-regeneration buttons expose a page-scoped submitting state immediately, including the
autosave and request-preparation interval. Only an acknowledged generation task is presented as
queued or generating; a stale failed workspace snapshot must not hide a newer accepted attempt.
Autosave failures and rejected starts remain visible on the affected page. A failed refresh after
acknowledgement does not discard the accepted task or report that submission failed. Existing CAS
and request identities remain authoritative; feedback changes do not silently resubmit conflicts.

The canvas activity entry and fallback summary also show standalone page requests
using worker progress. Unknown progress is indeterminate; provider completion while
landing or media convergence remains pending stays below 100%. Batch membership is
matched by exact job/chain identities across the current run, and newer requests
take precedence per page. Local preparation feedback hands over to the enqueue
acknowledgement before best-effort refresh; refresh must not reset an advanced job.
The timeline overrides existing ready content only on the operation's proven affected
lanes: text-only narration, animation-only, audio-only, or narration/audio/animation.
Unknown legacy modes retain conservative lane feedback. A newer standalone failure
or pending request survives an older completed batch, while a newer batch supersedes
older standalone feedback. Both Teacher locales use the same activity contract.

Decksmith applies the same scope: slide content is read and written exclusively through
`nativeSlides`; non-slide pages remain owned by their strict scene contracts and are not repaired or
normalized from historical title projections. A historical non-slide projection mismatch therefore
fails validation and must be corrected by an explicit producer before editing or publishing.

The paged-outline title editor reuses the same Teacher Tiptap/MathLive path as the other planning
fields while retaining the durable single-line Markdown string contract. Enter is disabled for this
surface and pasted line breaks are folded to spaces. Restricted-Markdown and Teacher Markdown
parsers identify complete math spans before HTML filtering, so raw `<` and `>` relation operators
survive inside formulas while real HTML and XSS outside formulas remain rejected or stripped by the
owning boundary. `\lt` and `\gt` remain valid LaTeX alternatives, not a substitute for this parser
ordering.

Lesson-plan and paged-outline generation describe only where a retrieval check belongs, its learning
target, and the evidence it should collect. They do not accept or propagate quiz-question counts and
the Teacher flow exposes no count control. A generated quiz page has exactly one top-level,
non-composite question; the durable quiz scene/editor/import contract remains capable of storing
multiple questions. When generating a later quiz page, the model also receives at most the three
nearest ready, revision-current earlier quiz summaries in page order. Each summary contains the
earlier learning objective, teaching move, question type, and plain question/cognitive evidence, but
never choices, reference answers, or answer analysis. This context is generation-time guidance for a
distinct assessment task; it is not a post-generation duplicate detector or publication gate.

## Narration authoring and generation

Interactive narration is a separate additive scene contract rather than a native slide binding. A
nonblank generated Interactive scene receives one canonical paragraph from the same model
turn that creates its HTML, so the instruction describes the actual controls and exploration intent.
The server sends that paragraph once to TTS with timestamps disabled, persists the stable audio
resource, and writes only `scene.narration.audioResourceId`. It never creates segments, word timing,
duration, scientific anchors, reveal bindings, or narration animations. Text-only Interactive
narration is a valid editable draft but is rejected by the publication gate until audio lands;
missing narration remains valid for legacy, imported, and intentional-empty pages.

`scene.narration.text` is one paragraph without line breaks or block formulas; when it is canonical
narration Markdown (for example with inline `\(...\)` formulas) it is read as Markdown, otherwise as
plain text. `reachDeckInteractiveNarrationMarkdown(text)` derives the single-paragraph narration
Markdown that anchors optional `scene.narration.speechMarkup` offsets, speech-preview selections,
and the speech-tool `narrationDigest`. Speech marks are present only when non-empty; they are saved
with the text and synthesized as SSML chunks without timestamp alignment (no timestamps requested,
no coverage check, no timings stored). A clone voice that cannot speak a saved mark is rejected
before enqueue with `TTS_SSML_UNSUPPORTED_VOICE`. AI rewrites produce new text, so their results
drop the old marks. The model never produces marks. Teacher, Student, AI Runtime API, and
Courseware workers share the strict `parseInteractiveNarrationValue` parser, and content-service's
`ReachDeckLearnerDocumentValidator` mirrors it (validating marks against the same derived Markdown);
older builds of any of them reject a whole document whose Interactive narration carries
`speechMarkup`, so deploy all five together (no rollout flag). Rolling back is unsupported while any Interactive narration still carries
`speechMarkup` unless that field is cleared first.

Interactive narration is the current write contract and has no runtime feature flag. Teacher saves
the narration (text plus optional speech marks) first, then directly requests TTS with the
authoritative content digest
(`reachDeckInteractiveNarrationContentDigestInput(text, speechMarkup)`; byte-identical to the
historical text-only input when there are no marks),
idempotency key, and optional superseded audio resource ID. AI Runtime reloads the materialized
document, validates that the digest and superseded resource belong to that document, and only then
enqueues the job. Revision, content digest, job identity, and landing CAS checks reject stale work;
the final reference scan removes the superseded audio only when no page still uses it.

Accepting the job is a durable fact, so the browser reports the teacher action as successful as soon
as the server answers 202. The state refresh that follows only makes the locked state visible one
poll earlier; when it fails the job keeps running and the editor keeps the page marked as generating
instead of showing a sticky save failure over audio that does land.

Chain-generated and materialized Interactive narration produce the same result value but land in
different places, and the durable job record carries no lane marker, so the manual artifact-recovery
route decides by ownership. It offers the result to the workspace chain first; when the chain
declines it, the materialized Interactive lane gets the same result and either writes the
materialized document and answers `NARRATION_APPLIED` like the Native lane, or returns its own
terminal discard code. Only a page that neither lane owns keeps the original chain-discard 409.
Before this fallback existed, every materialized Interactive recovery ended as a code-less 409 that
the browser classified as a revision conflict.

The Teacher Interactive narration panel is the slide narration editor's Interactive variant: the
same header menu, speech-mark toolbar (pauses, sound events, aliases, readings, phonemes, show
marks, smart marking, remove marks), selection preview, status and capacity row
(`{count} / 600` characters of `text`), minus every animation action, the text-only/audio-only/draft
regeneration splits, and the partial-generation group. Its menu keeps only `重新生成本页讲稿和音频`.
Speech preview and smart marking use the page-type-agnostic speech tools and are bound to the
Interactive page's `revision` exactly as slides are; a revision change during the request rejects
the result as stale.

Teacher can edit the single paragraph and choose `保存讲稿并生成音频`. A fixed-height status track below
the Interactive preview stays visible even when the narration panel is closed. It shares one task
view model with that panel and projects only real dirty, queued, generating, ready, and failed state;
it does not simulate progress or expose timeline controls. Player renders the paragraph and compact
play/pause/replay controls below the iframe without autoplay. Audio playback runs independently from
the Interactive bridge and completion mode, so audio end cannot complete the scene or advance the
Deck.

The timeline narration tab presents one page-level constrained Markdown document, not the internal
playback segments. Its editor supports plain paragraphs, line breaks, inline `\(...\)` formulas,
and standalone `\[...\]` formulas. It does not expose caption boundaries, segment/word timing,
duration, or reveal timing. Existing narration that has only ordered segments is displayed as one
document by joining those texts with blank lines; opening legacy content does not rewrite it.

Native v2 narration uses three compatible states:

- legacy: non-empty derived `segments`, with optional audio;
- teacher draft: authoritative non-empty `markdown` with no old audio or derived segments;
- generated: authoritative `markdown`, a stable page audio resource, and non-empty fully timed
  derived segments.

Saving teacher content first rematerializes the exact canonical Markdown through the existing
content-digest CAS. That atomic invalidation removes the old narration audio, segment/word timings,
and, by default, only animations whose ids start with `narration-entrance:`. The narration editor's
draft/apply flow explicitly retains existing animation design during invalidation. Teacher-authored
and imported animations remain. The page stays retryable but cannot be published until generation reaches the
complete generated state. The Java content-service publication command enforces this independently,
including native/PPTX modules that have no active generation state machine.

The animation timeline uses compact 24px animation rows, a 28px narration row, and a 20px ruler.
Its content grows with the local track count up to 112px before scrolling; generation feedback keeps
136px of space. Clip text hides on narrow intervals, with separate proportional resize grips and a
central move target. The header holds animation add/delete and zoom controls. Track deletion confirms
occupied tracks, deletes their animations through document history, and keeps at least one empty
track. Track placement is editor-session layout; undo restores animations and repacks their lanes.
Press-drag on the ruler, narration bar, or empty track space scrubs the playhead, pauses preview,
and clamps to page duration. Animation drags remain one undo group and include horizontal scroll
changes. Clicking the timeline or an animation gives the timeline keyboard focus. Space toggles preview;
Left/Right seeks by 0.1 seconds (Shift: 1 second), and Home/End jumps to the page bounds.
Delete/Backspace removes only the selected animation and never falls through to canvas-element
deletion. Locked pages still permit playback navigation but cannot delete animations.

An animation whose target element no longer exists (an orphan animation, usually a narration
entrance left after the element was deleted) does not fail document validation, so saving,
publishing and rendering continue. Playback ignores it and it does not extend the page duration;
narration `preserve` landing passes it through instead of failing alignment. The editor timeline
renders the clip red with a dashed border and a warning tooltip, and selecting it does not select a
missing element, so the teacher can delete it. New orphans are still refused where they would be
created: Decksmith animation upserts and element clipboard payloads require existing targets, and
rebasing a draft onto a newer server document drops server narration animations whose targets the
draft deleted.

The narration panel fixes `试听` and `保存讲稿并生成音频与动画` to its footer. The primary
save generates audio, timing, and narration-driven animations from the exact current Markdown/SSML.
The page menu contains `仅保存草稿`, `仅生成音频`, `仅重新生成本页动画`, and
`保存讲稿并生成音频与动画`; the whole-deck menu beside Publish contains the corresponding
four all-page actions, including `重新生成所有动画`. Animation-only actions are limited to native
Slide pages with saved canonical narration, an existing audio resource, and complete timing. They
regenerate narration-driven animation bindings while preserving narration, audio, timestamps,
duration, and teacher-authored/imported animations. The whole-deck `全部生成音频` confirmation offers
two animation modes: migrate existing narration-driven animation designs to the new speech anchors
(`preserve`, selected by default), or regenerate narration-driven animations (`regenerate`). Manual
and imported animations remain unchanged in either mode. Migration adds no animations to pages without
them, and Interactive pages generate audio only. The selected mode persists through autosave, batch
submission, retries, and recovery; a pending batch with another mode cannot be resumed by this action.
If a local media submission is awaiting retry, the dialog selects and locks its original mode rather
than resetting to `preserve`. An older `skip` submission exposes a retry-only audio option with an
explicit warning that successful generation clears animations. A pending animation-only submission
directs the teacher to `重新生成所有动画`. With no pending submission, `preserve` remains the default.
Preservation follows visibility rules: narration-driven animations on titles or always-visible groups
may be removed, and alignment failures fail the affected page.
The dialog uses the shared Dialog, RadioGroup, and Button components with bilingual copy and a
visible animation group label. Submission disables controls and closing until startup finishes;
failures remain inline with the selected mode available for retry. Per-page fallback failures include
individual reasons and queued/skipped/failed counts even when the follow-up status read fails;
multiline errors remain readable inside the dialog. A failed status refresh after
durable acceptance does not turn successful submission into failure. Closing restores focus to
the persistent whole-deck menu trigger.
Whole-deck operations use saved narration and exclude unsaved narration edits. The single-page
audio-only action still confirms that all animations on that page will be cleared after successful
generation.

Single-page audio-only and legacy whole-deck audio-only requests carry `animationMode: skip` through persisted commands, batch members, queue
payloads, and staged results. They generate captions, word timestamps, and scientific-anchor timing
without animation mapping. Successful landing atomically writes audio/timing and clears all animations;
failed or incomplete results retain prior animations. Page revision and document CAS guards reject
stale results after concurrent animation edits. Legacy narration conversion retains animation design for
audio-only and migration requests. Successful audio-only landing clears animations; migration retimes
existing narration-driven animations. Pending batches with another mode cannot be resumed by this action.
Teacher, API, and Courseware workers must deploy together to recognize the new mode.

Animation-only requests use `animationMode: animations` on the existing single-page
`/workspace/pages/{pageId}/narration/generate` route and the whole-deck
`/workspace/narration/media/generate` batch route. The API preflight verifies the saved audio/timing
identity, and landing compares the preserved narration digest before applying the new animation
bindings. No TTS continuation is created for this mode. Deploy Teacher, API, and Courseware workers
together; in-flight results require compatible readers during rollback.

The existing `preserve` API mode remains compatible: it retimes existing narration-driven animations
without adding new ones, failing with `NARRATION_ANIMATION_ALIGNMENT_FAILED` when alignment is
impossible. A visibility exception removes old narration-driven entrances for titles and their cards,
or shared card companions that must remain visible because a followed step is unbound or has no old
entrance. Teacher-authored animations are retained. These explicit `persistentElementIds` decisions
travel through the TTS continuation and completed result to landing; compatible API and Courseware
workers must be deployed together, and in-flight results require compatible readers during rollback.
The header retains `AI 重写本页` and `重新生成音频和动画` with their existing confirmations.
Interrupted starts reuse their idempotency key and animation mode; legacy pending commands retain
regeneration semantics. Duplicate same-page/same-content requests coalesce.

The whole-deck command menu retains separate bulk narration and media regeneration actions. Before showing the narration confirmation,
Teacher asks AI Runtime for an authoritative summary of existing narration and in-flight narration
jobs. When either exists, the dialog exposes an explicit overwrite checkbox. Leaving it unchecked
queues only eligible pages without narration; checking it regenerates every eligible page and may
replace narration-driven animations on those pages. Existing content is left untouched when the
checkbox is cleared.

### Narration reveal units and formula readings (Issue 705)

Narration-driven animation targets are derived per Native page, not per raw element. An explicit
`reveal-group:<id>` name (HTML `data-reach-reveal-group`) always wins. A textless card surface
(image or shape) that fully contains elements painted above it reveals together with them; nested
cards use the outermost one. When explicit sub-groups sit inside a card, the card and its unmarked
contents follow the sub-groups: they enter with the earliest one only when every sub-group actually
receives a reveal range, and otherwise stay visible so no text appears without its card. A sub-group
counts as unrevealed both when narration leaves it unbound and when its anchor matches nothing. Lines, textless shapes and
backgrounds covering at least half the canvas stay visible. Every other element is its own unit, and
a group is persistent only when it holds the title or a disallowed element, or when all members are
decorative. There is no per-page cap. The HTML prompt
(`html-native-v2/capabilities-reference-v10-table-budget`) asks for the attribute only for
card-less multi-part items or step-by-step reveals inside one large card. Existing pages gain
animations only after `重新生成音频和动画`.

Before TTS, narration that contains formulas makes one extra `narration` stage call
(`narration-speech-readings/v2`) for the whole page that returns a spoken reading per formula, for
example `AB比A撇B撇等于k`. The narration prompt (`narration/v30-math-notation`) requires every
spoken mathematical expression to use `\( \)` or `\[ \]`. Narration that still writes plain-text
math (`f(−x)=f(x)`, `x∈D`, `a₁+a₂`; detected by a cheap symbol, Greek, sub/superscript or `f(` check
outside formulas) also enables `findPlainExpressions` in the same call. The model quotes each such
expression verbatim with its reading, in order of appearance. The worker locates each quote
sequentially in the escape-decoded text outside formulas and maps it back to a canonical Markdown
range. A quote that is not found, crosses a caption cue, reveal range, or scientific anchor
boundary, or covers only Han text and punctuation is dropped and spoken as written. Dropped quotes
never trigger correction or fail narration. Accepted ranges use the same `formulaReadings` contract
and become atomic formula units. Teacher speech marks that overlap one take precedence. Teacher
previews use the same call, except course-agent voice previews, which do not support formulas. If
plain readings push a preview selection past the SSML chunk limit, the preview keeps only delimited
formula readings. Older workers reject plain-expression ranges in a TTS continuation, so the
Courseware workers and API deploy together as for the original readings. Readings are synthesis-only: they are never persisted in the narration or its
speech marks. They are generated once, before the first TTS dispatch, and stored as `formulaReadings`
on the TTS continuation. Every queued-TTS poll reuses them, so chunk digests and request identities
stay stable. Continuations written before this change carry no readings and keep the previous behavior.
Because older readers reject the new continuation key, API and Courseware workers must deploy
together, with compatible workers ready before the API accepts new formula previews. The page uses
the speech chunk projection, where each formula is spoken as its reading and stays one atomic caption
word timed from the provider window between its neighbouring anchors. Without teacher speech marks,
the provider receives the projected plain text, so formula readings do not require SSML-capable
voices. Formula projection requires full coverage under the nearest-anchor fuzzy alignment described
below, regardless of the provider input type; the reading itself is an avoided span and is never
compared character by character. Model-service also reconciles safe punctuation and case differences
in plain-text Seed fallback timestamps, using transcript alignment when needed and retaining legacy
provider words when no safe match exists.

A narration job waiting for TTS capacity re-enters the worker on every `pollAfterMillis` and first
reloads workspace and recovery documents. Each worker process admits at most 16 such re-entries at
once; a re-entry beyond that gate returns to BullMQ `delayed` after 2–5 seconds without any workspace
read, keeping its `waiting-tts` progress. Recovery no longer rewrites the TTS continuation when only
the jittered `pollAfterMillis` changed. The `waiting-tts` progress also keeps the queued request
identity. A re-entry first peeks that ticket (`peekReachDeckSpeechAdmission`), and while model-service
answers `queued` the job goes straight back to `delayed` with the returned backoff. That re-entry
skips the audit read, runtime resume, workspace reads and request rebuild. Peek failures,
cancellations and `proceed` answers fall through to the full re-entry. The poll route returns
`pollIntervalMs: 10000` for a `waiting-tts` job, and the Teacher workspace schedules the next poll
from each response's interval. Once a job's visible status has stayed unchanged for three polls,
Teacher doubles that job's interval up to 15 seconds, never below the server's interval. Any change
returns it to the foreground cadence.
A re-entry no longer rewinds the job progress below 65% (`waiting-tts`); the Teacher activity popover
shows “正在排队等待语音合成…” for that phase, and every unfinished single-page job there has a
Cancel action behind the existing cancellation confirmation.
Deploy the compatible model-service before enabling the new AI Runtime formula path. The provider's
own LaTeX parsing is not used. In 2026-09-29 probes, `\displaystyle` dropped fraction numerators in
plain text, and primes in SSML broke the pairing of every later formula. Invalid readings get one
in-stage correction; a remaining failure fails the narration job for retry and never falls back to
reading LaTeX. Interactive narration, which is synthesized without timestamps, speaks the same
readings as plain text; Interactive text that is not canonical narration Markdown (for example a
leading list marker) keeps the plain path without a reading call. The teacher speech preview never
calls the model before task registration, idempotency and admission: the API only marks a selection
with formulas as pending, and the executing worker resolves its readings once and stores them in the
task before the first provider attempt. Before admission the API validates structure, boundaries and
marks with a one-word stand-in per formula, so a long LaTeX source is not rejected for its source
length. Pending tasks store empty synthesis fields, which model-service rejects if an older worker
submits them. New workers also reject unresolved readings at the execution entry. The single-chunk
limit applies to the real readings in the worker; a selection that still does not fit fails as
`SPEECH_TOOL_INVALID_REQUEST`. Queued polls resend identical synthesis input. Formula previews without
teacher speech marks use the projected plain text. The editor timeline narration bar renders formula words with the same KaTeX static renderer
as the Player caption, inline and slightly larger than the surrounding characters.

`scripts/reach-deck/run-formula-speech-workbench.ts` runs `finalizeNarrationForNativeSlide` against a
local model-service: chunks are synthesized with a preset or clone voice, aligned by the production
ASR transcript aligner (then Seed, in production order) through the loopback-only `/asr` diagnostic
endpoint, which now accepts an optional `transcript`. The page shows the Player caption, the
persisted word timings and the editor timeline marks in sync with the audio. The 2026-09-29 run of
test deck page 5 with clone voice 4 aligned every chunk through ASR, and the formula word spanned
exactly its reading. The previous path, reproduced by the page's comparison mode, needed an inexact Seed
fallback on the formula chunk, stretched the formula to 17 seconds and left the last caption at 0–0.

### Image failures and individual retry

Planned pictures settle independently within a shared five minute image budget. A failed image is a
real PNG resource: neutral background and image icon, without text or controls. The layout model
still receives the planned asset, so ordinary asset presence and compiler validation remain strict.
Failed placeholders bypass masks and animated-image conversion. Slot-sized re-render failures retain
the successful initial render. HTML/model/compilation failures, cancellation, and unknown paid media
checkpoint outcomes retain their existing failure semantics.

Authoring-only `generationMetadata.mediaSlots` records the asset plan snapshot and digest, final
normalized element ID, binding, resource, status, attempt, and a safe failure category. An optional
`teacherReplaced: true` marker preserves manual replacement provenance after a later layout
regeneration, so a subsequent image overwrite continues to skip that resource. Learner
schemas remain unchanged. Existing pages without slots support layout regeneration but cannot use
image-only retry. The editor overlays retry controls and reason tooltips; the learner sees only the
bitmap. A missing or broken image URL also displays a neutral fallback.

The regeneration API accepts `imageScope: failed | all` when images are selected and optional
`assetIds` only for an image-only single-page request. Legacy four-channel requests default
`image = layout` and regenerate all images. Selecting layout selects images by default. Teachers
can deselect images to reuse existing media, or select failed scope to reuse ready matching plans.
Changed plans and deleted elements require fresh media; manually replaced resources are preserved.
If a teacher replacement cannot be downloaded or decoded, layout regeneration fails retryably and
retains the prior artifact. Upload admission limits file bytes, not pixel dimensions. Teacher images
supply a static WebP layout preview of at most 4 million pixels and a 4000-pixel longest edge, using
only the first frame for GIFs.
The final native resource still references the original upload. Both metadata inspection and preview
decoding enforce a 64 million input pixel limit; exceeding it retains the original artifact and returns
a retryable reuse failure. A system ready image that cannot be reused falls back
to generation. All manual image bindings are downloaded, decoded and validated before any paid
image, diagram or scientific-visual generation for the page starts. Validated bindings and previews
are reused within that invocation, so preflight does not download or decode teacher images twice.
Image-only retries use frozen slot plans and the existing page-generation queue, with batch stage
`image`; they do not call the HTML model or regenerate narration, audio, animations, or layout.
The page remains editable and a second image task for that page returns 409.

Landing checks the current element and its resource under the document writer lease. Deleted or
manually replaced targets discard late results. The existing bridge exposes separate document and
workspace CAS operations: image landing writes the rebased document first, repairs slot metadata
with a replay proof, and marks the durable job applied only after both finish. A retry repairs the
second write without another provider call. It does not provide a cross-collection atomic CAS.

The coordinator persists a limit of three image landing replays. Exhaustion fails the member with
`image-landing-failed` and retains its frozen payload and durable result. Independent members continue
when their frozen input fits the actual batch capacity, including narration after successful image
application. Only an actual capacity failure with no in-flight sibling able to release its payload
fails the new member; it is eligible for failed-lane retry rather than being cancelled with unrelated
work. Already dispatched members settle within the same bound without another paid generation call.
Manual adoption still applies a conditional slot patch using the frozen payload.
That proof is subject to the existing batch capacity and ten-terminal-batch retention limit; after
batch cleanup, adoption returns 409 `IMAGE_RECOVERY_CONTEXT_UNAVAILABLE` instead of replacing a page.

Image landing defers while native narration for the current page revision is running or has a durable
result awaiting landing, including work owned by another collaborator. Waiting does not consume the
three landing replays. The first wait timestamp is durable; after 30 minutes the member fails with
`image-waiting-narration-timeout` and retains its image result. Member checks and actual scheduling of
batches containing only waiting members use a 15-second interval. No full-page read occurs within
that interval. The recovery snapshot has no authoritative materialized page revision: the first
check and each interval expiry still verify the real document so teacher edits cannot leave images
blocked by stale narration. Reuse the loaded recovery snapshot and queue connection for narration
checks; final application retains current document, cancellation and CAS validation. Images then
rebase onto the latest document and retain the new narration,
audio and timings. Metadata-only repair after cancellation does not alter the document and can
proceed. Decksmith keeps its full page revision and content checks: image changes intentionally
invalidate an older proposal.

Completed queue work can lack a durable artifact when the worker exhausts its result-write retries.
The recovery reader preserves completion evidence even when queue-result backfill fails or the audit
is still missing/running. The coordinator reloads recovery before deciding that a result is missing,
persists up to three recovery checks, then fails with `generation-result-unavailable`, preserving
the frozen payload. It never re-enqueues paid work on this path, including after queue-record cleanup.
The Teacher distinguishes result recovery, unavailable results, narration waiting and timeout; an
unavailable-result message does not claim that a usable artifact was saved. Normal result retention
updates descriptors and results together, and strict parsing rejects dangling artifact references;
cleanup is not a normal source of a descriptor pointing at a missing result.

Freezing a new payload skips the materialized-document read when slots are empty. Nonempty slots
still require the current document to preserve teacher deletions and replacements; resource IDs are
collected once per page into a set. The existing bridge has no teacher draft page projection API,
so this remains a full-document read at payload freeze, with no cache across coordinator ticks.

Publication checks surviving failed slot bindings inside its writer lease and returns 409 with
`code: media_placeholders_remaining` and `details.pages: [{ pageId, assetIds }]`. Deleting or
replacing the failed element clears that block. Teacher preflight shows affected pages and can
locate the first element; the service response remains authoritative.

New metadata, five-channel plans, recovery descriptors and image-stage batches require compatible
readers. This release cannot roll back directly to old API or worker images after new records are
written. Follow the maintenance procedure below: after producers stop and all channels are empty,
idle old workers may remain during the sequential API-first rollout. Keep producers stopped and
all channels empty throughout the window, then finish compatible workers, observer and Teacher. Notify teachers and collaborators in advance to refresh old Teacher tabs after release.
Teacher has no deployment version detection or remote refresh mechanism, so refresh confirmation is
not a prerequisite for resuming generation. Old workers must not
consume alongside the new API. If old work cannot drain safely, defer the upgrade. A rollback requires
a reader compatible with the new records, or a separately reviewed restoration that preserves new
data and paid results. No queue, Worker Deployment, database structure,
model-service change, or feature flag is required. See
[the implementation plan](../../plans/2026-10-17-deck-image-failure-placeholder.md).

Layout-stage batch and job projections retain the four legacy lanes; image regeneration is implicit
in layout. Image-only work explicitly projects the `image` lane and requires the new Teacher client.
This lane projection does not make old workspace parsers compatible: every newly generated page
writes `generationMetadata.mediaSlots`, and regeneration plans contain `image` and `imageScope`.
Old Teacher clients reject these exact-key records for any generation, including work initiated by
collaborators. When old tabs read new records, workspace parsing fails and the UI shows a generic operation failure/retry message.
Affected users must refresh the entire page according to the release notice. This accepted
compatibility limitation applies to all generation and must be included in the notice. The new Teacher exposes
image entry points immediately; there is no separate image-only feature switch.

Deployment must follow [manual configuration control](../../../infra/appstack/autoscaling/workers/README.md#updating-shared-configuration-under-manual-control)
and [shutdown and maintenance](../../../infra/appstack/autoscaling/workers/README.md#shutdown-maintenance-and-capacity-preserving-rollback):

1. Freeze Yunxiao writes, scheduled releases and competing automation; snapshot nonsecret configuration,
   manifests, image digests and current replicas N. Remove ScaledObjects with
   `restoreToOriginalReplicaCount:false`, wait for their HPAs to disappear and confirm N is unchanged.
   Retire competing scaling owners. Do not use pause annotations, `paused-replicas`, a lower max or
   KEDA removal; directly scaling to zero under KEDA is insufficient.
2. Quiesce all producers through approved operational admission control or maintenance. There is no
   application pause switch. Prove zero active/runnable work across all 12 channels and account for
   delayed, paused, scheduled and dependency-blocked work. Explicitly record queue `ai-runtime-teacher-deck-jobs-v1` with BullMQ prefix
   `{ai-runtime:<REACHANY_ENV>:<REACHANY_QUEUE_NAMESPACE>:teacher-deck}` using the actual target values:
   `wait = 0`, `prioritized = 0`, `active = 0`, `delayed = 0`, `paused = 0`, `waiting-children = 0`
   (including delayed coordinator jobs), and no nonterminal workspace batches. The read-only Mongo
   query below must return zero. If admission control or proof of quiescence is unavailable, defer the upgrade.
   Stopping Courseware also stops lesson-prep and speech-preview.
3. Preserve environment and queue identity. Once producers are stopped and all channels are empty, sequentially update API,
   all four Workers, observer and Teacher in the same window. Preserve the full drain grace: the
   default deadline is 600 seconds and Kubernetes grace at least 630 seconds. Long paid tasks can
   exceed this budget; it does not authorize interruption or force-deletion. Check new Pod UIDs,
   creation times and readiness, and wait for every old or terminating Pod to disappear.
4. Confirm compatible versions and shared configuration/Redis identity. Workers and observer use
   the same immutable digest. Wait for old observer samples to expire by
   `freshnessSeconds + maxClockSkewSeconds`, and verify complete new samples and matching concurrency.
5. After service version, configuration and queue compatibility checks, run `before-activation` and bounds
   checks, restore exactly one scaling owner per Worker with bounds containing N, and complete
   `verify-active`. Then restore producers and release the Yunxiao freeze. Inconclusive checks keep
   scaling and producers off. These are operator prerequisites, not a claim that deployment occurred.

In an authorized Mongo session for the target environment, select the database used by content-service
and run this read-only query across the entire deployment scope. No output means zero. Nonzero output,
a query failure or an unverified database identity cannot prove quiescence.

```javascript
db.getCollection('reach_deck_authoring_workspaces').aggregate([
  { $project: { batches: { $objectToArray: { $ifNull: ['$recovery.batches', {}] } } } },
  {
    $project: {
      pending: {
        $filter: {
          input: '$batches',
          as: 'batch',
          cond: { $ne: ['$$batch.v.phase', 'terminal'] },
        },
      },
    },
  },
  { $match: { 'pending.0': { $exists: true } } },
  { $count: 'workspacesWithNonterminalBatches' },
]);
```

After deployment, observe this accepted known behavior: when only image members waiting for narration
remain, the coordinator wakes every 15 seconds. Cancellation does not advance an existing delayed job,
so the UI may show “Cancelling” for up to 15 seconds before terminal finalization. Verify finalization
within this interval; longer delays require coordinator and queue health checks.

After deployment, compare serialized recovery document bytes, retained terminal payload bytes and
batch count with the pre-upgrade baseline. Each batch is limited to 1 MiB and the latest ten terminal
batches are retained; landing failures retaining payloads can therefore add nearly 10 MiB per recovery
document, plus other recovery state. This is a worst-case bound, not the expected size of every document.
Observe coordinator tick frequency and content-service recovery read counts, byte throughput, latency,
allocation and GC pauses together. Investigate persistent growth or regressions, including whether
narration deferral throttling and termination are effective. This release adds observation; it does
not split storage or reduce capacity limits. Do not discard frozen adoption proofs to reduce size:
manual conditional adoption depends on them, and returns 409 after normal proof cleanup. Unacceptable
observed pressure requires a separate durable payload/minimal-proof storage design.

### Workbench regeneration plans

The workbench uses `POST /workspace/regenerate` through the Teacher BFF for both whole-Deck and
single-page regeneration. The request carries `expectedDraftRevision`, a required bounded
`Idempotency-Key` header, five boolean `channels` (`layout`, `image`, `narration`, `audio`, `animation`),
`scope: failed | all`, optional `pageId`, and `audioAnimationMode: preserve | clear` (default
`preserve`). The server derives the authorized owner and module scope; a single-page request always
uses the current page rather than broadening into a Deck operation. Product combinations and page
state matrices are recorded in [the workbench specification](../product/reach-deck-workbench.md).

Dependency normalization adds narration for layout+audio, narration/audio for layout+animation, and
audio for narration+animation. Audio-only and animation-only retain independent saved-content
semantics. Eligibility intersects the chosen channels with each page type's supported channels,
selects a page once using failures/missing/stale artifacts in the selected channels, then checks
prerequisites not regenerated by the plan. Responses return accepted page IDs and skipped reasons;
an empty result returns 200 without starting a batch, while accepted asynchronous work returns 202
and a durable batch with `kind: regeneration`.

Each member persists its plan, current stage, frozen dispatch payload and job identity. The existing
queue, writer lease, recovery and cancellation boundaries drive layout before narration/media;
explicit layout plans do not enter the legacy automatic full generation chain. A failed upstream
blocks that page's downstream, while later pages continue. Successful layout/narration replaces its
unselected downstream artifacts; a failed saved-content audio retry preserves usable old media.
Layout materialization must succeed before its member advances. Applied task results and artifact
validity remain separate so a failed retry with usable old media still qualifies for failed scope.
Cancellation fences layout, image and narration jobs and unlocks only matching page requests.

Regeneration pages advance independently within `REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW`
(default 4), while each page retains its layout-before-narration/media dependency. Frozen inputs
share the batch byte budget: a full budget waits for sibling inputs to be released; an input that
cannot fit alone fails and unlocks its exact page request. Staged payload validation is
deterministic (`ReachDeckInvalidGenerationPayloadError`, code
`REACH_DECK_INVALID_GENERATION_PAYLOAD`): regeneration validates before freezing, registration or
enqueue, and a frozen input that no longer validates fails its member. Narration and media batches
treat the same rejection from enqueue as a member failure. In every case the never-queued
registration is removed and the exact pending/narrating page request becomes a retryable failure;
the coordinator does not enter dependency backoff. Coordinator delay logs carry the code as
`errorCode`. Superseded regeneration results become
terminal failures and release their frozen input; transient landing/materialization errors remain
replayable. Interactive audio replacement carries the prior audio resource ID into the existing
landing cleanup. Admission combines active jobs/batches with pending/generating/narrating workspace
statuses, including the interval before a normal narration job registers. Failed-only retries do
not treat deliberately absent Interactive narration/audio as failures without actual failure
evidence. Ordinary first-generation page jobs bypass regeneration batch cancellation reads.

Public members expose `generationKind` and `affectedLanes` so task status and thumbnail indicators
reflect the selected work, including planned downstream channels while layout is running. Legacy
narration/media routes and batch kinds remain compatible. Teacher
saves page edits and cached narration drafts before a new submission; an uncertain POST retry keeps
the original key and revision and presents an explicit confirmation action instead of starting a new
request. A definitive rejection releases that frozen command so the next attempt can save and use
the latest revision.

### Durable whole-Deck narration batches

AI Runtime persists every newly accepted whole-Deck narration request as
`reach-deck-workspace-recovery/v5` batch state for both generation workspaces and materialized Native
V2 imports. Durable batch creation is permanently enabled and has no runtime feature flag or disabled
legacy fallback. The route fixes the complete authorized member order and skip reasons in one
recovery CAS before any generation job is submitted. Workspace batches then move every matching page
to `narrating` in one workspace CAS. Native batches do not freeze page revisions or saved-narration
digests at registration: pages may be edited by the teacher or a concurrent batch while queued, so
each Native member is built from the page and saved narration current at its dispatch turn. The
dispatch revision is persisted together with the member `jobId`; recovery of an already dispatched
member rebuilds the same job at that persisted revision, and the result write-back still requires the
page to remain at that revision. Only after those preparation steps are durable may the first member
dispatch.

The coordinator reuses the `teacher.deck` BullMQ queue. Its deterministic cursor job is inserted
before the batch recovery CAS and waits through a bounded registration grace period when the batch
is not yet visible. Each batch cursor has exactly one job identity. While registration, a predecessor,
or a transient dependency is pending, the worker moves that same active job to BullMQ delayed state
and throws `DelayedError`, so polling does not consume its attempt budget or create more jobs. A hard
process exit is recovered through BullMQ's stalled-job handling. Once a member is durably marked
dispatched, the coordinator schedules the next cursor; at most the current and next cursor identities
coexist during that handoff. Each member records a deterministic dispatch intent before its
generation job is submitted. A process exit after batch CAS, after dispatch-intent CAS, or during an
ambiguous enqueue therefore resumes with the same batch, cursor, generation `jobId`, and generation
audit identity without a new GET or POST request. Stale cursors hand off to the batch's authoritative
`dispatchCursor`. Workspace GET responses project live queue/audit status separately from the stored
intent; a member without a `jobId` remains `waiting-dispatch` or `waiting-predecessor` and is not
inferred from an unrelated legacy descriptor.

Narration dispatch remains strictly serial and advances only after the predecessor result is both
complete and applied. If that predecessor fails, the batch ends as `partial-failure`; every later
member becomes `blocked`, and matching workspace pages become retryable failures with reason
`predecessor-failed`. They are displayed as “前序失败，未执行” and require an explicit new batch to
retry; a Native retry batch takes over the failed and blocked pages at their current revisions. A
deterministic Native preflight rejection (for example a removed native binding, missing saved
Markdown, or a stale revision while recovering a dispatched member) fails that member and ends the
batch the same way instead of being retried as a dependency failure. The older workspace and Native completion chains yield to an active durable narration batch,
so they cannot submit the next member in parallel.

The compatibility path for cancelling one active narration member through the legacy single-job API
also blocks later members as `predecessor-failed`, so the current UI uses the same “前序失败，未执行”
copy. Teacher normally redirects that action to batch cancellation. If a user-facing single-job
cancel entry is restored, product follow-up should evaluate a distinct `predecessor-cancelled` reason
and “前序已取消，未执行” copy; that decision does not change whole-batch cancellation semantics.

Batch status is available through the run- and kind-scoped
`GET /workspace/batches/{batchId}` endpoint. `POST /workspace/batches/{batchId}/cancel` first writes
the authoritative `cancelRequested` fence while holding the same document writer boundary as
dispatch and result landing. It then stops queued work, aborts an existing generation audit, and
cancels an existing Runtime run when queue acceptance was ambiguous. Waiting members without a job
identity do not create synthetic audit records. Worker startup and result landing recheck the durable
fence; a provider call that was already active keeps the batch `cancelling` until execution is known
to have stopped. Cancellation preserves completed results, changes only pages whose request identity
still belongs to the batch into retryable `batch-cancelled` failures, and releases retained writer
ownership after the batch becomes terminal. A retry creates a new batch identity; replaying the old
identity only resumes or reports the cancelled batch.

One run allows at most two active batches and at most one active batch per kind. A single batch JSON
value is limited to 1 MiB, total recovery state to 12 MiB, and the conservative full Mongo workspace
estimate to 16 MiB including a 512 KiB document-overhead reserve. At most ten terminal batch
summaries are retained. Rewind, outline adoption or page removal, and prior-generation restoration
first persist a `stopped` batch fence under the document writer lease, then mutate the workspace, and
finally prune obsolete job/result/continuation references. A failed fence prevents the structural
mutation; a failed final prune is surfaced while the durable `stopped` fence continues to prevent
dispatch and retain its writer ownership. Successful prune records a terminal cancelled summary,
preserves the batch request tombstone, and reconciles the retained writer lease, allowing a later
whole-Deck request to register a new durable batch.

A whole-document save (`rematerialize`) is structural only when it adds, removes, or reorders pages;
it then uses the same fence-and-prune sequence. An unchanged surviving page keeps its standalone
narration/audio job even when another page is inserted or the order changes. The structural intent
retains the exact protected job IDs for crash recovery; replaced standalone narration jobs use the
durable tombstone cancellation path. Existing batch cancellation semantics remain unchanged.
A content-only save behaves like a page save: active
batches and in-flight narration jobs keep running, late results remain guarded by the materialized
page CAS and obsolete-job checks, and the save only collects already-applied standalone page and
narration recovery entries that no batch member or structural tombstone references.

On a save revision conflict, the Teacher client reads the authoritative document and attempts one
three-way reconciliation against its original baseline. Independent page changes and compatible
global/order changes can synchronize silently, followed by at most one write using the new CAS
version. Each page and its native slide/narration form an atomic content unit; competing edits to
that unit or shared-resource mutations remain conflicts and preserve the local draft. A second
conflict stops the retry. Network/server failures only acknowledge a read-back that exactly matches
the attempted stable document; they do not trigger a blind write retry. Generated narration animations
remain teacher-editable: save, refresh, and undo history compare the prior server state, the latest
server state, and the local draft. Local deletions and timing edits survive; fields the teacher did
not change can adopt new media timestamps. Scope changes invalidate
pending recovery. Friendly localized errors distinguish saving, starting Decksmith, observing a
task, cancellation and terminal failure.

The fence and cleanup use a crash-recoverable three-stage transition. The fence CAS writes a
`reach-deck-workspace-structural-mutation/v1` `pending-cleanup` intent keyed by the abandoned run,
including its exact owner and affected batch IDs. The first cleanup CAS terminalizes fenced batches,
removes page-generation recovery data, and installs one bounded v1 tombstone for each obsolete
narration job while retaining its descriptor, result, and TTS continuation for takeover. External
cleanup then requires either a permanent generation-audit fence or proof that execution stopped
before audit creation, non-active Queue execution, a missing or terminal Runtime run, and accepted
cancellation of any active TTS identity. The final CAS removes only descriptor, result, continuation,
terminal batch job reference, and workspace tombstone values that still exactly match the settled
snapshot; it removes the intent after all same-run tombstones are gone. This three-stage lifecycle
applies only to narration jobs referenced by an affected batch member or an existing tombstone,
including tombstones whose terminal batch summary has already been evicted. Standalone page and
narration recovery data keeps the direct-prune behavior, with active TTS identities cancelled
best-effort after the cleanup CAS; standalone cancellation failures only warn, do not create a durable
intent, and do not block an existing intent from completing. The batch coordinator and every
structural mutation route can take over deterministic batch-member cleanup
after the prior route releases the document writer lock. A first audit 404 does not by itself permit
collection. Cleanup still checks every execution plane and may collect only when the descriptor is
pristine, no durable result or TTS continuation exists, Queue cancellation and lookup both find no
job, Runtime is missing, and a second audit lookup after those checks is still 404. Any contrary
evidence, external failure, second-audit failure or appearance, or active execution retains the
complete batch-member cleanup state. Identity or scope mismatches fail explicitly. When the
workspace mutation has already committed but external cleanup has not yet settled, the route returns
retryable HTTP 409 with `STRUCTURAL_CLEANUP_PENDING`; the response does not expose internal job
identities. Teacher retains the same idempotent pending command and automatically retries that exact
request; a later structural request first resumes the retained cleanup before normal business
validation.

The current Teacher copy classifies this retryable cleanup response with the general workspace
revision-conflict message. A future product pass may give `STRUCTURAL_CLEANUP_PENDING` dedicated
bilingual copy that explains cleanup is still converging and the same request will retry
automatically.
Route preflight runs before revision comparisons, voice, result, or adoption checks, so an exact replay still
repairs cleanup when the structural write already advanced the workspace or prior-generation
restoration replaced its run ID. A crash after the cleanup CAS but before retained-lease release is
recovered from the terminal `pruned` batch and its matching lease owner. Only this proven structural
cleanup path may ignore stale active workspace statuses when releasing the abandoned run's retained
lease.

The materialized structure-save path is the standalone-narration exception to direct pruning:
its intent records protected unchanged jobs, and invalidated standalone narration uses the same
durable cancellation checks as batch members. Other legacy structural operations retain their
existing direct-prune behavior. `reach_deck_structure_generation_cleanup` records the structural
reason, full protected/cancelled counts, and at most 20 job identities per category without recording
page content. Malformed or stale structure-save requests are rejected before installing a new
cancellation intent; an existing intent still resumes during route preflight.

Structure saves reconcile retired terminal generation targets with the current saved document.
Publication also reconciles legacy stale targets while holding the document writer and validating
the caller's revision and content digest. Actual in-flight jobs/batches, pending generation states,
and placeholder pages still block publication; a failed page removed or replaced by a manual page
must not keep an otherwise complete document in `page-generation` forever.
Publication uses a strict status check independent of the normal forty-job display window, with
four concurrent status reads and no payload reads. A definite missing queue record is checked
against its exact generation audit; terminal audits without an outstanding result and missing
historical records do not turn the projection's fallback `registered` value into an activity gate.
Queued audits, fresh running/retrying audits, and completed results awaiting application still
block publication, including an audit result reference whose local artifact is missing. A
running/retrying audit whose queue record is gone and whose `updatedAt` is more than 10 minutes old
is an orphan from an interrupted worker and no longer blocks publication: a worker writes the terminal
audit before BullMQ removes the record. When BullMQ replays an interrupted job whose audit is still
`running`, the worker first settles that attempt as `retrying` (content-service only accepts
queued/retrying → running) and then starts the new attempt; if the running transition still fails,
the failure path reads the durable attempt so the `failed` audit lands instead of staying `running`.
If the old attempt reached `retrying` but the next `running` write failed, failure settlement preserves
that exact attempt too; content-service accepts `running` or `retrying` for this terminal transition
while retaining the immutable identity and execution-attempt checks. Deploy this compatible
content-service before the updated worker. The `enqueue-failed` endpoint likewise accepts
`queued@0` and `retrying@0`, covering a resumed enqueue failure whose next execution never reached
`running`. Queue/audit read failures or
timeouts reject the publication attempt so that transient uncertainty cannot publish live work.

TTS alignment failures have separate `tts-timestamps-missing`, `tts-timestamps-text-mismatch`, and
`tts-timestamps-incomplete-coverage` reasons. `deck.tts.timestamps.rejected` records the job/page,
request identity, validation phase, chunk/input type, expected/actual character counts, and mismatch
offsets; it never records transcript text or provider words. Exact coverage is still enforced.
These failures are provider-output errors rather than evidence that the TTS dependency is down.
They do not add automatic paid retries, but remain eligible for an explicit teacher retry.

`reach_deck_model_response_rejected` distinguishes empty assistant output, malformed JSON,
invalid response envelopes, and provider refusal. It records allowlisted finish reasons, response
identity, usage presence and token counts, and SSE content/reasoning/refusal/tool-call counters.
Provider refusal and `content_filter` end automatic Worker retries but still permit an explicit
teacher retry of the failed page; the automatic retry flag must not disable that teacher action.
It does not retain raw model content or reasoning. Missing usage is distinct from a reported zero.
Historical generic "did not contain assistant JSON" errors cannot establish that malformed JSON
was returned: an empty or otherwise unsupported response may produce the same old error. Raw
responses can only be investigated where the existing restricted observation/evidence path retained
them; no blanket response-body logging is introduced.

For batch-member narration and existing structural tombstones, the content-service generation audit
is the durable admission fence for the full module-version lifetime. `aborted` and `succeeded` audits
cannot be enqueued again. Because an exact `failed` audit can be retried, structural cleanup first
moves it through the legal `retrying` transition using its current execution attempt and then aborts
it; `queued`, `running`, and `retrying` audits are aborted directly. Audit records are retained until
the corresponding module version is permanently deleted. The workspace structural tombstone is
therefore a temporary worker fence while external state converges, and safe historical tombstones are
actively collected when the 2,048-entry capacity blocks a normal job or batch registration. TTS
DELETE 204 records that the cancellation/drain boundary was accepted; the durable audit still rejects
a later replay or result. Operational follow-up should measure tombstone levels by module version, GC
attempts and successes, retention reasons, and capacity rejections before changing the 2,048 limit or
audit lifetime.

`重新生成所有音频和动画` preserves canonical saved narration and registers one server-owned media
batch for the eligible Native slides and Interactive pages. Before registration, valid segment-only
legacy slide narration is converted to canonical Markdown through the existing page content CAS. A
partial conversion failure starts no generation; retry reloads the persisted prefix and saves only
the remaining legacy pages. Unsupported pages, missing or invalid narration, unresolved manual
review, and active generation are skipped. Interactive pages retain their whole-paragraph audio-only
contract; Native slides regenerate audio, timing, and narration-driven reveals.

Teacher persists a batch-level idempotency key and the workspace draft revision before its first
create request. AI Runtime reloads the authorized materialized document, resolves the current voice,
validates every page revision and narration digest, and durably registers the complete member list
before dispatch. Replaying the same outer idempotency key resolves the original request tombstone
before revision, voice, or materialized-content preflight. Every newly accepted whole-Deck media
request creates a durable batch; there is no disabled-gate conflict or disabled-gate fallback to the
legacy per-page path. An ambiguous create failure retains the original batch and item identities and
does not replay them as independent page requests.

Media members are dispatched independently, so one page failure does not block later pages; existing
worker capacity controls their parallel execution. Each member retains its exact page revision,
narration digest, voice snapshot, normalized `animationMode`, and deterministic single-page request
identity. New requests include that mode in the member payload, request hash, and job identity. An
active legacy member persisted without `animationMode` resumes as `preserve`, retaining its original
hash and job ID. Historical browser media lists without a batch key use `adopt-existing`: AI Runtime
accepts only members whose existing recovery descriptor exactly matches that identity and returns an
exact accepted/not-accepted partition. Teacher transfers accepted members to the durable batch and
uses the legacy per-page path only for the explicit not-accepted remainder. An ambiguous adoption
failure keeps the original local identities for retry instead of blindly submitting them again. This
transition path for historical browser-owned work remains available independently of new durable
batch creation; it is not a feature-flag fallback.
During rollout, deploy AI Runtime with `animationMode` request support before deploying the Teacher
bundle that sends this field; an older route rejects the new field instead of silently changing its
meaning.

Page saves can share the current server-resolved async generation owner while another page generates
media. The writer still serializes document writes, validates actor/grant/resource ownership, preserves
approved Decksmith adoption, and merges through the current document CAS. Full-document structural
writes remain exclusive. Confirming a manual narration candidate also wakes the remaining generation
chain immediately; subsequent narration uses the saved materialized text even before its media lands.

AI regeneration produces one canonical Markdown document together with compiled internal cues and
reveal ranges in the same narration model result. Saved teacher content keeps the exact Markdown and
uses the constrained segmentation path to derive those cues/reveal ranges without rewriting it.
There is no extra alignment-model call after this durable preparation boundary. The cues become
derived captions/timings; they never become teacher-visible authoring structure. Every job carries the
starting narration-state digest (including a versioned absent-state identity) and stripped-layout
digest. Worker reload and result landing repeat those checks, so saving a newer narration while an
old job is in flight discards the old result rather than mixing versions.

Speech media synthesis and acoustic subtitle alignment remain separate steps. The current execution
contract uses Doubao ASR as primary, with Seed Lite selected through its independent fallback slot
for low-confidence alignment chunks. This #636 contract was selectively ported from `test` commit
`325526e5d`; it was not a full branch merge. TTS audio alone is not alignment acceptance: successful
landing requires usable timings reconciled with the authoritative narration transcript. The visual
routes do not switch to another producer when an image or diagram fails.

Canonical Markdown remains the visible narration, subtitle, cue, and digest authority. A page may
also carry a separate `reach-deck-speech-marks/v1` document whose source ranges target that exact
Markdown. The serializer produces controlled SSML and an XML-free alignment transcript without
rewriting the saved Markdown or exposing speech aliases in captions. Saved content rejects unknown,
nested, crossing, formula-intersecting, cue-intersecting, reveal-intersecting, or invalid Unicode
boundaries. Pages without marks retain their pre-feature plain synthesis and cache identities.

Teacher labels this feature “语音标记” / “Speech marks”, with guidance for pronunciation, pauses,
and speaking speed. When a provider word crosses ordinary narration boundaries, timing projection
retains its real time window and extracts visible text from the full Markdown projection. Native
caption cues with overlapping windows are coalesced before persistence, including transitive overlaps,
so a coarse word cannot produce duplicate captions or zero-duration segments. Reveal and scientific
anchor ranges retain their independent targets and use the overlapping word's real window; no
within-word acoustic timing is invented. Atomic marks, formulas, and non-1:1 escape units still reject
split boundaries before cue coalescing.
When a coarse provider word crosses a zero-width pause or sound event, projection emits only
nonblank visible words; isolated whitespace between marks also produces no persisted word. The
visible pieces retain their canonical Markdown ranges and share the provider's real time window.
Projection uses nearest-anchor fuzzy alignment instead of exact label equality. Formula readings and
speech-mark spoken spans are avoided: they are never compared character by character and take the
provider window between their neighbouring anchors. Other transcript characters are matched to
provider labels by a banded longest common subsequence; dropped punctuation, homophones, and small
insertions or omissions fall into gaps that borrow the neighbouring provider window. Persisted words
always use source text, never provider labels. Alignment fails only when anchors cover less than 60%
of the comparable characters or one gap exceeds 12 characters. Chunk checks, final-cache rechecks,
and post-concatenation rechecks use the same rule with chunk-local avoided spans. Model-service's
Doubao ASR word alignment disables ITN, because readings such as “3分之5” would otherwise come back
as “5/3”. Its anchor aligner tolerates hallucinated words in leading or trailing silence, up to two
inserted or unheard characters between anchors, and number readings whose time limit scales with
their length. The Seed Lite fallback uses the same fuzzy anchor rules and returns source-text slices.

Marked narration is split into deterministic provider envelopes of at most 150 characters including
SSML tags, with an additional limit of 80 semantic characters/words per chunk. The latter uses the
editor's bottom-right narration counter: Chinese and punctuation count individually, Latin/digit
tokens count once, whitespace counts zero, and formulas count once. Both visible text and the
spoken text after alias substitution must fit; tags do not consume this semantic budget. Atomic
marks and formulas are never split. An oversized atomic mark must be shortened before regeneration.
The existing plain-text generation planner retains its 150-code-point packing target and 200-code-point
hard bound. Selection previews use the SSML planner even without marks, so they also obey both limits.
Generation rejects plans exceeding 256 chunks before making synthesis calls.
Provider SSML text nodes replace each CR/LF with an ASCII space. Canonical Markdown, paragraph
layout, visible text, alignment transcripts/maps, and mark coordinates remain unchanged; XML
attributes and plain-text generation retain their existing handling. A 2026-09-25 local test using
the reported course clone found that literal LF in a 119-character SSML request weakened even
earlier breaks. Replacing two LF characters with two spaces, without changing request length,
restored the measured 1000 ms pause to about 1.01 s and the trailing 2000 ms pause to more than
2 s. Lowering the XML limit alone did not fix that fixture. This is observed provider behavior,
not a guarantee of exact pause duration for every voice.
One existing narration BullMQ job runs the chunks with bounded concurrency; chunks are
not child jobs. Each chunk has a stable model-service request and cache identity. Model-service
synthesizes that chunk's MP3, runs ASR Fast on those exact bytes, and returns the chunk audio with
chunk-relative timestamps. A failed ASR alignment retries only that MP3 through Seed Lite. Recovery
reuses each completed chunk independently and reruns only cache misses. Audio is decoded and
concatenated only after every chunk succeeds, and timings are offset by each chunk's measured duration
and projected once from alignment-transcript coordinates back to visible Markdown coordinates.
Cancellation or a partial failure never publishes a page-level half-result.

Model-service validates the allowlisted SSML with a hardened structured XML parser before provider
dispatch. Official compatible Mandarin Seed-TTS 2.0 voices admit `break`, `sub`, `say-as`, and
`phoneme`; an active, consented Chinese clone admits the same four independently verified tags.
Unknown or unsupported voice/tag combinations fail closed without changing the selected course voice
or stripping annotations. New chunks use Doubao ASR Fast word timings through the dedicated
subtitle-alignment execution slot. Ordered anchors must cover the authoritative alignment transcript;
small ASR recognition differences between anchors, including numbers, terms, and formulas, share one
coarse timing block without checking the block's exact reading. Recognition differences are bounded
by the share of unmatched source tokens and the expansion of each ASR block. Weak anchors, excessive
differences, ASR-only or source-only gaps, and oversized gaps retry only that chunk through the
separate Seed 2.0 Lite fallback slot. A missing or incompatible ASR policy or credential also uses
that slot. ASR output must cover the authoritative transcript; SSML Seed output is strictly
reconciled before projection to visible Markdown. Plain-text Seed output first attempts safe
transcript reconciliation and alignment; validated corrections restore authoritative labels. When
no safe correction exists, it retains the earlier provider words, including possible recognition
differences. Adjacent zero-duration words are merged into timed blocks. Empty or unlocatable Seed
output fails the chunk. Previously
materialized audio remains unchanged.

Plain narration finalization uses the same nearest-anchor fuzzy projection as formula and
speech-mark narration before captions, reveals, or scientific anchors are accepted. Narration often
writes bare symbols outside formula delimiters (`f(−x)=f(x)`, `x∈D`, `−2≤2t≤2`); these receive no
formula reading, and providers return their spoken form (“括号”, “属于”) without punctuation, so
exact label equality failed such pages. Those differences now fall into gaps between anchors.
Complete tone-marked pinyin runs are avoided spans in every fuzzy alignment: providers transcribe
them as Han syllables, so they take the provider window between neighbouring anchors and keep the
original visible pinyin. Coverage below 60% or a gap over 12 characters still fails finalization.
Plain synthesis and model-service alignment receive the narration without canonical Markdown escape
backslashes (`\-`, `\>`); chunk planning never splits an escape pair, and a full plain preview uses
the same text so it remains reusable. Previously published snapshots are not rewritten. The original
strict pinyin repair is described in the
[repair plan](../../plans/2026-10-15-reach-deck-pinyin-alignment.md).

Each environment needs an enabled Doubao ASR Fast policy for
`courseware.deck.narration.subtitle-alignment` and an independent Seed 2.0 Lite policy for
`courseware.deck.narration.subtitle-alignment-fallback` before rollout. This includes test and
production; the development policy update does not configure them. Each subtitle slot currently
executes its one configured model. The controller does not traverse the policy's other model
candidates for either slot.
Formula captions still render through the restricted rich-text/KaTeX renderer, and MathLive speech is
not involved.

Speech media idempotency includes a stable synthesis-profile version in both staged generation and
DeckSmith. A change to model-service parsing or other audio-defining semantics must bump that
version so explicit narration regeneration cannot reuse audio created under the previous profile.
Already materialized audio remains immutable and is neither migrated nor deleted automatically.
The 80-unit SSML chunk policy and provider-text newline normalization use profile
`reach-deck-tts/ssml-chunks/v9`, replacing the v8 capacity-only profile and v7 SSML
provider-field correction profile. Explicit regeneration uses the new policy; already materialized
audio is unchanged. The shared profile bump also invalidates plain-text generation/preview cache
identities and may require fresh synthesis. Deploy Teacher, AI Runtime API, and Courseware workers
together so selection validation and generation use the same chunk policy.

For local provider diagnosis only, the standalone harness under
`services/ai-runtime/scripts/reach-deck/` mounts the same exported `NarrationEditor` as the
authenticated product with a transient in-memory slide and preview callback. It does not add a
Teacher route and has no sign-in, save, regeneration, smart-mark, generated-media, or OSS path. Its
loopback-only server previews the current same-origin selection, or the complete narration when no
text is selected, and calls the model-service local development probe with the same 80-unit and
150-character-envelope chunk limits;
neither boundary returns clone or provider identifiers. The editor exposes `break`, `sub`, `say-as`,
and `phoneme`, including all 39 allowlisted `say-as` interpretations and the `py`, `cmu`, and `ipa`
phoneme alphabets. `soundEvent` and root `<speak>` settings remain available in the diagnostic
protocol and DSL for compatibility but are hidden from the editor. Every parameter form is a
toolbar-button-anchored popover. This does not weaken the product clone policy, which remains
`break`-only. A 2026-09-12 real-clone smoke received HTTP 200 and playable MP3 for the four visible
tag families. That result proves provider acceptance, not correct linguistic interpretation. Manual
listening in the harness remains authoritative. This is a local workstation tool, not a test-site or
production feature, and a real preview can still incur provider charges. The harness limits JSON to
32 KiB and applies one 15-minute deadline across queue polling, provider response reading, and
cancellation of the opaque request identity.

### Teacher voice selection snapshot

The personal voice library is account-global and private; a course stores only an active grant for
one agent role. This release resolves `teacher` grants only. Teaching-assistant and classmate roles
remain schema/API extension points, not selectable or synthesizable behavior.

Every new staged generation job and Decksmith frozen turn asks content-service to resolve the
current teacher-agent selection. The durable snapshot is a closed union: either the resolved
ordinary voice from the teacher agent's `ttsVoiceId`, or the course/teacher-scoped grant ID,
opaque clone ID, and synthesis revision. A course without a teacher configuration uses the
current voice of the unique enabled platform teacher system preset; missing or ambiguous
presets fail explicitly. The ordinary snapshot retains `kind=default` for stored-contract
compatibility, but its voice is no longer fixed to Vivi. Clone provider speaker IDs, owner metadata,
and capabilities are absent from browser,
model-tool, BullMQ, recovery, Run input, and AI Runtime tool-usage payloads. The browser and Decksmith
cannot submit a selection or invent an ID.

The snapshot is fixed for the job. A later course selection affects only a new job or explicit
regeneration, and existing stable or published audio is never rewritten. Before clone synthesize,
poll, cancel, or recovery, AI Runtime exchanges the frozen identity with content-service for a fresh
operation- and request-bound capability. Content-service revalidates the current actor/module scope,
active grant, clone consent/status/provider availability, and exact revision, but intentionally does
not require the original grantor to retain course authoring permission. Model-service performs the
final capability and clone-state check and resolves the provider speaker internally. Any stale,
revoked, disabled, withdrawn, deletion-requested, or provider-invalid clone fails explicitly; the
worker never substitutes the default.

Historical Vivi snapshots preserve their request and media identities for recovery compatibility.
New ordinary voices and clone speech include the voice-selection digest in request/media/cache
identity, so changing an ordinary voice, clone, or clone revision cannot reuse another voice's
audio. Queue cancellation uses the same frozen ordinary voice or verified clone identity.
Clone authorization does not depend on the ordinary Vivi catalog entry being enabled.
Image and function-plot media identities remain voice-independent.

Durable staged jobs write and accept only `reach-deck-generation-job/v5`. Queued staged v2, v3, and
v4 payloads fail closed and must be retried from the current API; workers do not normalize them or
project a default voice. Workspace recovery readers accept v1 through v5 and preserve an optional
`batches`, `batchRequests`, or `structuralMutations` map on every supported version. Ordinary
read-modify-write operations retain the stored schema version and omit unsupported empty legacy
fields; an explicit batch mutation promotes the record to v5. The narration TTS continuation schema
is unchanged. Decksmith writes v2 and reads v1
by its existing default-only rule. Existing default media stays reusable. At the Redis admission
layer, only a server-classified default path may use `LEGACY_DEFAULT` to add a missing exact-default
voice digest after request/owner binding checks; clone tickets always use `STRICT`, and cancellation
never upgrades or changes `RUNNING` or terminal legacy tickets.

All Reach Deck and OpenMAIC Seed-TTS calls share model-service's account-level Redis admission pool,
which defaults to ten concurrent provider calls across replicas and is not split by `resourceId`.
Reach Deck explicitly opts into the FIFO ticket protocol. When all permits are in use, model-service
returns a short 202 queue envelope rather than holding the HTTP request; the same logical request can
wait up to 12 hours from its first Redis-server-time enqueue. Provider HTTP 429 and stream business
codes `45000000`/`45000292` are real attempts: model-service records them, releases the lease, moves
the ticket to the queue tail and applies bounded pool cooldown. OpenMAIC remains a legacy synchronous
caller until #199, receives no 202 and cannot bypass live Reach Deck waiters.

The narration worker writes a bounded, versioned pre-TTS continuation after authoritative Markdown
and cue/reveal alignment, then uses the same BullMQ narration job as a lightweight poller. A 202 moves
that job to delayed state with its real lock token and `DelayedError`, releasing the worker slot
without increasing BullMQ attempts or the generation execution attempt. Resume polls use local
priority 1 and the authenticated Reach Deck ticket has 15-minute liveness, while provider promotion
uses model-service's FIFO window: any live waiter ranked below the free permit count is granted on its
own poll without overtaking earlier waiters (#808). Resume reloads the continuation, verifies
cancellation and source/layout/narration digests, and never replays narration, alignment, layout,
image or other completed model work solely to wait for TTS.

A stable-media hit makes no provider call. Authoritative narration accepts a hit only when the same
stable asset includes non-empty real speech timestamps. Speech success uploads a versioned atomic
audio-plus-timestamp bundle to content-service; the audio identity and timestamp sidecar live in one
`public.object_storage_asset` record. A legacy sidecar-less row is treated as a miss and repaired at
the same deterministic object key before it becomes available again, so publication cannot observe
a narration-without-audio/timings half-state.

Every real provider attempt has one model-service usage outcome. AI Runtime advances an attempt
ordinal in the durable continuation before emitting its tool audit; ordinary queue polls emit no
usage or tool audit. The existing audit sink has no idempotency key, so this is intentionally
CAS-before-emit at-most-once: a crash between the CAS and audit write can omit that Runtime audit,
while model-service usage remains billing authority. Queue deadline, capacity failure, Redis
admission failure and lease loss are terminal/manual narration failures projected as
dependency-unavailable; authoritative Markdown stays unpublishable until a deliberate retry produces
real audio and timings. Cancellation, source supersession and cache races cancel the ticket
best-effort and clear the continuation. A model-service cancellation tombstone prevents the same
identity from entering the provider when cancellation wins the pre-dispatch race. Stop also ends
browser preview waiting and playback. A call already executing inside the provider client can only
drain best-effort; neither model-service nor the provider contract guarantees remote processing or
billing reversal.

Rolling deployment has two independent ordering requirements. Deploy the compatibility build that
reads recovery v1 through v5 and preserves optional `batches` to every AI Runtime API and
`teacher.deck` worker replica as one synchronized release. Because every new whole-Deck narration or
media request writes durable batch state immediately, do not expose a new producer while an old
reader remains in the fleet. Once any v5 batch has been written, the rollback floor is that
compatibility build: rollback must remain able to read and preserve v5, and no JSON downgrade or
runtime creation switch exists. Separately, preserve the model-service admission rollout rule:
update every model-service replica to the shared FIFO/admission implementation before enabling async
Reach Deck traffic, so an old replica cannot bypass live waiters. Explicit async opt-in protects
legacy clients from parsing a 202 response, but it does not replace either fleet-convergence
requirement.

Narration is limited to 2,000 semantic units plus 10,000 Unicode code points. A formula node counts
as one unit; each CJK/non-Latin grapheme, visible punctuation/symbol, or emoji counts as one; each
maximal Latin-letter/digit token counts as one; whitespace and Markdown/LaTeX delimiters count as
zero. The DSL owns parsing, canonicalization, counting, speech-range validation, and digest input so
editor, jobs, materialization, preview, and publication use the same contract. Roll out a narration
limit increase by deploying content-service first, followed by AI Runtime and then Teacher, so mixed
versions cannot send newly accepted content to an older publication validator. Teacher can show or
hide speech marks, add/edit/remove them in the rich-text history, request revision-bound AI
candidates, adopt or ignore candidates individually, and preview a bounded selection through the
normal Teacher BFF. Preview itself creates no generated-media asset. A complete single-chunk preview
(within both the 80-unit and 150-character SSML limits) can cache audio and real timestamps in Redis for
15 minutes, with one latest entry per actor/scope/page and an 8 MB audio bound. Formal generation
checks durable media first, then can reuse a matching preview after voice authorization; identity
includes content, speech markup, synthesis profile, voice/clone revision, and alignment transcript.
Selected fragments are never promoted. Expiry, unavailable Redis, or invalid timestamps fall back
to ordinary synthesis; reused audio is persisted through the normal media/timestamp boundary.

Narration copy/cut exports a bounded, versioned fragment in clipboard HTML element attributes and
an optional custom MIME type. Plain text contains supported SSML only when the selection has speech
marks; those tags intentionally remain visible in plain-text destinations. Paste validates every
foreign fragment using the narration DSL, reallocates IDs, preserves permitted paragraphs, line
breaks and formulas, and respects the current voice's allowed mark types. Complete selected spans
retain pronunciation/alias semantics; partial spans become their selected source text. Point-node
inclusion follows the editor selection, including an explicitly selected pause.
Rich-copy failures fall back to source text; a cut never deletes its selection if all clipboard
writes fail. The decoded fragment and escaped HTML carrier have separate size budgets, and the
plain-text tag scanner bounds token/candidate counts before parsing XML.

Plain-text import accepts break, sub, say-as, phoneme and soundEvent according to the existing
capability policy. Experimental sound events remain disabled in the standard narration configuration.
Break shorthand `<break 300ms/>` and whole-millisecond seconds values remain supported. Invalid,
nested, disallowed or unsafe tags fall back to text with localized feedback. Fragment paste never
changes document-level speech settings. Parsing works with detailed tags hidden; range shading and
compact pause/sound placeholders remain visible without adding characters to saved narration or TTS.
An active formula input retains its dedicated paste behavior, and one paste is one undo step.

POST `/tools/speech-preview` always returns a
`reach-deck-speech-preview-task/v1` envelope immediately. GET and DELETE
`/tools/speech-preview/{requestIdentity}` reauthorize the complete actor/grant/billing/resource
scope. The browser polls short requests using the response body's bounded `pollAfterMillis`
and displays queued, running, ready, failed, cancelled, draining, or expired. Queue position
is not available and is not inferred. Editing, navigating, or stopping sends best-effort DELETE
and fences late results by page revision, narration digest, and request identity.

Preview uses the independent `teacher-deck-speech-preview` channel in the existing Courseware
process, with `AI_RUNTIME_TEACHER_DECK_SPEECH_PREVIEW_CONCURRENCY` (default 2); it cannot compete for the
ordinary generation queue's two slots or enter generation audit/workspace mutation paths.
Each submission has a fresh nonce; retries within that submission preserve its model identity.
Redis stores bounded, temporary state and audio, not bearer tokens or clone capabilities.
Each provider attempt exchanges a fresh capability. Model-service queue responses persist
state and delay the BullMQ job instead of occupying a worker slot. An ambiguous in-flight
worker recovery fails closed rather than resynthesizing and risking duplicate billing.

[Course-agent voice auditions](../product/course-agents.md) reuse this editor, channel and task
lifecycle through `/api/course-agents/speech-preview`. Their explicit course/configuration scope
requires no Deck module and rechecks the selected, potentially unsaved language and voice against
live course-management permission and configuration version. Course auditions do not populate
Deck preview caches or support formula-reading model calls. Deploy the compatible Teacher client,
teacher-service, content-service, model-service, Runtime API and Courseware worker together.

Confirmed pre-provider cancellation releases the page admission lease. A call already running
may only drain: its late result is discarded, and admission stays held until the call settles
or the original 15-minute deadline. The UI does not claim the provider stopped or charges were
reversed, and a new preview on that page can remain temporarily blocked during draining.
If no local provider call remains, the worker delays the same job and retries only cancellation
until it is confirmed or the original deadline expires; it never re-enters synthesis.
Polling does not consume submission rate quota. Full-preview timestamp/cache reuse remains
unchanged. No generated-media asset is created by preview alone.
Cancellation of a not-yet-visible task stores a short-lived tombstone, limited to 32 new
identities per minute per authorized scope. Known-task and repeated same-identity cancellation
are exempt. BullMQ return values contain only
identity/status; preview audio is read from the bounded result record, not duplicated there.

Rollout: deploy compatible Courseware workers consuming the new channel, Teacher client, and API
together. Asynchronous preview is always enabled without a feature flag. Env examples
and the AppStack AI Runtime template declare the independent worker concurrency. This change does not apply live
configuration. Repository Teacher Ingress declares 600-second listener idle timeouts, but the
test cluster inspected on 2026-09-22 did not contain those annotations; effective cloud ALB
timeouts have not been verified. Async preview does not require a long-lived synthesis HTTP request.
Candidate actions are
locked during page save/generation, and stale page revisions return a dedicated recovery message.
Smart marking reuses `courseware.deck.narration.chat` for pronunciation corrections only:
contextual letter/abbreviation readings, classical Chinese borrowed or rare characters, and English
phonemes. It proposes only `sub`, `say-as`, and `phoneme`, returns no candidates for ordinary text,
and never inserts pauses automatically. Manual pause marks remain available and are preserved.
Cloned voices support the same pronunciation candidates and manual four-tag editing as the
standalone comparison harness. Sound events and root voice effects remain unavailable for clones.

The static layout judge remains an offline acceptance and layout-reference validation utility. The
production generation pipeline does not call it, persist judge results, expose runtime layout
warnings, or gate completion on warning acceptance. Offline evidence may still classify visible
canvas clipping, text overflow/scrollbars, failed assets, materially hidden or overlapping content,
detached arrows, and unusably small primary media for prompt and catalog iteration.

The browser event endpoint accepts `Last-Event-ID` and replays retained events before blocking for new events. Reconnecting therefore attaches to the same `jobId`; it does not submit another provider request or BullMQ job. If the cursor is older than the retained stream, the endpoint emits `stream-expired` and the client reads the durable status/result.

An explicit cancel aborts the worker and writes a terminal `cancelled` state. A transient disconnect, page navigation, or pending-session expiry does not cancel work. Successful durable results are retained independently of the Redis Stream and pending role-app record.

## Decksmith page context and durable conversation

Decksmith has one teacher-private chronological stream per stable page, not one module-wide chat.
Teacher reads and mutates it only through the same-origin `/api/reach-deck/*` proxy. AI Runtime
reuses `public.ai_thread` for the page stream, `public.ai_run` for turns and controls, and
`public.ai_run_event` for results, application guidance, and rolling summaries. The canonical scope
contains identifier/hash facts only: teacher, organization, optional billing group, exact
course/node/module/draft-version, and `pageId`. Creation is serialized with an advisory transaction
lock and duplicate matches fail closed. This introduces no table, field, constraint, index, entity
mapping, or shared-data migration.

Teacher renders a single oldest-to-newest column for the active page, retrieves older entries with
bounded keyset pagination, and recovers completed background results after page switches or reloads.
`New topic` appends a visible control divider and advances the page epoch. The preceding entries
stay visible, but only turns from the new epoch may enter later model requests. Current-page
conversation deletion appends a soft-delete control and advances both UI visibility and model
cutoffs. It never deletes the raw Runs/Events. There is no topic browser, parallel topic, separate
Clear context, teacher export, whole-deck deletion, restore UI, management archive endpoint,
scheduled purge, or automatic deletion. A future management archive/delete facility must use a
separately authorized interface; storage growth is not handled by silently expiring teacher history.

Each new turn reauthorizes the teacher and materialized workspace, acquires a page-scoped lease on
its origin page, and freezes the following into the Run input:
page epoch/sequence, baseline document hash and page revision, exact context references, selected
complete-turn range and digest, summary/cutoff lineage, capacity profile, and authorization evidence.
The BullMQ payload carries identifiers and digests rather than prompt/history/document bodies. The
worker rehydrates the frozen state, rejects stale or cross-scope inputs, and lands results only on the
origin page stream. Existing 24-hour legacy recovery remains readable during the transition.

Turns on different pages of one deck may run, and hold proposals awaiting a decision or adoption,
at the same time, including in one browser tab; one page holds at most one turn, and a deck admits at
most 64 active leases (acquisition clears expired rows first). Overlap never rejects a proposal: it is
recorded, the store reports the other turns on the pages it changes (origin page and running /
pending / approved-unsaved state, also carried as `pageConflicts` on `artifact.proposed`), and page
conversation controls are ignored. Approving runs under the same deck lock as lease acquisition,
cleanup and document writes: it re-reads the approval, lease activity, other turns and the current
document, then records the decision on the lock-holding connection. Other turns on those pages
(`held`) and pages changed since the proposal was made (`stale`) need `override=true`, otherwise
`409 DECKSMITH_PROPOSAL_PAGE_CONFLICT` with details; another approved but unsaved proposal on the same
pages, a changed page structure, or a changed document envelope (title, theme, masters, layouts,
media) for a proposal that itself changes the envelope cannot be applied
(`409 DECKSMITH_PROPOSAL_NOT_ADOPTABLE`); a proposal whose lease expired after two undecided hours
cannot be approved (`409 DECKSMITH_PROPOSAL_EXPIRED`). `GET /api/approvals/:id/conflicts` previews the
report. Decide, applied and conflicts share one authorization check: the selected role grant and
organization must match the frozen proposal and the request's module scope headers its module. The
check also runs before idempotent retries of an already rejected or applied approval, so a refused
retry never releases a lease; that proposal's lease is already inactive and the next acquisition
reclaims its row.
`/applied` confirms exactly its own approval's proof. Page saves pick the approved proposal changing the
page (then the one started from it) and fail closed if two claim it; whole-document saves (explicit
save and trial) land every approved proposal together when none is structural and no page is changed
by two, checking each proof on its own. The document writer re-checks its adoption snapshot under the
lock. A recorded approval always lands in the draft (the rebase is checked before approving), and a
reload never approves a proposal the runtime still has pending. Ordinary and async document writers, legacy recovery turns and
structural routes still need the whole deck (`409 DECKSMITH_DECK_LEASE_ACTIVE`).
When the authoritative document does not hold an approved candidate, `/applied` normally answers
`409 candidate_not_authoritative_yet` and keeps the lease; a changed page rewritten meanwhile can
still be overridden by the approved candidate. If the deck's page structure or envelope has
meanwhile drifted from the proposal's baseline, the proposal can never land as approved: `/applied`
resolves it under the writer lock (the save-time supersede convention, `artifact.applied` with
`supersededByDeckChange`), releases its lease, and answers `409 proposal_expired`
(`DECKSMITH_PROPOSAL_EXPIRED`). Teacher settles that approval as not adopted, never as applied, so
the structure lock, the page and the composer are released instead of looping on the confirmation
retry. The conflict report (`GET /api/approvals/:id/conflicts`) also covers approved proposals that
are not yet applied, so a reload restores an approved proposal whose other pages changed as ready
and rebases it by its changed pages instead of marking the whole recovery stale.

Unresolved Decksmith work no longer hard-locks the page structure in Teacher; only pages under
generation do. When a Decksmith request is running, a proposal is pending, or an approved proposal
has not landed, adding, removing, duplicating or reordering pages opens a confirmation ("放弃
Decksmith 的修改？", discarded changes cannot be recovered). On confirm the editor rejects every
pending proposal it holds, then the host cancels running Decksmith jobs and waits until they are
done (so their leases are released and the save is not refused as a guest write), rejects pending
recovered proposals, and marks approved proposals for supersede. The next structural save sends
`supersedeDecksmithProposals: true` to `POST /api/reach-deck/workspace/rematerialize`. The host
counts confirmations, and a successful save consumes only those that existed when it was sent, so a
confirmation made while an earlier save is in flight still reaches the next save. Undo and redo go
through the same check as any other edit: a history step that changes the page structure beside
unresolved Decksmith work, or deletes a page that is now generating, opens the same confirmation.
Cancelling leaves the draft and the undo/redo history untouched; confirming replays the same step.
A step that the page locks would still refuse (re-inserting a page during generation) is dropped
without asking and without discarding Decksmith work. Only with that
flag does a whole-document write that does not match an approved structural proposal resolve it as
superseded by the teacher (`artifact.applied`, outcome `superseded`, lease released) instead of
answering `423`. Page saves never carry it, and without it the exact-adoption rule above is
unchanged. While an approve/discard decision is still being recorded, structural edits are refused
with a short notice, because the adoption that follows carries the proposal's own page structure.

Pages can be deleted while generation is in flight, including pages that are still generating;
adding, duplicating and reordering pages still wait until generation ends. Deleting a page whose
status is pending, generating or narrating opens a confirmation ("删除正在生成的页面？"), and the
next structural save carries `cancelDeletedPageGeneration: true`; without it the runtime answers
`423`. The host tracks confirmed pages individually: a structural save carries the flag while its
payload lacks a confirmed page and, once it succeeds, forgets only those pages, so a second deletion
confirmed while the first is still saving keeps its confirmation. A save whose only structural change is deleting pages (no new page, the remaining pages keep
their order and native bindings) no longer stops every batch of the run. Instead
`cancelReachDeckDeletedPageGeneration` (`lib/reach-deck/page-deletion.ts`) cancels only the
deleted pages' unfinished work before the document is written: it covers unfinished members of
active batches (cancelled with the batch owner's scope) and standalone layout and narration jobs
that have not been applied. Each job gets a queue cancellation, its audit is aborted, and a run the
queue no longer holds has its Runtime run cancelled. Any failure aborts the save before the write.
`retireReachDeckWorkspaceDeletedPageWork` then moves those members from `members` to `skipped`
(reason `page-deleted`), renumbers the rest, and rewinds `dispatchCursor` to the dispatched members
that remain. A batch whose unfinished members were all deleted ends with them cancelled. The cancelled jobs' descriptors, results and TTS continuations are removed, and the same recovery
write records the deleted in-flight pages in `recovery.deletedPageRetirements` (per run). A retry
whose audit abort failed after the queue cancellation still aborts the audit (an already terminal
audit counts as done) instead of skipping the already cancelled job. Batches still running get a
new coordinator tick at the rewound cursor, so the later members keep dispatching. After the write
the workspace retires the deleted pages even though their status was still in flight. The route
then advances the generation lanes once, because the initial chain only advances when a job lands
or fails and would otherwise stall behind the cancelled page. If the write lands but the workspace
synchronization fails, the next save can no longer derive the deleted pages from the document diff.
Every structure synchronization (`synchronizeReachDeckWorkspaceDocumentStructure`, also used by
publication) therefore also retires recorded pages that are absent from the document. Recorded pages
still in the document (the write failed) stay recorded until the teacher deletes them again.
Rematerialize also settles an unfinished deletion first: right after taking the writer lock, before
the CAS and page-lock checks, it retires recorded pages missing from the current document
(`recoverRecordedReachDeckPageDeletions`). Otherwise a ghost page still marked pending or
generating would fail every later save's page-lock check with `423`. The CAS still compares against
the revision the teacher loaded, and the write then uses the recovered revision. A record is cleared
only after the lane advance succeeds (`settleAdvancedReachDeckPageDeletions`). A lane that could not
build or register its next request this time (a read failure, a pending page whose preparation
failed, or exhausted revision conflicts) answers `deferred` rather than `no-pending-request`, and
then the record stays too. Paused lanes also retain the record, so a save after resuming still
advances the remaining pages. Obsolete runs may settle their own records without touching newer
runs. Settling removes only the advanced run's pages and keeps records of any
newer run: it runs after the writer lock is released, so a slow advance of an old run may finish
after a new run has recorded its own deletions. The advance runs after
the writer lock even when the save itself fails, for example on the CAS conflict a stale client retry
gets. If retiring, advancing or settling fails, the record stays, so the next rematerialize advances
again. Readers that predate `deletedPageRetirements` reject a recovery document that
carries it, so ship the AI Runtime API and Workers together.

Teacher keeps busy state, streaming progress, cancel, recovery and approvals per page: its tab-scoped
session records hold one entry per page, a reload observes all of them (and the workspace projection
fills in every page's latest unresolved job), and the page rail marks running and pending pages. The
editor applies a proposal only after its approval succeeds; a refused approval shows the conflict
report (override, wait or discard) and can be confirmed again, and a failed approval leaves the save
barrier without being re-decided. Every `/applied` request goes through one queue while each proposal
advances on its own. A proposal that cannot be merged is kept with a notice, never rejected on the
teacher's behalf; ready recoveries keep their checked baseline, and a recovered proposal whose starting
draft is gone is rebased by the pages its adoption proof changes, taking the whole envelope from the
candidate only when the proposal changed it.

Leases keep the `reach-deck-decksmith-deck-lease/v1` JSON shape in `ai_thread.context`. Rollout and
rollback are manual, with no switch: ship the AI Runtime API and Workers together and finish the
rolling update quickly, because processes that predate page-scoped leases return 500 when they meet
several leases on one deck. After a rollback, leftover leases are cleared by the reviewed maintenance
procedure in `docs/plans/2026-09-29-decksmith-page-concurrency.md`.

An asynchronous generation lease is a persisted ownership record, not a PostgreSQL connection
held while the model or TTS runs. Standalone narration saves its durable result before entering the
writer section. That section retains a dedicated PostgreSQL session while it reads and writes
content and recovery state; callers waiting for the SQL advisory lock also retain connections.
Connection checkout, SQL lock acquisition and writer/connection hold times have separate correlated
logs, so a five-minute SQL lock timeout must not be interpreted as a bound on pool checkout.
Correlation with individual queue jobs uses active tracing; when tracing is disabled, the logs
still identify the checkout, lease owner and deck scope but do not include the job's trace context.
Async lease release first checks whether durable work remains active before requesting another
writer session; apparent settlement is rechecked under the lock before release. Pool sizes and
timeouts are unchanged. A shorter checkout deadline first needs landing-only recovery for single-pass
slide jobs, which currently do not automatically retry a failed landing.

After successful standalone landing, a failed settlement precheck or lease release
logs `deck.writer.cleanup.deferred` and preserves the successful result and lease
owner. Subsequent ordinary writes reconcile that owner after the existing visibility
grace period. Errors inside an inherited writer session and admission reentry still
propagate; a failed landing retains its original error even if cleanup also fails.
Explicit lease-release calls retain their original error contract.

All six dedicated-pool entry points participate in process-local admission by the same canonical
deck key used for SQL locking. The shared Pool has one admitted operation per deck, spanning checkout,
SQL locking, session drain and connection cleanup; other decks proceed independently. Admission wait
logs use the same checkout correlation and are separate from pool/SQL waits. Owner-only operations
pre-read scope using the main pool and verify it again before requesting the SQL lock. PostgreSQL
remains the authority across processes. Supported nested work reuses its held writer session;
additional dedicated admission from an active owning context rejects with an internal reentry error,
including detached calls started during ownership. Completed contexts must obtain fresh admission.

PPTX, MAIC and Interactive HTML apply prepare candidates before writer acquisition, using an
independent process-local preparation queue per deck. PPTX package parsing, image/metafile conversion
and content-addressed media uploads, MAIC mapping/snapshot reads and HTML static compilation do not
retain writer connections. The writer re-reads the authoritative target, checks exact durable retries
first, then verifies the preparation inputs and target revision/digest before the existing CAS write.
HTML changed writes also bind the prepared target snapshot so rewind and narration changes cannot
be overwritten by an old candidate. MAIC exact applied retries continue without an unexpired media
snapshot, including a concurrent application that lands while preparation reports snapshot expiry.
Preparation conflicts do not delete shared media. Generation receipts and reconciliation remain
inside the existing protected write protocol.

The Teacher composer shows removable current-page and mentioned-page chips. `@page` creates a
structured reference to an exact page ID/revision; the agent is instructed to call
`read_page(pageId)` directly against the authoritative frozen document, without first listing pages
and without reading that page's conversation. Native slide elements may create focused refs. An
Interactive element is focusable only when its authored HTML has one matching
`data-reach-component-id`; the authoring bridge validates nonce, source window, monotonic sequence,
rate, page/revision, bounded metadata, and exact static outer-HTML baseline. Learner mode emits no
accepted focus. Quiz exposes whole-page context only.

The exact model input is therefore distinct from visible UI history: it contains the origin page
document/tool access, current prompt, frozen references, an optional last-good page/epoch summary,
and at most 12 recent complete messages within 60,000 serialized UTF-8 bytes. Earlier raw turns are
not deleted. AI Runtime sends model-service only a content-free serialized-byte/structure measure.
Model-service resolves the current `teacher.deck` execution slot and returns one deployment-wide
Decksmith input capacity and output reserve. It does not scan candidate Profiles or maintain
per-model capacity entries; every Profile admitted to the Decksmith slot must satisfy the same
operator-managed minimums. Default approaching/compaction/blocked bands are 65/80/90 percent and
are configurable only in increasing order. Transport unavailability falls back to a deliberately
blocked one-unit guarantee; invalid or unauthorized capacity responses fail closed. Model policy
admission still requires deployment backend availability, enabled/non-retired catalog state, and an
explicit non-empty `compatible_execution_slots` declaration containing the resolved slot.

When older complete turns exist and capacity reaches compaction range, a metered service-only child
Run creates a page-and-epoch-local rolling summary with exact source range, digest, previous-summary
lineage, page facts, unresolved decisions, proposal outcomes, and usage provenance. Installation is
row-locked and rejects stale output. Failure preserves raw history and the last good summary; the
parent uses its frozen bounded recent complete-turn plan or terminates safely if the input still
exceeds the guarantee. Public history exposes only localized natural-language capacity states. A
blocked request never dispatches to the model and recommends `New topic`; teachers never need to
interpret token measurements.

Cross-turn memory uses a versioned history projection. `decksmith.result` keeps the fixed UI
`message` and adds the bounded final model reply (`assistantText`, at most 1,500 UTF-8 bytes) and a
structured `changeSummary` derived from the final document diff. New turns freeze projection v2 in
the Run input: the proposal outcome (approved, rejected, pending, superseded) of each source turn as
known at enqueue, outcome updates for summary entries that were still pending, and bounded plain-text
hints for the selected elements. Execution, compaction and summary installation rebuild history from
that snapshot, so approvals that land after enqueue never stale a queued turn; Runs and compaction
inputs without `projection` keep the v1 projection and digests. Rollout and rollback are manual,
with no switch: ship the AI Runtime API and Workers together and finish the rolling update quickly.
Processes from before this change reject Run inputs that carry `projection` and job results that carry
`assistantText` (an old Worker fails such a turn; an old API cannot list that page history or
authorize its approvals and omits those turns from the history it freezes). Rolling back therefore
leaves every page stream that recorded a v2 turn unreadable to the older version until a fixed
forward release is deployed.

The system prompt and tool contract are versioned as well. New turns freeze
`promptContractVersion: "decksmith-prompt/v2"`: a sectioned system prompt (role, product model and
teacher vocabulary, workflow, tool-selection table, slide/picture/narration/Interactive rules,
honesty) and an on-demand Interactive contract. The full Interactive authoring contract is no longer
injected into the first message; the model calls `read_interactive_authoring_contract` once per run,
and the Interactive insert, edit, write, geometry-proposal and commit tools return a non-error
`DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED` refusal (nothing changed) until it has. An Interactive origin
page only adds a one-line hint, so converting a GenUI page into quiz pages never pays for the
contract. Runs without the field (queued before this change) keep the verbatim v1 prompt, the v1 tool
surface, and the v1 injection rule; enqueue-time and execution-time capacity measures use the same
frozen version. Workers from before this change reject Run inputs that carry
`promptContractVersion`, while new Workers execute Runs queued by an older API as v1. On its own this
field therefore needs the Courseware Workers on the new image before (or together with) the API, as
for `visualInputs`; combined with projection v2 above, ship API and Workers together with no switch.
To roll back, roll back the API first and let queued v2 Runs drain before rolling back the Workers.

Token budgets are gated before dispatch. The durable Worker reads a read-only snapshot of booked usage
(`readTeacherDeckBudgetSnapshot`: this Run and the actor's last 24 hours, against
`min(run.tokenBudget, perRunTokens)` = 200k and the daily limit) and gives Decksmith a run-scoped
controller. Every main model call (in `onPayload`), every picture/draft tool, and every sub-call
attempt inside a tool (including transient-retry and correction attempts) must fit its deterministic
estimate plus reserves: a main call reserves its `max_tokens`; a tool or sub-call also reserves one
more summarising main call. The first main call is estimated from the UTF-8 bytes of the
model-visible request; later calls use the previous call's real input plus the bytes added since.
Usage is counted in the controller the moment it happens, so late forwarding to booking cannot let
a batch overrun. When the next dispatch does not fit, Decksmith stops without calling the model: the
session's verified changes become a normal partial proposal and the outcome carries a bounded
`remainingTasks` list (at most 8, each at most 300 UTF-16 code units) plus
`completion: { state: "budget-limited", scope: "run" | "daily", messageKey }`. Interactive working
copies that were opened or edited but not committed are not in the proposal; each is listed as a
remaining task so it is never dropped silently. Once 25% or less of the run limit remains (and one more call still fits), a one-time
runtime note asks the model to stop starting new work and list `Remaining tasks:`. The Teacher result
card shows only the localized count notice; the task text enters the next turn's v2 history so
"continue" can resume against the current deck. Cancellation and guardrail rejection still fail the
turn. The shared booking function keeps its hard run/daily limit for every teacher.deck flow. Older
Teacher clients reject a budget-limited outcome, so ship Teacher, API, and Workers together.

The model loop also stops after 64 main calls (`DECKSMITH_MAX_TURNS`, a runaway guard only; cost is
bounded by the budget gate above). Runs frozen as v6/v7 call one tool per response, so converting a
page into 10 quiz pages already takes 14 calls; v8 batches independent calls to reduce this overhead.
When the loop reaches the limit while the last assistant message
still calls tools, the turn was cut off, not finished: the outcome is a partial proposal with
`remainingTasks` (uncommitted Interactive working copies plus one continuation entry) and
`completion: { state: "step-limited", messageKey: "reachDeck.decksmith.stepLimited" }`, the result
message says the step limit was reached, and the next turn's history names the step limit instead of
the token budget. A budget stop takes precedence. Teacher clients without `step-limited` reject the
outcome, so ship Teacher, API, and Workers together.

Structured clarification (WP7 phase 1) adds `promptContractVersion: "decksmith-prompt/v3"` for new
turns: the v2 prompt and tools plus `ask_teacher({ question, options?, candidateElementIds?, pageId?,
expect: "choice" | "select-element" | "text" })`, and the prose "ask which one" rules (nothing
selected but several elements fit; 互动题 versus simulation) now call it. Runs frozen as v2 keep the
v2 prompt and tool surface byte-for-byte. `ask_teacher` is accepted only before the run's first change
(session document changed or an uncommitted Interactive working copy); afterwards it returns the
non-error refusal `DECKSMITH_ASK_TEACHER_AFTER_CHANGE` and the model must finish and report, so no change
is dropped. Once it succeeds, every later call in the same batch returns `DECKSMITH_BLOCKED_BY_QUESTION`
without running and the loop stops without another model call. The result has no document or
proposal; `outcome.clarification` carries a server-derived `questionId` (`dq_` + 32 hex, stable per
Run), the question, at most 5 options, and at most 8 candidates (`pageId`, `pageRevision`,
`elementId`, label = type + alt/text prefix) that must exist on the stated page (default: the current
page). The Run completes normally and releases its lease. The v2 projection of that turn appends a
bounded question block (id, options, candidate labels). The Teacher card shows the question, option
buttons, candidates (for `select-element`, clicking a candidate on the current slide selects it on the
canvas and sends "选这个/This one" with it as the context ref), and a text-reply path; composer
messages are linked to the open question unless the teacher switches them to a new request. The client
sends `answersQuestionId`; at enqueue the API freezes `clarificationAnswer: { questionId, status }`:
`answered` (with the question text) only when the question belongs to the latest turn of the current
page stream and epoch, `duplicate` when a later turn already answered it, otherwise `stale` (later
turns, a new topic, a compacted turn, or an unknown id). Stale and duplicate answers never fail the
request; they add a note to the model input, and the answering teacher entry links to the question in
later projections. Turns without these fields project byte-identically. Older Workers reject Run
inputs with `clarificationAnswer` or a v3 version and older APIs reject outcomes with
`clarification`, so ship Teacher, API, and Workers together, as above.

Canvas picking (WP7 phase 2, editor-only, no contract change): while the latest open question expects
`select-element`, the editor outlines each candidate on its slide canvas with a numbered badge (a host
overlay rendered in the native stage coordinate space via `ReachDeckPlayer.nativeStageOverlay`) and
shows a pick bar above the canvas. Clicking a highlighted element (or its badge, for keyboard users)
selects it without leaving the Decksmith panel and offers "用这个/Use this"; confirming reuses the
phase-1 send path with `answersQuestionId` and the element as the native-element context ref.
Non-candidate clicks keep normal selection; Esc or "退出点选/Stop picking" leaves the mode and the card
offers "在画布上点选/Pick on canvas" to re-enter. Candidates whose page or element is gone, or whose page
revision differs from the asked `pageRevision`, are shown as unavailable (dashed outline, disabled
badge and card button). Locked or busy pages keep badges inert. Candidates on another page offer "前往第
N 页/Go to page N"; picking there (or clicking the card button) returns to the asking page and answers
with text, that page as a page reference, and the candidate's `pageId + elementId` as a native-element
context ref on that page (`mentionedElements` on the editor request, `mentionedNativeElements` on the
context selection). The Runtime validates refs on any page and names them in "Exact focused
components", so two candidates with the same label on one page stay distinguishable. Selected-picture
vision still attaches images from the origin page only. Native component context
chips show a type icon and name plus a bounded alt/text prefix (images use the already-loaded media URL
as a thumbnail) and keep the element id in the tooltip; Interactive component chips are unchanged and
quiz component refs remain unsupported.

Multi-quiz authoring (WP3 option A) adds `promptContractVersion: "decksmith-prompt/v4"` for new turns:
the v3 prompt plus a `QUIZ PAGES` section (convert a page into N quiz pages in one turn with
consecutive positions and distinct targets; keep the source page for "放在它后面", delete it only in a
later turn after every insert succeeded; on a failed insert keep the successful pages, fix and retry
only the failed one, then `move_page` if the order drifted). `read_quiz_authoring_contract` returns a
Decksmith-only contract (one question per page; `single_choice` / `multiple_choice` / `short_answer`,
the same set the normalizer accepts; open-ended = `short_answer` + `has_answer: false` + empty
`answer` with no scoring fields) and answers `already-read` while its full text is still in history.
`insert_quiz_page` refuses a question already written in the run (same whitespace-insensitive stem and,
for choice questions, the same option texts; `replace_quiz_scene` re-keys the page) with the non-error
`DECKSMITH_QUIZ_DUPLICATE` (`existingPageId`). In v4, `replace_quiz_scene` runs the same per-question
open-ended cleanup and Markdown normalization (multi-question pages and sub-problems allowed, no
generation-type restriction) and appends `Diagnostics` to its result. In model history, older successful quiz writes become a
`[quiz receipt ...]` (page id, question type, 40-character question prefix, `has_answer`, SHA-256 of
the sent `sceneJson`); failed writes and the write just made stay verbatim; quiz/Interactive
`read_page` results become stale receipts after a later successful `insert_quiz_page`, a
`replace_quiz_scene` of the same page or `delete_page`; and the contract is held server-side once a later quiz write succeeded and the latest
turn has no failed quiz write (a reread then returns the full text). In every version the normalizer
strips `answer`, `scoring_points`, `answer_components`, `acceptable_variants`,
`partial_credit_examples` and `typical_wrong_answers` from an open-ended question and reports it in
`diagnostics`. Runs frozen as v2/v3 keep their prompt, contract text and history shape. Replay
measurement (GenUI with ~15 KB HTML to five ~3–5 KB open-ended quizzes): one-turn batch 257k → 223k
dispatch upper-bound units (≈65k → 56k tokens), one quiz per turn 542k → 432k (≈138k → 109k).
Older Workers reject v4 Run inputs, so ship API and Workers together.

One tool call per response introduced `promptContractVersion: "decksmith-prompt/v6"` (found
2026-10-09). At that time, OpenAI-family models (including the then-default `openai/gpt-5.6-luna`) returned an
empty `arguments` string for every tool call whenever one response carries two or more calls, through
both LiteLLM and RouterLink, streaming or not, and `parallel_tool_calls: false` is ignored; single
calls, Gemini and Claude are unaffected. The v1–v5 prompts encouraged same-turn batching, so v6 keeps
the v5 tool surface and rules but replaces every batching instruction (WORKFLOW step 4, the
Interactive-contract row, `QUIZ PAGES`, `ASKING THE TEACHER`) with "call exactly one tool per
response and wait for its result"; runs frozen as v1–v5 keep their prompt bytes. A runtime guard
(`decksmith/parallel-arguments-guard.ts`) applies to every version because it changes neither the
prompt nor the tool schemas: when one assistant response has two or more tool calls and a call to a
tool with required parameters arrives with empty arguments, the call is not validated or executed and
its result is `[DECKSMITH_PARALLEL_ARGUMENTS_DROPPED] ...call one tool per response and resend this
call.` The guard hooks the tool's `prepareArguments` (pi-agent-core runs it before schema validation;
`beforeToolCall` runs after) and finds the current assistant message through the live message array
seen by `convertToLlm`. Such calls keep their call/result pairing, emit `tool-end` with
`isError: false`, and do not count toward `outcome.toolErrorCount`; the response's usage is booked
as usual. Tools without required parameters (`list_pages`, `read_quiz_authoring_contract`) and single
calls behave as before, including the ordinary validation error for a single empty call. Replay
measurement for the v6 shape (same GenUI to five open-ended quizzes, nine model turns): 500k dispatch
upper-bound units (≈127k tokens), which the WP4 gate admits in full under the 200k run budget with
uncached worst-case usage. Older Workers reject v6 Run inputs, so ship API and Workers together.

Quiz scene shape adds `promptContractVersion: "decksmith-prompt/v7"` for new turns (2026-10-09). The
v4 quiz contract was the deck-generation authoring corpus, which relies on a structured-output schema
and names no fields, so Decksmith (which writes `sceneJson` by hand) guessed them: live-model samples
sent the stem as `prompt` on 4 of 4 first inserts, `learning_fence` as a string, and once resent a
history `[quiz receipt ...]` as `sceneJson`. v7 keeps the v6 tool surface and prepends a
`SCENEJSON FIELD REFERENCE` with two minimal examples to the quiz contract
(`decksmithQuizContractTextV7`), names the stem field in the `insert_quiz_page` description, and
changes three prompt lines: the vocabulary-conflict rule judges the requested output, not the source
page (a simulation GenUI turned into N 课中互动题 is a clear quiz request); the conversion rule ends
with deleting the source page after all inserts when the teacher said 改成/换成/替换掉; the receipt rule
says a receipt is never a tool argument. Runs frozen as v1–v6 keep their prompt and contract bytes.
Runtime compatibility for every version (`repairFieldMistakes` in `quiz-model-output.ts`, used by
`insert_quiz_page` and v4+ `replace_quiz_scene`) turns input that would otherwise be rejected and
whose meaning is unambiguous into the intended shape: a single stem alias (`prompt`, `stem`,
`question_text`) becomes `question`; a string `learning_fence` becomes `{enabled: true, prompt}`, and
an empty string or `false` is dropped; on insert a missing scene title is derived from the stem (24
code points), while replace keeps the current page title instead. The one exception to "previously
rejected input only" is a `learning_fence` object with a prompt but no `enabled`: the DSL used to
accept it and silently drop the hint, so it now gets `enabled: true` when the prompt is within the DSL
limit. Every repair is reported to the model as `fieldRepairs` (insert) or `Field repairs:`
(replace), separate from teacher-facing `diagnostics`; deck generation does not enable it. History
receipts read the stem through the same alias rule (`quizQuestionStemValue`), and the quiz contract is
held server-side only when the latest successful quiz write needed no repair (its verbatim arguments
would otherwise show the wrong field names). A `sceneJson` that starts with `[quiz receipt:` is
rejected with an explanation instead of the generic parse error, and the open-ended `has_answer`
rejection now says how to resend (short answer without options, or a choice question with a key).
Live-model check (luna, GenUI to five open-ended quizzes): first-insert errors 6/26 → 1/24, average
turns 10.3 → 7.8, no clarification questions in 12 samples. Older Workers reject v7 Run inputs, so
ship API and Workers together.

Independent tool batching adds `promptContractVersion: "decksmith-prompt/v8"` for new turns
(2026-10-15), after gateway probes confirmed intact streamed tool arguments on the current Sonnet
route. The production transport probe used the normal service token, model-service, LiteLLM and
RouterLink chain with the Decksmith slot resolved to `anthropic/claude-sonnet-5-5`: three reads,
mixed no-argument/required-argument tools, and five large `sceneJson` calls, each tested twice
(6 groups, 22 tool calls). All arguments and call ids survived, and subsequent responses accepted
the paired tool results. Tools were simulated and no courseware was modified; this verifies the
transport, not a newly completed teacher editing task. It retains the v7 tools, quiz field references,
history receipts, clarification and adoption
rules, while removing the unconditional one-tool-per-response instruction. Known independent reads
(including page content and authoring contracts) can share a response; edits can be batched once
their required context and arguments are known. The agent still executes tools sequentially in the
stated order. A call depending on a result waits for a later response: discovery before using its
ids, contracts before authoring, draft before placement, and Interactive edits before validation and
commit. For a page-to-N-quizzes conversion, insert the planned questions in one batch, inspect every
receipt, and only after all inserts succeed delete the source in a later response; failed inserts
are repaired without duplicating successful pages. `ask_teacher` remains a standalone call before
any mutation. Budget, clarification and guardrail stops still block the rest of a batch. The empty
parallel-arguments guard remains as a conditional fallback and does not reject intact batches.
Runs frozen as v1–v7 retain their exact system and authoring contract bytes. Older Workers reject v8 Run inputs,
so ship API and Workers together; changing the model slot alone does not upgrade a frozen Run.

Before contract cleanup, the v8 live-model fixture check (`genui-to-five-open-quizzes`, Sonnet through LiteLLM, one sample)
completed five open-ended quizzes and source removal in four model responses, with zero tool errors:
61.1 seconds, 28,587 input tokens and 2,577 output tokens. Content operations used isolated in-memory
fixtures; this is a quality check separate from the production transport probes and does not prove
that an end-user production conversation has completed after the model switch.

V8 also separates Interactive and Quiz editing contracts from generation output
instructions. Interactive composes the bridge, JSON/source guidance and geometry capability details
once; editing uses working-file patches/rewrites and commit diagnostics rather than generation's
one-correction/full-scene response policy. Adaptive scrolling is permitted across containers, and
scientific accuracy does not impose a registered-engine preference over faithful custom code.
Inactive capability details are fetched through `load_scientific_capability`; active details appear
once. Generation retains its complete capability contracts and its own JSON/repair instructions.
Archived corpus text and normal multi-turn history remain intact.

Constructed contract sizes, measured as JavaScript string characters (not tokens): Quiz 20,566 →
7,588; plain Interactive 39,388 → 25,821; scientific Interactive 40,232 → 26,710; Interactive with
both active geometry capabilities 50,621 → 29,308. Quiz editing no longer carries generation-only
planning fields, question grouping or mandatory-reference-answer rules that conflict with teacher
editing. Field examples, rubric reference shapes, formula encoding and open-ended questions remain.

Choice authoring recommends 3–5 options and ordered letter keys in the prompt. Server generation
validation accepts other counts and noncontiguous/custom keys, preserving exact answer references;
it rejects missing/duplicate/blank keys, empty labels and dangling/duplicate answer references.
The durable QuizQuestion structure still requires at least two options and canonicalizes keys with
their answers. Relaxation applies to all prompt versions as a runtime compatibility fix; it does
not alter the archived prompt text or remove security/runtime validation.

After cleanup, the same Sonnet quiz-conversion fixture passed with five responses, zero tool errors,
64.3 seconds and 37,155 total tokens; a smaller contract does not guarantee fewer cumulative tokens
when the model chooses a different trajectory. Interactive insertion remains unverified with the
live model: two attempts successfully read the editing contract and HTML, then their next HTTP 200
response streams terminated after about 124 seconds, before any HTML write. Increasing the sample
timeout from 150 to 240 seconds did not change that failure. This identifies a stream failure on the
direct LiteLLM evaluation path, not a quiz validation rejection or a completed production editing
flow. Local prompt, tool, parser, replay and compatibility tests pass.

The 2026-10-15 stream follow-up distinguished three boundaries. Production's 18:52 Sonnet turn
(`根据第一页和第二页幻灯片生成一个互动`) retried three times and failed with
`LITELLM_STREAM_IDLE_TIMEOUT`: the model-service 90-second data-event watchdog fired after successful
read tools, before any HTML write. A direct public probe received one role chunk, then no bytes for
119,999.6 ms before its peer closed the socket without a client abort. Bypassing the public ingress
allowed an isolated `insert_interactive_page` call to finish in 155.5 seconds; that observation did
not retain every intermediate chunk timestamp.

A subsequent per-chunk probe through the internal LiteLLM service measured role at 4,055.7 ms,
first content at 111,653.6 ms, first tool name at 112,054.7 ms, 33-character arguments at 112,057.7 ms,
and normal completion at 112,120.3 ms. The 107,597.9 ms role-to-content interval contained no bytes.
Both actual model calls succeeded, with zero tool errors; the diagnostic deliberately stopped
before a third model request, so this is not an end-to-end Interactive pass. This long wait occurred
before HTML generation, not while transferring a large HTML tool argument.

The selected deployment uses LiteLLM's OpenAI adapter with raw model `claude-sonnet-5-5`. Inspection
of the installed adapter found upstream chunks relayed incrementally and tool arguments copied from
each delta, rather than held until complete. The request sent `stream=true`, `max_tokens=16384`, and
usage streaming, with no explicit thinking/reasoning control. Pi's `model.reasoning=false` suppresses
reasoning parameters; it does not explicitly disable upstream thinking. Existing test/production
ConfigMaps did not have the provider timing callback mounted, so these observations cannot separate
RouterLink queueing, hidden thinking, upstream buffering, or unmeasured proxy scheduling delays.

The model-service fix uses a 210-second first-output budget from admitted dispatch (including
headers and role-only events), then the existing 90-second data-event idle watchdog. It records
first tool/progress times without payloads; see [model-service](model-service.md). Deployment is
required for production behavior to change. No production configuration was changed by these probes.

The later 2026-10-15 local reproduction used the failed 18:52 Run's frozen teacher message,
v7 contract, context references and empty selected history. The current materialized document had
changed since enqueue (scope matched, baseline digest/hash did not), so this was a reproduction
against the current draft, not a byte-for-byte replay of the original incident. All mutations
remained in memory; production access was read-only.

After reading the two slides and the Interactive contract, Sonnet through internal LiteLLM
received role at 4.468 seconds, first text at 116.191 seconds, and completed
`read_interactive_html` at 116.567 seconds. The role-to-text interval contained **111.723 seconds
with no bytes**. Its tool arguments were only 55 characters (a `pageId` object), not generated HTML.
This reproduces the production 90-second idle failure before meaningful output. The earlier
33-character argument observation was also an `insert_interactive_page` argument length; its
original text was never recorded and cannot be recovered from the metadata-only audit trail.
A new synthetic insert probe captured a 198-character title/position/narration argument after
75.696 seconds with no bytes; an earlier post-contract call instead requested
`read_interactive_html` and finished in about 5 seconds.
The following current-draft HTML-writing request received only a 193-byte role event at 21:34:12
Beijing time. At 21:38:18 it still had no further bytes (at least 246.480 seconds of silence),
and the local diagnostic process was deliberately terminated. This is an observed lower bound,
not a completed response or a provider-reported timeout. The 210-second first-output policy
would bound that wait; it cannot guarantee that the provider eventually produces a usable answer.
The slow read and subsequent silent write used response IDs
`chatcmpl-t5u7pthyq7imez2t5wanx` and `chatcmpl-s0h7f921innuy1bf5l13rm`, respectively.
These are upstream SSE completion IDs, not HTTP `x-request-id` or LiteLLM call IDs.
The requests began at 21:32:11 and 21:34:07 Beijing time on 2026-10-15, respectively,
using RouterLink raw model `claude-sonnet-5-5`. HTTP request IDs were not captured for these
two samples; provide the completion IDs together with the timestamps when asking RouterLink
to correlate its logs.

Identical messages/tools from the current-draft `read_interactive_html` request (8 messages,
32 tools, 114,196 request bytes before route rewriting) were also submitted directly to RouterLink.
Qwen3.8 Flash completed a response requesting that tool in 7.697 seconds; DeepSeek v4.1 Flash with
`reasoning_effort: "none"` completed its response in 4.461 seconds. Direct RouterLink Sonnet received role
at 5.568 seconds, then no further bytes before its connection terminated at 55.629 seconds; there
was no effective output, finish reason or `[DONE]`. This public-path observation does not identify
which network/proxy component closed the connection. These are small diagnostic samples with
provider prompt-cache effects, not model quality or production throughput certification. Qwen's
model ID was confirmed by RouterLink's model catalog; no Qwen LiteLLM deployment was configured.

Three repetitions of an earlier identical synthetic tool-history request completed in 5.691–6.547
seconds on direct RouterLink Sonnet and 6.179–6.843 seconds on Qwen. Default-thinking DeepSeek
failed all three with a streamed upstream 400 requiring historical `reasoning_content`; explicitly
setting `reasoning_effort: "none"` completed all three in 3.799–4.950 seconds. Fast error delivery is
not a successful tool call, and `model.reasoning=false` alone does not disable upstream thinking.
Those failing histories came from Sonnet and lacked `reasoning_content`; they do not establish
that fresh DeepSeek thinking/tool conversations fail. A subsequent direct RouterLink probe with
default thinking reproduced the error with the field missing, then completed in 3.302 seconds
with only `reasoning_content: ""` added. A fresh tool turn returned 81 reasoning characters in
2.083 seconds, and replaying that actual reasoning with its tool call/result completed in
2.142 seconds. These are small synthetic compatibility probes, not Decksmith latency benchmarks.

Model-service now fills missing/null assistant `reasoning_content` only for each actual DeepSeek
chat candidate, preserving supplied reasoning verbatim and isolating fallback payloads. It does
not disable thinking. Pi already parses and replays real reasoning; a real-Pi agent-loop regression
covers reasoning, tool call/result identity and exclusion from user-facing events. This local
compatibility change requires deployment; see [model-service](model-service.md).

A separate HTML-writing call through internal LiteLLM completed normally in 134.632 seconds
(first tool at 32.233 seconds, 10,805 completion tokens). Direct RouterLink Sonnet on the same
context delivered a complete JSON argument but the connection terminated at 143.124 seconds
without finish reason or `[DONE]`; observed usage still reported one completion token, with no
final completion-token total available. DeepSeek with thinking disabled completed an HTML-writing response in 23.887 seconds
(5,354 completion tokens). Different output lengths and tool choices prevent using these totals
as a fixed model speed ratio. These probes establish both delayed progress and stream termination;
they do not identify whether RouterLink queueing, hidden reasoning, a provider channel or another
upstream proxy caused the delay. A forced-tool diagnostic is separate: RouterLink Sonnet rejected
forced `tool_choice`, and thinking-enabled Qwen rejected it; production requests use automatic
tool choice, so these diagnostic errors are not the incident's cause.

## Luna latency follow-up (2026-10-15)

Further synthetic Decksmith v8 probes on 2026-10-15 used the same current tool surface (32 tools),
an initial 2-message request of about 47 KB, and a 5-message request of about 76 KB after reading
the Interactive contract and HTML. They requested an Ohm's-law slider edit on the checked-in
energy-lesson fixture; no production document was changed. These measurements cover one model
response, not successful validation/application of the complete edit.

| Luna `gpt-5.6-luna` route                                             | Initial read/tool response completion | HTML-writing response: first tool / completion   |
| --------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Direct RouterLink                                                     | 16.849 and 32.851 seconds             | 19.376 / 118.823 seconds                         |
| Test LiteLLM, fixed deployment `ce6551db-ed4e-43a3-aeb9-ec7e683fa695` | 4.992, 14.294 and 27.836 seconds      | 5.787 / 19.174 seconds; 17.219 / 115.429 seconds |

All listed Luna responses had normal tool finish reasons, parseable JSON arguments and `[DONE]`.
One direct connection failed before HTTP response headers; it is excluded from successful latency
ranges. A 106 ms LiteLLM response reused the prior completion ID and was excluded as a whole-response
cache hit. The later LiteLLM samples explicitly set request cache `no-cache` and `no-store`,
disable retries/fallbacks, and pin the deployment ID; their completion IDs were distinct. These are
small diagnostic samples with different generated output lengths, not a throughput benchmark.

The direct Luna slow read at 22:16:47 Beijing time had HTTP `x-request-id`
`5a2cfaa8-592c-9935-93c6-33f6ab497ef5`; the 118.823-second write at 22:17:37 had
`abe2e80e-73d8-91fe-b06f-fc091ac07f0e`. A same-context direct Sonnet write at 22:17:01
returned a role/usage event at 6.707 seconds, then terminated at 56.708 seconds without useful
output or `[DONE]`: HTTP `x-request-id` `af14245b-a39c-99a9-ae2c-a5238a42793e`, SSE response ID
`chatcmpl-4rvzvst0wy26jhtntqy6i`. These newer probes captured HTTP request IDs, unlike the earlier
two incident-shaped Sonnet samples. The 10-second UI notice helps the teacher choose to wait or
cancel and retry; provider latency and stream termination remain separate upstream issues.

## Interactive direct-generation boundary

Interactive pages remain model-authored, self-contained HTML/CSS/JavaScript documents rendered by
the existing sandbox and `reach-interactive-bridge/v1`. Reusable scientific mechanisms use the
typed `reach-science-kit/v1` marker catalog. Registered kits and custom HTML/SVG/Canvas are both
available within their declared limits; choose a faithful implementation for the learner action.
Tailwind is optional for first generation and explicit single-page
regeneration. A page opts in only with exactly one
`data-reach-tailwind-runtime="4.3.0"` marker on its sole authored `<html>` root and exactly one
`{"id":"tailwind-browser","version":"4.3.0"}` runtime dependency with no extra fields. The pair
must be present together; a class name never implies the capability. Existing valid v2 pages without
the pair remain valid. The prompt directs Tailwind pages toward subject-appropriate visual hierarchy,
responsive rearrangement and shrinkability, visible control states, and bounded learner-state motion
with an equivalent reduced-motion presentation. Stable initial geometry must work before Tailwind
compilation completes, and explicit author CSS must not compete with utilities for the same property
because Tailwind preflight and cascade layers remain active.

New generated candidates pass the existing structured-output and HTML checks, the shared server-only
Tailwind authoring audit, and a server-only Acorn syntax parse of every inline JavaScript program.
The Tailwind audit rejects unsupported global configuration, plugins, stylesheet directives, and
URL-bearing utilities across scripts, inline event handlers, class values, and style content. These
authoring checks never execute model code and are not imported by the durable document reader,
editor, or Player bundle.

Invalid Tailwind marker/dependency metadata enters the same existing structured-output correction
channel as diagnosed JavaScript syntax and function-plot JSON faults, for at most one combined,
diagnostics-driven turn. The correction must return the complete scene. If the first candidate
requested Tailwind through either declaration, removing both is not a valid repair: the corrected
result must restore the exact pair. Only diagnosed Tailwind metadata and separately diagnosed invalid
script or function-plot content may change; page identity, title, narration, runtime policy, event
manifest, non-Tailwind dependencies, visible DOM, classes, CSS, and initially valid scripts remain
protected. A validation-only source projection establishes those invariants but is never adopted or
persisted. Both provider calls retain the existing usage accounting. If the corrected candidate still
fails safety, syntax, scene, pairing, or invariant validation, the provider-content failure is
explicit and terminal and does not trigger a BullMQ replay. A teacher may still explicitly start a
new single-page regeneration, which creates the next generation attempt.

A deterministic browser acceptance fixture passes through the real generation parser and shared
Player `srcdoc` builder, then renders with the checked-in Teacher and Student Tailwind assets at
desktop and narrow widths. It covers actual utility styles, responsive reflow, learner state and
bridge events, motion and reduced-motion behavior, stable geometry, bounded resize handling, and the
opaque-origin no-external-network boundary. This evidence does not invoke a live model, score
arbitrary model visual quality, save or publish a Deck, or write learner/business data. Production
generation still has no screenshot or visual-scoring gate.

The paged outline carries a small `interactionBrief` only for interactive pages. It states the
learner's primary action, the experience or discovery that action should create, and optional
free-form `approachHints`. Those hints may combine familiar directions such as parameter
experimentation, construction, spatial exploration, or strategy challenge, but they are not a
closed runtime enum. Recognized hints add composable prompt guidance; unrecognized hints remain
valid creative context rather than causing rejection or fallback.

Teacher-enabled scene types are preserved when an adopted lesson plan immediately starts outline
generation. The outline selects each page type by its required learning action and evidence: it
silently checks for learner-controlled state, relationships, invariants, consequences, or iterative
actions that make an interactive page materially stronger than passive explanation or another quiz.
This is an affordance decision rather than an interactive-page quota or a subject-specific template.

The interactive prompt owns outcome constraints instead of prescribing a DOM template. Free,
repeatable, non-monotonic exploration is the default: one directly manipulable surface shows local
consequences immediately and lets the learner reverse or reset state. A page may offer one or two
optional playful cues, presets, or discovery challenges, but ordered steps, verification, submission,
progress, and completion appear only when the supplied objective explicitly teaches a procedure or
requests a submitted assessment artifact. Ordinary state changes are evidence without becoming a
task runner or correctness gate.

The generated document uses a marginless body and one definite-height, viewport-filling Flexbox or
Grid root rather than a fixed-pixel stage. It is an activity surface rather than a landing page or
mini lesson, so it does not repeat the page title as a large heading or spend height on introductory
prose. Fluid tracks, shrinkable children, bounded spacing, and explicit narrow and short viewport
media queries keep the dominant surface and essential controls usable across ordinary PC and tablet
layouts without activating vertical fallback scrolling. The page progressively discloses secondary
information when space is constrained, keeps `html` as the only last-resort scroll layer for extreme
viewports or accessibility expansion, sizes canvas/SVG/plot content from its container, and
remeasures that surface only on initialization, a real bridge resize, or an actual observed change
to the relevant container's dimensions. Container observation is bounded and coalesced, redraws only
when measured geometry changes, and never becomes an autonomous measurement loop. Mouse, touch, and
keyboard paths remain equivalent.

Generated interactive scenes use an untimed, resettable runtime policy:
`maximumDurationSeconds: null` and `allowReset: true`. The DSL continues to read explicit 1–3600
second limits for authored or existing content. In the teacher editor, interactive pages replace the
slide text/object formatting strip with compact completion, time-limit, and reset controls in the
same toolbar position; clearing the time-limit field restores the untimed policy.

Canonical `reach-interactive-blank/v1` and the two bounded legacy editor-language variants are
classified by exact structure. They remain valid through materialization and publication, but the
Player does not mount an iframe for them. Teacher renders a localized authoring action and Student a
neutral localized intentional-empty state. A model-authored ready payload cannot classify arbitrary
nonblank content as empty.

Nonblank scenes may declare only requested, version-pinned, checked-in runtimes:
`tailwind-browser@4.3.0`, `animate-css@4.1.1`, `expression@3.0.3`,
`function-plot@1.25.4`, and the v1 science facades `geometry-mathigon`, `mechanics-matter`,
`molecule-smiles`, `network-cytoscape`, `geo-d3`, `solid-three`, `molecule-3dmol`,
`sequence-nightingale`, and `geometry-jsxgraph`. The science facades respectively wrap Mathigon
Euclid/Fermat, Matter.js, SmilesDrawer, Cytoscape.js, d3-geo/TopoJSON/world-atlas, Three.js,
3Dmol.js, Nightingale Sequence, and JSXGraph. The manifest records exact source bytes, package
versions, SHA-256/SRI values, license, and content-addressed public paths.

Science kit HTML contains only one target and one non-executable JSON marker per instance. The DSL
validates and canonicalizes the envelope before the Player deep-freezes the spec and passes it to a
restricted facade. Third-party globals, callbacks, arbitrary expressions, URLs, selectors, shaders,
loaders, and plugins are not part of the authoring contract. 3Dmol accepts only bounded inline
PDB/SDF/MOL2 data in this slice; JSXGraph does not expose JessieCode or file/network loaders. A page
may contain at most four kit instances and at most one heavy geo/3D/sequence kit. Kit markers require
explicit dependency declarations; they never receive the legacy function-plot implicit-load path.

The facade bundles are emitted to Student and Teacher as hash-named immutable resources with SRI,
anonymous CORS, and an exact CSP URL allowlist. Each external runtime is limited to 2 MiB and one
page may request at most 5 MiB of external runtime bytes. These resources are browser-cacheable and
are not copied into Mongo or repeated inside each iframe `srcdoc`.

KaTeX is excluded because its offline font assets make supported combinations unsafe under the
assembled size limit; Mermaid is excluded because its minified JavaScript alone exceeds that limit.
New generated or edited scenes must declare exact dependencies and usage; legacy v2 scenes with no
declaration retain only the existing declarative function-plot compatibility path. Unknown IDs,
versions, unused/missing dependencies, or malformed function-plot markers fail before adoption and
again at Java publication.

Generation requests include a server-built `scientificToolRegistry` rather than a static prose list.
Each visible entry names the real engine and version, typed contract, supported representations,
limits, allowed page contexts, license, and pinned runtime dependency when applicable. Specialized
entries cover function plots and all nine science kits; the registry also exposes the bounded
`reach-interactive-bridge/v1` custom HTML/SVG/Canvas capability only to Interactive generation. The
model should prefer a specialized entry when it faithfully supports the teaching mechanism, but may
choose that custom capability when no listed engine supports a required semantic operation. Model
choice never extends the Player's dependency, hash, CSP, or scene validation registries.

Stored HTML remains limited to 512 KiB and the final HTML plus inline legacy runtimes, bridge, CSP,
and shims must remain at most 1 MiB. The separate cacheable facade budget is 5 MiB per page. The
512 KiB boundary protects the single Mongo deck-version document and limits model-authored markup;
raising it to 5 MiB would multiply storage, transfer, parsing, and version-copy cost without helping
the reusable runtime case. TypeScript and Java audits reject external/document-relative
resources, CSS imports, network/import APIs, workers, nested browsing/plugin documents, external
form actions, and host-policy overrides. Runtime execution retains the opaque-origin `sandbox="allow-scripts"`,
`connect-src 'none'`, `worker-src 'none'`, `frame-src 'none'`, and `object-src 'none'`; no CDN or
external script/network access is enabled.

MapLibre, RDKit, JBrowse, Cesium, and Mol* are candidates for later dedicated runtimes, not forbidden
libraries. MapLibre needs a vector-tile/style/glyph/sprite pipeline and workers; RDKit is a WASM
cheminformatics computation engine rather than primarily a viewer; JBrowse needs indexed genomic
range data and a substantial browser UI; Cesium needs workers plus terrain/imagery/3D Tiles assets;
Mol* carries a larger macromolecular and cryo-EM state/data/worker stack than the first-stage 3Dmol
facade. Their blocker is the missing resource, worker, data-provenance, and CSP contracts rather than
bundle size alone. They can be introduced as separately budgeted experimental runtimes once those
contracts exist.

The Player expects a nonblank bridge to finish initialization within ten seconds. A scene that never
reaches the active phase shows a localized visible failure state and offers an iframe reload with a
fresh bridge nonce instead of leaving an unexplained blank activity.

## Candidate Dynamic Geometry

Issue #421 adds the `@reachany/reach-deck-dsl/euclidean-geometry` contract and
`@reachany/reach-deck-geometry` trusted JSXGraph 1.13.2 evaluator. P2 registers exact
`geometry-euclidean-2d` / `geometry-euclidean-3d` 1.0.0 Player reader pins. P3 adds a separately
scientific context in normal Deck generation and editing, without an environment switch.
The outline sees compact capability descriptions and selects `euclidean-geometry-2d` or
`euclidean-geometry-3d` through the existing optional `interactionBrief.approachHints`.
Interactive generation loads geometry grammar, guidance and examples for the selected capability;
ordinary Interactive pages omit the detailed geometry context. Immutable snapshots
derive from one native geometry graph; only declared input parameters and freedoms can change it.
Server evaluation uses NoRenderer, planar Player presentation uses SVG on that same board, and
Three.js 0.185.1 renders immutable spatial DTOs without owning construction geometry.

The exploration/authoring iteration keeps those v1 contracts and reader pins byte-for-byte
compatible, but normal new Euclidean generation now emits `kitVersion: 2` with
`reach-euclidean-geometry/v2` and the exact `geometry-euclidean-2d-v2` or
`geometry-euclidean-3d-v2` 1.0.0 runtime. Stored v1 markers remain readable on their original
runtime and are read-only for the new structured editing path. Neither generation nor Decksmith
implicitly upgrades them; a teacher must explicitly request and approve conversion before v2
exploration or direct authoring becomes available.

V2 separates the published base graph, learner auxiliary graph and observation state. The published
`interaction.exploration` policy allowlists construction, measurement and relation kinds, base
objects that learner objects may reference, feedback mode and per-instance budgets. Learner IDs use
the reserved `L_` namespace and may reference only allowlisted base objects or earlier learner
objects. Candidate graphs are adopted atomically after complete policy, type, dependency, cycle,
math and byte validation. The first-release caps are 32 auxiliary objects, eight auxiliary
measurements, eight auxiliary relations, 50 in-memory history steps and 64 KiB for the complete page
bridge snapshot. Undo/redo history is session-only; persisted state contains definitions, inputs,
hidden state, selection, groups and camera, never computed coordinates, readings, results or history.

Computed v2 output is one immutable `reach-geometry-computed/v2` projection keyed by stable IDs.
Measurements, `lineLine` classifications (`intersecting`, `parallel`, `coincident`, `skew`) and
`linePlane` classifications (`intersecting`, `parallel`, `contained`) come from the trusted geometry
session rather than screen projection. Invalid or degenerate readings carry an undefined reason and
never reuse stale values. These numerical relations support exploration and feedback; they are not
treated as symbolic proof.

The new instances expose versioned commands and computed snapshots through the frozen
`ReachScienceKits` facade. State stores only editable inputs, selection, visible groups and camera,
bound to the instance and a SHA-256 fingerprint of the normalized envelope. Commands and restores
validate atomically; restores do not emit learner actions or completion. Student and Teacher supply
their existing locale/catalog translations; language changes flush buffered state before remount.
New bundles introduce no engine globals and preserve iframe network/worker restrictions. Legacy
bundle hashes stay fixed, including the existing legacy JSXGraph global on mixed pages.

The shared server context has a 12 KiB UTF-8 total budget and 8 KiB reference/example budget.
For an activated geometry capability, all minimal operation signatures remain mandatory; zero to
two examples are selected deterministically and removed whole when capacity requires it.
Staged jobs use a single v5 format and Decksmith frozen input uses v2, extended with optional
`scientificContextSnapshot`. Present snapshots persist exact injection bytes before hashing and
dispatch and reuse them on retry; absence is a normal input without a saved scientific context.
There is no P3-specific old-job execution path. Superseded experimental jobs can be regenerated.
Decksmith can activate geometry from the current page or editing request, or call
`load_scientific_capability` to obtain guidance and enable the exact runtime before writing or
converting an Interactive page. Loading a capability does not modify the Deck.
Fresh AI generation must declare valid `reach-geometry-authoring/v1` bindings for the intended
teacher-editable/deletable stable IDs and protected `externalReferences`. Stored v2 markers may omit
the bindings and remain readable but read-only; neither generation nor Decksmith synthesizes
bindings or implicitly upgrades stored content. Decksmith uses
`inspect_interactive_geometry` to read the current typed envelope, runtime, editability and complete
HTML SHA-256, then `propose_interactive_geometry_edit` to submit one strict v2 envelope against that
digest. The proposal cannot widen existing bindings, delete an external reference, rewrite an
unbound definition/presentation, or change v1. Correctly bound teacher-owned additions are allowed.
The proposal changes only the server-held working copy and still requires
`check_and_commit_interactive_page`; page source revision, Decksmith transition approval and the
existing durable-save-before-applied acknowledgement remain in force, so manual and model edits do
not silently overwrite a newer draft.

An authored initial state uses a separate
`script[data-reach-geometry-snapshot="instance-id"]` that must immediately follow the corresponding
v2 geometry marker with no intervening whitespace, comment or element. It is not a science-kit marker and is not part of
science marker counting or runtime inference. It stores only bound initial inputs and camera plus the
v2 envelope fingerprint. Structured Decksmith edits preserve this marker and update its fingerprint
only when the saved values remain valid against the proposed envelope; an edit that would discard or
invalidate the teacher's saved initial state is rejected atomically. Student attempt snapshots are
separate runtime data and are never copied into this authored marker.
The existing private capacity endpoint now permits the registered Decksmith, paged-outline and
Interactive slots, resolving each slot's own profiles. Geometry validation uses the trusted
solver and the existing single correction; only diagnosed marker JSON may change during a
geometry repair. P3 implementation status and pending evaluation gates are tracked in the
[P3 plan](../../plans/2026-09-07-reach-deck-dynamic-geometry-p3.md) and
[P3 results](../../plans/2026-09-07-reach-deck-dynamic-geometry-p3-results.md).

P3's frozen real-model results and verification boundaries are recorded in the linked P3 results
document. Ignored local evaluation output is not treated as durable evidence.
The saved generated-output browser run has 120 four-viewport entries (52 passed, 36
review-required, 32 failed); a fresh saved-only targeted run of the three core planar candidate
artifacts passed all 12 entries with no page errors. The failed full-run entries are attributed to
author-script restore/value normalization defects and one browser-context shutdown, while two
additional degeneracy probes are unreachable under the generated freedom bounds. Player/bridge
persistence is therefore not being patched for these arbitrary author schemas. No digest-bound
independent semantic, copying and layout review is recorded, so the historical P3 evaluation
remains unaccepted. This evidence status does not select a product generation path. Offline
baseline/candidate policies are explicit evaluation controls only; normal generation has no flag.

`POST /api/integrations/reach-deck/geometry/validate` accepts only verified content-service service
tokens. It binds exact UTF-8 request bytes, schema/evaluator versions and ordered instance IDs,
uses fresh isolated Workers with two slots per process, and enforces 500 ms compute / 750 ms overall
deadlines. No model, billing, run creation, database work or content-service callback occurs there.
Its Worker asset is server-only and does not change the browser iframe's worker/network restrictions.

Java's normal read and publication validation share the geometry-aware schema, references, exact
runtime pins and all-kit marker budgets. Nontransactional publication preflight checks every
geometry page, with a maximum of 64 geometry pages and a 20-second deadline covering structural
scanning and trusted RPCs. Four execution slots have no waiting queue; unavailable, saturated or
timed-out evaluation fails closed. Mathematical failures identify the document page and instance;
Teacher displays localized Chinese/English errors.

The materialized document is copied recursively into an immutable snapshot. Publication recomputes
its full digest before preflight and checks it again against the locked, refreshed PostgreSQL draft
inside the publication transaction. Concurrent materialization conflicts without publication writes.
Pending workspace edits become a new publishable snapshot only after materialization. Geometry-free
documents remain RPC-free. Lesson-prep staging/recovery also remains RPC-free and explicitly rejects
v1/v2 geometry documents because that independent native-slide producer does not run trusted
geometry preflight before immutable writes. The former P1 reader-unavailable rejection has been
removed. Implementation and actual role-flow acceptance are tracked separately in the
[P4 plan](../../plans/2026-09-08-reach-deck-dynamic-geometry-p4.md).

For v2 rollout, deploy the new DSL/Player readers and runtime assets plus the trusted AI Runtime and
content-service validators before enabling v2 generation or structured editing. Publication first
parses and structurally validates markers and their separately associated authored snapshots, then
runs the matching v1/v2 trusted evaluator outside the publication transaction, and only afterward
locks and writes the immutable document version if its digest still matches. Stopping new generation
is a valid rollback action; already published v2 content still requires its reader and runtime and
must never fall back to v1.

See the [P1 results](../../plans/2026-09-06-reach-deck-dynamic-geometry-p1-results.md) and
[P2 results](../../plans/2026-09-07-reach-deck-dynamic-geometry-p2-results.md) for verification boundaries,
48 browser checks and the recorded limits before P4.
The production Player Harness accepts `--fixture geometry --timing document --smoke` for local
browser acceptance, or `--serve` for an interactive preview. These fixtures do not claim model
generation, physical Android, or the Teacher/Student publication end-to-end flow.

## Scientific visual boundary

Native slide pages may contain one top-level `scientificVisual`. It is a presentation-owned,
pointer-passive generated HTML/CSS/JavaScript component, not a learner interactive scene and not a
closed subject JSON schema. Native primitives remain the preferred representation for layout,
decoration, annotations, highlighting, and simple connectors. The scientific component is reserved
for mechanisms or continuous visual state that would otherwise be approximated with many unrelated
primitives.

The durable `reach-scientific-visual-manifest/v2` records Hook v1, named narration anchors, approved
repository dependencies, managed resource ids, and accessible text. There is no poster field and no
legacy manifest reader because this rollout has no existing v2 data to preserve.
Generated HTML is bounded to 256 KiB and passes a generation-only HTML/Acorn gate: exactly one Hook
registration is required, undeclared dependencies/resources and arbitrary URLs are rejected, and
network, storage, timers, random/time sources, dynamic code execution, navigation, and parent-frame
access are unavailable. One correction may repair invalid script content, but it cannot change page
identity, the manifest, or the non-script DOM.

Player uses a separate `reach-scientific-visual-bridge/v1` in an opaque `sandbox="allow-scripts"`
iframe. The parent supplies absolute playhead frames rather than relying on an autonomous animation
loop: time, play/pause/rate, effective duration, narration segment, reduced-motion/static state, and
before/active/after progress for every named anchor. Real TTS alignment supplies each anchor's exact
spoken trigger; the host projects its visual progress over a separate deterministic 2.5-second
presentation window, capped by the next trigger and page duration, instead of compressing a complete
mechanism transition into the triggering word span. Partial or stale narration bindings fall back as
one deterministic schedule. Visibility changes drive suspend/resume; unmount disposes the component.
The iframe remains pointer-passive and cannot emit learner completion or answer events.

Player smoke tests sample inside a visible anchor presentation window when real narration bindings
exist. Sampling fixed fractions of a long page can select two already-completed states and falsely
report a frozen visual. The harness checks paused-state stability, deterministic backward seeking,
resumed playback and the real audio seek position without rewriting document timing; unbound preview
fixtures retain their duration-based anchor schedule. These checks do not replace human inspection of
the generated teaching content or layout.

External networking is default-deny (`connect-src 'none'`). Approved code is served from the role
application's `/reach-deck-dependencies/` path with a pinned version, SHA-256 SRI, CORS, and immutable
cache headers. The first registry entry is function-plot 1.25.4. Managed per-document resources cross
an origin-isolating `MessagePort`: the host resolves only ids already present in its authorized media
URL map, reads each response through a 2 MiB cap, and the iframe receives blob URLs. Total resolved
bytes are capped at 8 MiB with at most four concurrent requests.

Initialization has a ten-second watchdog and one fresh-nonce retry. The real iframe presents `t=0`
for reduced motion, static editor/thumbnail, screenshot, and print. Initialization/runtime errors
remain an explicit accessible failed state; no PNG fallback is shown. Current PDF/PPTX and animated
export are deferred. Producer flag
`REACH_DECK_SCIENTIFIC_VISUALS=1` remains default-off until readers and generation are rolled out;
disabling it stops new planning/generation; legacy scientific manifests are intentionally unsupported.
Only while that flag is enabled does the model-visible registry expose the pointer-passive
`reach-scientific-visual-hooks/v1` custom HTML/SVG/Canvas capability for ScientificVisual generation;
it is not a slide-element fallback or an Interactive substitute.
Scientific correctness is not inferred from HTML validity. The first slice uses reviewed moving-body
and function-plot browser fixtures, deterministic state checks, desktop/mobile screenshots, and human
visual/content acceptance; optional domain validators can be layered on later without replacing the
HTML/Hook contract.

## DeckSmith v2 editing boundary

DeckSmith accepts only `reach-deck-document/v2` together with the semantic capability
`reach-deck-decksmith/v2`. Its job, result, client recovery session, and deterministic job identities
are versioned accordingly; missing, stale, v1, or internally inconsistent inputs fail before model or
tool mutation. There is no v1/free-form compatibility adapter or historical bulk migration.

For slide pages, `nativeSlides` is the player-visible authority. DeckSmith exposes page-scoped typed
operations for title projection, native text/shape/layout, managed image binding, and authoritative
narration/TTS. Rich text uses the shared restricted-Markdown parser, generated media is registered as
stable document resources by server-derived identity, and narration edits invalidate stale derived
audio/timing before a synthesized result is bound. A TTS cache hit reuses matching authoritative
timing already present on the slide instead of replacing it with a placeholder. The page title tool
owns metadata/accessibility projection; a visible canvas title is edited through the native text
tool. Native transforms must fit inside the document stage, and the model receives the stage and
document language explicitly. Every transition re-parses the document, checks
native feature capabilities and cross-resource references, and advances a changed page revision once
for the completed session.

Quiz pages use a scene-specific replacement tool backed by the strict parser.
Scene-typed insertion tools create slide/quiz/interactive pages with server-derived page
and native identities. Quiz insertion carries the normal Quiz generation prompt and normalizes its
restricted-Markdown model fields into durable rich text before validation, so tool-generated Quiz
JSON follows the same contract as the generation pipeline. DeckSmith has no whole-page `write_page`,
generic `insert_page`, or legacy scene-mutation escape hatch.

Interactive authoring uses a small coding-agent harness rather than create/modify/convert regex
classification or a one-shot child generation call. Its working-file tools are always available, so
the model can edit an Interactive page discovered through an exact page reference even when the
teacher does not repeat the word Interactive. The larger authoring context is enabled only when the
current page is Interactive or the teacher request names an Interactive/互动 page; it includes the
normal Interactive contract and the current complete HTML baseline. `read_interactive_html` exposes
the exact working file, `edit_interactive_html` applies unique non-overlapping text replacements
against the server-held complete document, and `write_interactive_html` supports new pages,
conversions, and deliberate complete rewrites. Completed large writes and patch arguments are
replaced by byte-count/SHA-256 receipts in later model turns, with an explicit instruction to reread
before another patch; small exact edits remain visible. The newest complete read remains visible,
while an older read and the duplicated initial baseline are compacted only after a newer read
supersedes them.

Every Interactive edit or rewrite immediately runs the HTML audit, inline JavaScript syntax parser,
component/function-plot/science-kit marker validation, and runtime dependency consistency checks.
Runtime pins are derived from the final HTML. In particular, Decksmith infers
`tailwind-browser@4.3.0` only from the exact marker on the sole authored `<html>` root, never from
utility-looking class names; a deliberate rewrite that removes the marker also removes the inferred
dependency. Invalid or mismatched markers remain isolated from the Deck and produce bounded
diagnostics from write/edit/check so the existing coding-agent tool loop can patch them. Decksmith
does not silently normalize them or invoke the standalone generation correction turn.
`check_and_commit_interactive_page` repeats the complete scene and shared Tailwind authoring checks
and writes atomically only when the source page revision is still current. A revision conflict
discards the stale working copy so a fresh read can reopen it. Insertion receives a reserved server
page identity and consumes it only after successful insertion; slide-to-Interactive conversion
preserves `pageId` and order, advances the revision, removes the obsolete native binding, and is
blocked while authoritative narration/audio/animation generation is active.

DeckSmith may inspect and transform a scientific visual frame, but generic animation mutation and
direct narration/anchor editing are rejected. Replacing scientific HTML or its manifest uses whole
page regeneration so content, anchors, poster, and narration timing land atomically.
The in-memory result is returned for the teacher's existing review/adopt flow; it does not directly
save shared course data.

DeckSmith may refer only to the shared 15-family built-in font catalog. A request for another system
or user font is rejected before any mutation, without substitution or a success claim; a mixed
request may still execute its non-font clauses and reports the rejected font portion separately.
DeckSmith intentionally exposes no `fontFamily` mutation parameter today. This rule does not change
PPTX import: the importer continues its existing compatibility mapping from source fonts into the
self-hosted catalog so imported decks remain renderable without network font downloads.

### DeckSmith reference-image editing

`edit_native_image({pageId, elementId, instruction, alt?})` edits the picture currently bound to an
existing native image element, including one generated earlier in the same run. The model writes
only the change; it never supplies a URL, object key, or base64. The worker reads the element's
media resource from the session document, asks content-service to authorize that exact object
(`POST /api/v1/reach-deck/courses/{courseId}/nodes/{courseNodeId}/decksmith/image-references`, see
[content-service](content-service.md#decksmith-image-references)), downloads the short-lived signed
URL through `lib/reach-deck/authorized-image.ts` (HTTPS only, no redirects, 30 s timeout, 15 MiB
cap, SHA-256 and decoded format must match the authorized metadata, header-checked pixel cap), and
normalizes it with `sharp` to PNG (alpha) or JPEG with the long edge at most 2,048 px and at most
4 MiB. The same module provides the 1,024 px JPEG vision preset used for selected-picture vision
(below).

The normalized data URL goes to model-service `/v1/images/edits` with the Decksmith invocation
contract (`stage: decksmith`, `tool: edit_image`, `channel: image-edit`) and run/job/page
attribution; one transient model-service failure is retried inside the tool, and a download timeout or
network failure re-authorizes once for a fresh signed URL. The document `digest` is not sent as an
expected checksum because imported media may record the source-part digest rather than the stored
bytes; integrity comes from the authorized checksum. The result is stored as generated
media under `decksmith-image-edit-<sha256(job, page, element, instruction, source key)>`, so a
durable replay reuses it, then registered as a **new** media resource and rebound to the same
element. Transform, z-index, and fit are unchanged, alt changes only when given, and the old object
key is never overwritten. Images nested inside a group (`group.children`, at any depth) are found and
rebound in place; the group structure is kept, and a rebinding that also asks to move a grouped image
(transform or z-index) is rejected. When model-service answers with code `5602`
(`MODEL_OUTPUT_INVALID`: the provider answered and may have billed, but returned no valid image) the
tool does not retry. Response usage is emitted as an ordinary run `usage` event. The system
prompt directs content changes (object swaps, additions, removals, label wording, color or style) to
this tool, says the composition is kept but the result is not pixel-identical, and reserves
`generate_native_image` for brand-new pictures or explicit full redraws. Exact geometric changes
inside a picture (arrow direction, precise positions, counts) are not sent to image editing first:
DeckSmith explains the limitation, offers an editable native rebuild through
`draft_layout_with_html` or a teacher-supplied replacement, and edits only if the teacher still asks
to try.

### DeckSmith selected-picture vision

When the teacher selects image elements on the origin slide (native-element context refs with
`componentType: image`), the API route authorizes up to three of them with content-service before
freezing the turn (concurrently, each call bounded by a 10 s deadline; a failed or timed-out
authorization becomes an omission note and never blocks the text turn) and stores only stable identifiers in the frozen Run input field `visualInputs`
(`reach-deck-decksmith-visual-inputs/v1`: element id, media resource id, object key, the
authoritative checksum, content type, source size and the normalization version
`decksmith-vision-jpeg-1024-600k/v1`). Signed URLs, pixels and base64 are never frozen, stored in
events, history or compaction input. Extra selections and failed authorizations are recorded as
explicit omissions (`count-limit`, `no-media-resource`, `unsupported-media-type`, `not-authorized`,
`reference-unavailable`). Older Runs without the field parse unchanged and carry no pictures.

At execution the worker re-authorizes each frozen object with the frozen checksum as
`expectedChecksumSha256` (same 10 s deadline), downloads it through `authorized-image.ts`, and normalizes it to a JPEG
whose long edge is at most 1,024 px (at most 600 KiB each, 1.5 MiB per turn). The thumbnails are
attached as image blocks to the first user message, after a text line per picture with element id,
alt, transform and page revision; only then does the gateway model declare `['text','image']`
input, so text-only turns are byte-identical to before. A changed checksum, rebinding, download or
decode failure, or the byte budget turns that picture into an explicit "NOT attached (reason)" line
rather than failing the turn or dropping it silently; cancellation still aborts.

Capacity counts every attached picture as a fixed 4,096-unit placeholder: the frozen measure, the
post-compaction measure, rehydration, and the pre-dispatch check of the real pi payload all replace
each `image_url` with the same placeholder, so they agree exactly; a failed picture only shrinks the
dispatched payload. The dispatch check also blocks more than three images, a non-JPEG or oversized
data URL. model-service routes the slot `courseware.deck.decksmith.chat` with a strict native-image
declaration: every model in its chain must declare image input in the catalog, and a text-only
candidate fails closed instead of converting pictures into billed text descriptions (see
[model-bootstrap rollout](../../../infra/model-bootstrap/README.md)). Whole-page rendering
(`view_page`) is a separate later step.

### DeckSmith evaluation layers

DeckSmith is evaluated in three layers that share one set of frozen, de-identified inputs
(`services/ai-runtime/tests/reach-deck/decksmith-replay/fixtures/`):

1. **Deterministic replay** (`tests/reach-deck/decksmith-replay/`, part of the default vitest run):
   scripted model turns drive the real `agentLoop`, tools and session; no model or service calls.
2. **Live-model quality eval** (`pnpm --filter @reachany/ai-runtime eval:decksmith`, explicit and
   token-capped): the real agent calls LiteLLM directly through `createDirectLiteLlmFetch`, image
   tools are stubbed by default, and each case asserts outcomes (accepting equivalent solutions)
   over several samples. Reports with pass rate, failure categories, p50/p95 latency, tokens
   (including sub-calls) and estimated cost go to `tmp/decksmith-eval/`. `--dry-run` validates the
   fixtures without model calls.
3. **Integration verification** (`eval:decksmith:integration`): the same harness through local
   model-service (`:8100`) and content-service (`:8000`) for slot routing, usage events, image
   modality, guardrails and image-reference authorization. Model checks require
   `--allow-shared-writes` because model-service records usage events and guardrail audits.

Layer 2 bypasses model-service and cannot replace layer 3. Usage and case definitions:
[decksmith-eval README](../../../services/ai-runtime/scripts/reach-deck/decksmith-eval/README.md).

## PPTX and MAIC imports

Teacher imports use a preview-first two-step contract at
`/api/reach-deck/imports/{pptx|maic}/{preflight|apply}`. Preflight never changes the workspace. Apply
recomputes the candidate from the original upload, binds it to the returned source/profile/candidate/
media digests and idempotency identity, and protects insertion with the materialized draft revision
and content digest. Create and insert-after-selected-page are atomic; warning pages remain, while an
error page is skipped only after explicit degraded confirmation.

Both formats offer ordinary import and import with narration generation. Apply accepts optional
`completionAction: generate-narration`, bound to the import request fingerprint. Before
materialization, AI Runtime records a private recovery intent with the accepted imported page IDs,
voice selection and deterministic native narration batch identity. Apply retries and workspace
reads reconcile accepted intents, so a lost response does not require another upload. Insertion
generates only this import's native slide pages. Existing nonempty imported narration is retained
and used for audio/reveal generation; missing narration is generated. The saved narration used is
the one current when the member dispatches, not a digest frozen at import time. Quiz and Interactive pages
are reported as skipped for this action. The imported page layout and existing pages are preserved.
Progress and cancellation use the existing durable narration batch machinery; scheduling failures
return a pending generation status. Private identity and voice details are not added to learner
`importApplications`.
Recovery checks the materialized application before taking a writer lease. Registration receives
a fresh timestamp even when an import was prepared long ago; expired batches settle their private
intent. Only the ten most recent registered intents remain in the private cache, while unresolved
current-run intents stay within the existing recovery byte budget. If an applied retry's private
intent is missing, the append-only import fingerprint alone cannot prove generation acceptance or
reconstruct the original voice and batch. Such retries return an explicit recovery conflict when
native slides require generation, rather than claiming a task started or creating another paid
batch. An import containing only unsupported pages can still return its skipped result.
An intent marked registered also conflicts if neither its batch nor acceptance receipt survives;
the registered marker must not authorize a second paid registration.

PPTX insertion fits source pages uniformly into the existing stage, centered with white letterboxing
when aspect ratios differ. Existing pages and their stage remain unchanged; imported elements remain
editable. Preview and apply run the same transform before computing candidate identity, and the
mapping profile binds the fit version and target stage. Text sizes, physical spacing, group-local
coordinates, strokes, effects, tables and media bounds scale together. Source backgrounds stay inside
the fitted content rectangle. Native chart labels and tiled-image pixel sizes retain renderer-specific
behavior; these limitations appear in the page diagnostics and preserve existing warning-only gating.
New-Deck imports keep the source stage.

PPTX zero-width solid outlines import as transparent positive-width Native V2 strokes, preserving
shapes, text, pictures, table cells and connectors without introducing visible borders. A
source-element warning records the approximation because producer-specific hairline rendering is
not preserved. Omitted widths retain the OOXML default and positive widths remain visible. Blank
optional names and accessibility descriptions are omitted. Grouped custom-geometry view boxes use
the same positive minimum as element bounds; negative text insets normalize to zero, and invalid
autofit scaling metadata is ignored while text remains. These geometry and text approximations
produce source-element warnings and keep the import directly applicable.

OOXML character references in PPTX text runs are decoded to their logical characters before Reach
Deck rich text is built, while the raw XML fragment remains unchanged for stable import digests.

PPTX charts are imported as read-only Native V2 elements from the parsed chart part's `c:strCache`,
`c:numCache`, `c:strLit`, and `c:numLit`; the importer does not open embedded workbooks.
Two-dimensional bar, column, line, area, pie, and doughnut charts retain categories, series, values, titles, legends, and data
label visibility with approximate native SVG styling. Unsupported chart kinds, 3D charts,
combination charts, and charts with secondary axes remain visible as warning-only read-only
placeholders. Read-only applies to the chart's data: an imported chart selects, moves and resizes
like any other element, but there is no chart editor and no data-table editing. Warning-only chart
findings do not change PPTX apply gating.

MAIC v1 support covers canvas, quiz, and legacy interactive pages. Canvas text, images, shapes,
lines, tables, categorical line charts, and standalone audio map to native v2 elements when representable.
MAIC line charts preserve category labels, named numeric series (including null gaps), series colors,
and geometry as native chart elements. Smoothed lines use straight segments with an explicit
`maic.chart.option_unsupported` warning; other unsupported options also warn without dropping the
chart page. Invalid chart data receives an element/field-specific error, and unverified chart types
remain unsupported rather than being guessed or rasterized. Canvas `script`
maps to a text-only narration segment without audio identity, timing, word alignment, or animations.
Standalone MP3 remains a positioned non-autoplaying, non-looping control resolved from managed
media; it is not narration. Short-answer reference answers are retained. Canvas rich-text
formatting is reduced to plain text. The first occurrence of a canvas element id retains the source
identity; later duplicates receive collision-free deterministic import identities and one warning
each, while their original source snapshots, media associations, and z-order remain intact. Valid
linear and radial canvas gradients are retained. The
confirmed nested MAIC image background `{type:"image",image:{src,size:"cover"}}` maps to a managed
native `cover` image fill. Other image sizes plus unknown and malformed backgrounds fall back to
white with one explicit page warning and are not downloaded. A registered background whose media
cannot be resolved is a page error. These limitations are never silent.

Interactive import recognizes the pinned KaTeX 0.16.x and exact Tailwind Play CDN dependency,
removes runtime CDN dependencies, emits static MathML, embeds a MathML-only KaTeX runtime for
formulas created after learner interaction, and declares the platform-owned
`tailwind-browser@4.3.0` runtime when needed. Tailwind is served as a content-addressed Student and
Teacher asset with SRI and anonymous CORS; the iframe retains `sandbox="allow-scripts"`, an exact
script URL allowlist, and a no-network CSP. Because MAIC's current Play CDN resolves to Tailwind
3.4.17, each replaced page carries a non-blocking version-compatibility warning for visual review.
Tailwind config, plugins, stylesheet imports, and URL-bearing arbitrary utilities are rejected.
The importer and AI Runtime generation/Decksmith boundaries reuse the same side-effect-free
Tailwind customization and URL audit; the importer's reserved-input-marker rule remains specific to
untrusted imported source. The marker/dependency pair is the runtime capability contract, not
provenance authorization. Generation adds another producer of that existing capability without a
second runtime or loading path.
Imported legacy activities use `completionMode: none`: no persisted state, score, authoritative
progress/completion, or refresh recovery. Unknown dependencies, unsafe APIs, and scenes above 512
KiB are page errors.

MAIC `rect` image crops map directly to native image crop insets. An `ellipse` crop imports as an
ellipse shape whose image fill carries the crop as `stretch` fillRect insets, so the elliptical clip
renders faithfully through the shape outline; the element is a shape rather than an image, so
image-only controls and CSS filters do not apply and an explicit warning records that. `roundRect`
still retains only its rectangular crop range, losing rounded corners with its own warning. Malformed
ranges and clip shapes outside those three remain page errors.

MAIC tables keep positive source column widths as relative weights. Explicit positive `rowHeights`
remain authoritative. For the legacy structure that omits `rowHeights`, a positive table height and
positive `cellMinHeight` produce uniform row-height weights only when the complete row/cell-span grid
is valid and every derived row meets the declared minimum. Malformed or inconsistent grids remain
page errors.

Remote MAIC resources are accepted only from exact HTTPS hosts `file.maic.chat` and
`maic-prod.oss-cn-wulanchabu.aliyuncs.com`. AI Runtime validates every DNS result and redirect, pins
the chosen public address, and enforces declared MIME plus matching magic bytes. The binary signature
is authoritative for the stored content type and covers PNG, JPEG, GIF, WebP, TIFF, AVIF, and MP3;
TIFF and AVIF are never stored directly but are decoded and converted like any other oversized
raster. Image sources may be at most 64 MiB and audio sources at most 32 MiB. Two aggregate budgets
apply per import: raw downloads are guarded at 512 MiB, while the storage budget of 256 MiB is
measured after normalization and source-digest deduplication, because that is what actually lands in
managed storage. Supported PNG/JPEG/WebP images stay byte-identical only when they are at or below
10 MiB **and** already within the import stage resolution; byte count alone never grants passthrough,
because the resolution bound is what keeps stored objects small. GIF input and any image beyond
either bound is decoded, bounded to the import stage resolution, and stored as WebP only when the
result is at most 10 MiB. Each converted reference produces a page warning containing
the before/after MIME types and byte counts. A single media object that cannot be fetched, decoded,
or normalized degrades only the pages that reference it — it produces a page-located error naming the
specific failure code, and the remaining pages stay importable under the existing degraded-apply
confirmation. Only whole-import conditions (either aggregate budget, or content-service being
unavailable) still fail the entire preflight. Images/audio are stored through content-service with a
distinct MAIC idempotency namespace. Preflight stores the resolved media results, including individual
failures, in a bounded 30-minute Redis snapshot tied to the actor, resource scope, application,
source and mapping identity. Apply reuses that snapshot instead of downloading remote media again,
then recomputes and checks the exact candidate digests. This keeps the confirmed page set stable
when a remote resource recovers or fails between preview and apply. An expired or unavailable
snapshot requires a new preview; an already completed exact retry remains idempotent.
Final documents never retain third-party, signed, base64, or
browser-supplied media URLs. The MAIC importer version is `0.3.5`; preflights created by an older
importer must be rerun before apply. The Java
publication validator shares the exact Tailwind marker/dependency contract for imported, generated,
and Decksmith-authored scenes. Player asset injection, content addressing, SRI, sandbox, CSP, byte
budgets, and publication validation are unchanged by generation support. No database-schema change
is part of import or generated Tailwind authoring.

MAIC tables preserve theme header/footer colors, alternating row colors over the
source table's white backdrop, explicit cell backgrounds, and the shared outline.
Cell text retains size, color, bold/italic/underline/strike, horizontal/vertical
alignment, and font-family substitution through the existing font catalog. Cell
defaults remain subordinate to inline rich-text formatting. Merged cells retain
their physical grid positions when theme column rules are applied. Existing
imported documents are unchanged; restoring previously discarded table styles
requires re-importing the source JSON.

MAIC preflight measures table text with bundled fonts and automatically increases
rows that need more space, preserving the declared font sizes, column widths and
table position. Original rendered row heights are minima; merged cells contribute
height constraints across their spanned rows. Both the row grid and outer table
height grow together. New page-boundary or content collisions produce diagnostics.
Missing font measurements fail the affected page explicitly; unavailable bundled
font files fail preflight. Preflight and apply use the same layout before hashing
the candidate. This is font-based layout estimation; browser wrapping can differ
for unusual typography. The three MAIC font sources are included in AI Runtime's
standalone route tracing.
The loader uses `AI_RUNTIME_OFFICE_FONT_DIR` when configured (the shared runtime
base image supplies this directory); local runs resolve the checked-in font sources
from the repository or service working directory. An invalid configured directory
fails explicitly. The AI Runtime build also runs a table preflight against the
actual Next.js standalone bundle to catch asset-resolution regressions.
The API image builder copies the font directory from the same versioned shared
base image used at runtime, so this check works even though the application build
context excludes source fonts.

## Interactive HTML upload

Teachers may replace the activity on one existing Interactive page with a single self-contained
HTML file at `/api/reach-deck/imports/interactive-html/{preflight|apply}`, behind the same Teacher
BFF as PPTX and MAIC. This is a page-scoped replacement, not a deck import: there is no create,
insert-after, or before-first mode, no page report list, and no degraded confirmation. A blank
Interactive page offers the upload beside the existing Decksmith action; a nonblank one offers it
from the Interactive properties toolbar, so first upload and re-upload use one path.

Preflight never mutates the workspace. It reuses the MAIC importer's HTML transform through the
shared `transformInteractiveHtml` entry point with the `html` diagnostic namespace, then runs the
existing DSL scene parse, `auditInteractiveDocumentHtml`, the Acorn inline-script syntax check, and
the esbuild static compile check. The candidate inherits the target page's `pageId`, `order`, title,
and any existing narration; only `documentHtml`, `runtimeDependencies`, and the revision change. The
uploaded scene always carries `completionMode: none`, `allowReset: true`, an untimed policy, and an
empty event manifest, matching imported MAIC activities: no persisted state, score, authoritative
progress, or refresh recovery.

Apply runs under an ordinary writer lease, refuses a page locked by in-flight generation, recomputes
the candidate from the original bytes, and rejects a changed `sourceDigest`, `candidateDigest`, or
importer version. `upsertReachDeckDocumentPage` decides whether content actually changed, so replay
of the same upload returns `already-applied` without advancing the revision or rematerializing; that
content equality is the exactly-once contract, so no `importApplications` record and no new
`ReachDeckImportModeV2` value are introduced. A real change is bound to the materialized draft
revision and content digest before one atomic rematerialization.

Source bytes must be UTF-8 (a BOM is stripped) and at most 512 KiB, matching the transformed and
stored ceilings. Built-in library conversion covers exactly the three MAIC-recognized CDNs: the
Tailwind Play CDN becomes `tailwind-browser@4.3.0`, pinned KaTeX 0.16.x becomes static MathML plus
the byte-exact MathML-only bundle, and a three.js import map becomes `three-module@0.185.1`. Science
kits, function-plot, `animate-css`, and `expression` are not part of the upload contract. The
importer's reserved-input-marker rule still applies, so an uploaded document may not write
`data-reach-tailwind-runtime` or `data-reach-three-runtime` itself. Any other external dependency,
external URL, forbidden tag, CSS import, host-policy override, or network/worker API is an error.

`docs/reach-deck/interactive-html-authoring.md` is the teacher-facing authoring spec and the single
source of truth. `apps/teacher/scripts/generate-interactive-html-authoring-spec.mjs` mirrors it into
a generated module so the upload panel can copy or download the same bytes, and asserts the document
still states the current runtime versions, marker attribute names, and byte ceiling. Run
`pnpm --filter @reachany/teacher check:interactive-html-spec` to detect drift.

Player assets, CSP, SRI, sandbox, byte budgets, and Java publication validation are unchanged: an
uploaded page and an imported MAIC page have identical shape at the publication boundary. No
database-schema change is part of this path.

## Retry boundaries

| Layer                   | Owner                  | Behavior                                                                                                                                                           |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider retry          | model/provider adapter | Retries a provider call only when the adapter classifies it as retryable.                                                                                          |
| BullMQ attempt retry    | `teacher.deck` worker  | Retries the whole immutable generation turn up to 3 attempts with 10-second exponential backoff; each attempt has its own attempt number and terminal observation. |
| Browser event reconnect | Role app/client        | Reconnects with `Last-Event-ID` and replays Redis Stream events; it never creates a new job.                                                                       |

Invalid scope, prompt, document, or request identity is unrecoverable. A changed editor baseline makes a recovered proposal stale and blocks automatic apply.

## Retention and timeouts

The event store is bounded by both settings below. Defaults are 24 hours and 10,000 entries:

- `REACH_DECK_EVENT_STORE_TTL_MS=86400000`
- `REACH_DECK_EVENT_STORE_MAX_LENGTH=10000`

`REACHANY_MODEL_STREAM_TIMEOUT` controls the Spring MVC response timeout for model SSE and defaults
to `660s`. It is intentionally longer than `REACHANY_MODEL_REQUEST_TIMEOUT`, whose `600s` default
controls the model-service non-stream provider boundary. AI Runtime adds an outer `690s`
non-stream deadline and `840s` streaming deadline in code so admission and handshake waits are also
contained; optional
`REACHANY_MODEL_NON_STREAM_CALL_TIMEOUT_MS` and `REACHANY_MODEL_STREAM_CALL_TIMEOUT_MS` overrides do
not need to be injected for the standard deployment.

Pending role-app recovery records use a 24-hour client expiry. Expiry only removes the transient browser record; it does not cancel the BullMQ job or delete a durable result.

## Teacher Trial Tutor

An actual authoring Trial, opened from `ReachDeckModuleEditor` after the current draft saves,
includes the same topic, reply, vote, structured mention, rich-text, and formula conversation
capabilities as the Student Tutor sidebar. Its ordinary conversation uses a `course_directed`
Thread: AI Runtime loads the enabled course-member roster from the authorized draft context, the
director selects one next member after each completed response, and model generation remains serial.
The durable messages and Rounds use `/api/tutor/*`; Run events continue on the existing SSE route.
Generic published preview and marketplace preview uses of `ReachDeckTrialDialog` do not receive a
Tutor scope. Teacher Trial never mounts or calls the Student private-whiteboard feature.

Each entry calls
`POST /api/v1/teacher/courses/{courseId}/nodes/{courseNodeId}/reach-deck-trial-attempts` through the
Teacher BFF and teacher-service. Content-service repeats the existing exact draft/module authorization
and returns a new UUID without inserting an attempt row. The AI Thread scope contains the
organization, course, node, module, draft version, and temporary attempt. A refresh or later entry
therefore cannot match the previous Thread; no delete/reset DML, retention rule, or schema change is
part of this flow. Dialog cleanup requests cancellation of an active Run with `keepalive`; failure is
non-blocking because the old Run remains isolated by its attempt.

Teacher Tutor Runs use `reach-deck-teacher-trial-context/v1`. A Trial fence leaves the directed
ordinary Thread and uses a distinct `single` Thread scope with `tutorDomain=learning_fence` and the
exact page/question/scene identity. It does not load course classmates or write the ordinary message
ledger. The fence replaces the whole Tutor column; the teacher can force-exit while it is unresolved,
and a completed Tutor Run does not itself mark the Trial fence mastered. After exit, the ordinary
timeline contains a card that reopens the fence Thread read-only. Tutor can instead call the no-argument
`learning_fence.release_trial` tool after sufficient evidence; its durable, idempotent
`learning_fence.trial_released` event releases the Trial fence without writing Student mastery. The
event unlocks navigation but keeps the overlay open as a passed, read-only transcript until the
teacher leaves from the top-right control. The client delays that passed presentation until the
releasing Run's final Tutor message reaches a terminal state. The worker re-reads the current
materialized draft from a dedicated content-service GET that accepts only an `ai-runtime` service
principal carrying `teacher`, `ai-runtime-service`, `scene_id=student.tutor`, and the active teacher
role grant. It rechecks every scope identity and resolves slide identity as `pageId` with exactly one
`nativeSlides[pageId]` binding. A slide-page `scene` projection is rejected; no old document fallback
exists. A fence Trial Run receives `classroom.get_current_context` and
`learning_fence.release_trial`; an ordinary Trial Run may instead read its own attempt-scoped fence
transcript through `learning_fence.read_history`. Student `/my/*`, assessment, mastery-write, and
video tools remain unavailable.

## Student playback answers and runtime

AI Runtime's Reach Deck Scene does not own student answer persistence. Playback starts in Student and
uses the student business boundary:

```text
StudentReachDeckAttemptPlayer
  -> Student /api/student/reach-deck/attempts/*
  -> student-service /api/v1/my/attempts/*
  -> content-service
  -> PostgreSQL attempt/asset ledger + Mongo page projection/events
```

Content-service stores one Mongo projection per `attemptId × pageId` in
`student_deck_page_runtime_documents` and one immutable command record per `eventId` in
`student_deck_behavior_events`. Projection and event insertion share a Mongo transaction and page
revision. PostgreSQL remains the authority for attempt status, grading/progress events, and asset
ownership. Completed attempts remain readable but reject runtime writes and new uploads.

Interactive scenes use only `reach-interactive-scene/v2`. Its required manifest declares zero or
more bounded, pedagogically meaningful scalar events; generated content calls the frozen
`ReachInteractive.learningEvent(name, payload)` API. Lifecycle/session commands remain separate.
Student uploads meaningful events through an independent best-effort batch queue into the existing
behavior-event collection, so upload failure never blocks runtime autosave or completion. Valid
interactive completion is a dedicated authoritative command: content-service derives page coverage
from the pinned document and atomically writes the existing result and progress event pair in
PostgreSQL. The generic attempt-event endpoint rejects new client-authored `interactive_result`
writes; existing rows remain readable for compatibility. `completionMode:none` and non-interactive
pages advance coverage on entry; explicit and automatic interactive pages advance on their first
valid completion. Student refreshes the server projection after accepted coverage writes so
concurrent tabs and devices converge before automatic final-slide completion. Client reconciliation
OR-merges completed page IDs and latches terminal attempt status, so delayed responses cannot revoke
coverage and a tab becomes read-only when another session completes the attempt.

`GET /api/v1/my/attempts/{attemptId}/progress` returns the authorized attempt's genuine completed
page IDs in immutable document order, exact percentage, first incomplete page, lifecycle status,
and whether exact coverage is known. It never synthesizes IDs for older completed attempts. An empty
evidence set on an ordinary in-progress attempt is known zero coverage; a grandfathered completed
attempt with absent or partial exact evidence remains completed while reporting `coverageKnown=false`.
Student uses this projection for first-incomplete resume and initializes completion coverage from it.
Student page reachability (Issue #804) is a front-end experience lock derived from the same
coverage: completed pages plus the first incomplete page and everything before it are reachable;
an attempt that is already completed opens every page. Entering a slide or `completionMode:none`
interactive page optimistically counts it as complete so the next page unlocks without waiting for
the `page_enter` round trip. `src/lib/student-reach-deck-page-access.ts` is the single source for the
script outline, Player previous/next/wheel/auto-advance (`isPageNavigable`), and discussion
jumps; the global navigation lock (whiteboard editing canvas open, fence recovery, active fence, and
current-page fenced grading that the server would refuse with `grading_pending_fence`) is shared the
same way. Locked outline entries stay focusable with `aria-disabled` and explain the reason instead
of navigating.
Content-service does not yet reject a `page_enter` beyond the frontier.
Teacher classroom attempt summaries derive Reach Deck percentages from the same attempt-scoped
projection instead of the legacy stored positional maximum; Quiz and other module summaries keep
their existing progress contracts.
The completion command takes the owned PostgreSQL attempt lock, rechecks the active fence, then reads
the same Mongo/PostgreSQL evidence before changing lifecycle state. PostgreSQL and Mongo are not a
distributed transaction: a race may temporarily reject completion until retry, but cannot complete
an attempt early.

Learning-event payloads allow only manifest-declared bounded scalars; identity, timestamps received
by the service, authorization context, and authoritative outcomes are supplied or validated by the
trusted host and service. The existing behavior collection has no TTL, so these events inherit its
current retention/deletion governance. Classroom timeline and drilldown retain them, while teacher
interaction counts, trends, and page-event counts exclude them.

Student must restore all page projections before mounting the Player. It debounces ordinary runtime
updates, serializes commands per page, flushes on page leave/question submit/completion, and reuses the
same event ID when replaying after a revision conflict. Persisted state excludes signed URLs, file
bytes, and browser-supplied organization/student/attempt/module identities.

The shared Quiz DSL optionally stores `learning_fence.enabled` and a bounded immutable mastery
prompt. Teacher authors it in the Reach Deck editor; enabling it also requires a reference answer.
The private generation API does not enforce learner fences. Content-service derives incorrectness
from the pinned question and submitted runtime answer, owns fence state in the existing page
projection, and rejects browser attempts to write that state. Student locks both rails and Player
interaction and replaces ordinary Tutor discussion until AI Runtime's matching audited mastery tool
commits the server transition. Each fence uses an identity-bound Tutor Thread separate from ordinary
discussion. An incorrect fenced answer reveals neither the reference answer nor its explanation
until the server confirms mastery; Student restores this permission from persisted submissions and
the active fence on reload. The last required question or fence completes learning automatically,
without a separate completion button. Active Student fences cannot be dismissed; mastered conversations reappear as timeline
cards in their matching page groups and can only be reopened read-only. Ordinary Threads explicitly
use `tutorDomain=ordinary`, while fence Threads require `tutorDomain=learning_fence` and the complete
fence identity. Runtime checks authoritative active-fence state before persisting a new Student Run
and repeats the check in the worker, suppresses historically mixed Runs by matching each Run
learning-context domain to its Thread, atomically reuses one canonical Thread per actor/domain, and
logically aggregates same-scope physical duplicates. An ordinary Thread stored before the
discriminator existed contributes filtered history to the canonical ordinary conversation but does
not receive new Runs. Runtime also lets ordinary Tutor retrieve a bounded, actor- and
attempt-scoped fence transcript only through one cancelable store query behind the no-argument
`learning_fence.read_history` tool.

Ordinary directed discussions render one topic per learner message, with agent replies nested under
that topic using their reply chain or context watermark. A learner reply starts a new topic while
retaining its reference. Only the topic list scrolls inside Tutor; its header and composer remain
fixed. Transient thread initialization failures retry at 1, 3, and 10 seconds; authorization failures
do not retry automatically.

Selection questions keep their semantic controls. Typed answers use the dedicated full rich-text
schema with lists, marks, fonts, colors, alignment, inline/block formulas, and inline images. Only
`short_answer` supports independent ordered attachments. Inline images and attachments share the
10-assets-per-answer and 100-MiB-per-file limits.

New AI-generated Quiz pages contain exactly one top-level, non-composite question. This limit belongs
to the `teacher.deck` model prompt and strict generation schema, not the durable Quiz DSL: existing
and teacher-authored multi-question scenes remain readable and keep horizontal question navigation.
Automatic generation currently uses the structurally stable `single_choice`, `multiple_choice`, and
`short_answer` variants. The prompt requests a reference answer and explanation, while the model
schema permits missing/empty values: invalid choice references are compatibility-filtered by the
Quiz DSL and emitted directly, without entering model output-correction retries. Durable
teacher-authored fill-in questions remain supported independently of that narrower model boundary.
Their current answer contract is `fill_blanks/v1`: runtime state stores an ordered answer for each
blank rather than one question-wide string, and scoring evaluates every blank. Reset of an
unsupported older fill shape clears only that question's answer, submission, completion, reveal,
and active learning fence. Other questions on the same page remain intact; old fill state is neither
read nor converted.
Generated question, option, reference-answer, analysis, and cognitive-schema strings accept
`\(...\)` inline formulas and display formulas whose `\[` and `\]` delimiters each occupy a standalone
line, matching the QuizQuestion rich-text editor contract. AI Runtime converts that restricted
Markdown to canonical rich-text math nodes before persistence, preserves ordinary dollar signs as
text, and the Player renders those nodes statically with KaTeX.

Student asset endpoints are scoped to the exact attempt/page/question:

```text
GET  /api/v1/my/attempts/{attemptId}/pages/{pageId}/runtime
POST /api/v1/my/attempts/{attemptId}/pages/{pageId}/commands
POST /api/v1/my/attempts/{attemptId}/pages/{pageId}/questions/{questionId}/assets/presign-upload
POST /api/v1/my/attempts/{attemptId}/pages/{pageId}/questions/{questionId}/assets/presign-download
```

Student answer images (including pasted images) and attachments upload through the same-origin
`POST /api/student/reach-deck/attempts/{attemptId}/pages/{pageId}/questions/{questionId}/assets/upload`
multipart route. The Student BFF independently checks the session, Student role, exact configured
Student origin, file kind, and 100 MiB limit, obtains the scoped upload ticket through student-service,
and sends the bytes to OSS on the server, so browser OSS CORS rules do not block answers. This route
is excluded from Next.js proxy body cloning; signing and download routes retain their existing APIs.
Content-service verifies `HEAD`, promotes referenced
temporary objects to stable keys, commits the stable metadata in Mongo, and only then best-effort
deletes temporary objects.

## Student Reach Deck learning layout

The Student Deck page (Issue #804) is a fixed-viewport player column beside the shared `SidePanel`
(400px, 360px at 1280–1439, collapsed to 56px by default below 1280 and remembered in
`localStorage`). The panel has three tabs: **AI chat**, **Script**, and **Outline**. Script displays the complete
current-page narration from the published document. Generated native slide Markdown segments use
the same plain-text projection as their canonical source (formula delimiters and escapes included),
then align in order with only whitespace gaps; legacy plain-text segments stay literal. The current
page and module-scoped Player activity playhead determines the active `[start, end)` segment. Pausing preserves the highlight;
seeking updates it in either direction, and timestamp gaps have no active segment. Speech transforms
that no longer match canonical content stop alignment: already matched segments keep their timing,
and remaining text stays readable without guessed highlights. Untimed narration, PPTX notes and
Interactive scripts remain static; quiz pages show a bilingual empty state. Script adjusts only its
own scroll container when the active segment changes or its tab becomes visible; the container is
keyboard-focusable with an inward primary outline for manual scrolling. The current page title and
bilingual speaking indicator stay in a fixed header; a reserved logical border marks the active
segment without changing text or layout. Student opts into the shared SidePanel's `size="sm"`
44px minimum header height; the shared default remains 56px, and shared Tabs styles stay unchanged.
The outline lists every page with its thumbnail, title and script — slide
`nativeSlides[].slide.narration` (authoritative Markdown, else legacy segments), falling back to
PPTX speaker notes; Interactive `scene.narration.text`; quiz pages have none
(`src/lib/student-reach-deck-page-script.ts`). The current entry is highlighted and kept visible by
adjusting only the outline's own `scrollTop`. An active learning fence switches back to AI chat and
expands the panel. The previous left thumbnail rail is removed.

The shared Player keeps its defaults; the Student host opts in to `showPageControls`, which renders
previous/next, the `n/N` indicator and `timelineExtra` below quiz and Interactive pages, so every
page type has the same control bar as the native slide timeline. Quiz and Interactive shells fill
the remaining column height (`--reach-deck-interactive-height:100%`, minimum 0); quiz content
scrolls inside the Player stage while the control bar stays fixed. The learning body and workspace
use `overflow: clip`, so nothing above the page's own scroll containers can be scrolled.

Student private whiteboards use the same Portal -> student-service -> content-service authorization
path but a separate Mongo collection, `student_deck_whiteboards`. They are not Reach Deck DSL,
answer runtime, attempt events, or data owned by AI Runtime. Each board
is scoped to the authenticated student, learning attempt, and page, after revalidating the track
module selection and immutable module version; a server-assigned unique slot enforces at most ten
saved boards per scope. Every replay attempt starts with an empty set of boards. The stored anchor contains the immutable page
identity, content digest, captured scene runtime, and playhead rather than a raster screenshot or
per-stroke teaching timeline.

In the Student player the single notes entry sits at the right end of the control bar with the
current page's board count. It opens the floating board list, which is positioned on the
non-scrolling player column directly above the control bar, so it stays fully visible for every
page type and scroll position. Opening a board's editing canvas covers the player column, pauses
playback and locks page and module navigation; opening only the list does neither. The entry is
disabled while a learning fence is active or recovering.

Whiteboard creation, editing, copying, and deletion remain available both during learning and after
the module attempt is completed. Whiteboard writes do not reopen the attempt or change progress,
answers, grading, or presence. Completed learning records remain read-only while private notes stay
editable. Abandoned attempts cannot write whiteboards, and every read or write still revalidates
the authenticated student's active owned selection and immutable version/page. The per-page limit
and revision checks apply after completion as well.

The selection scope is derived from the attempt's `track_module_selection_id`; it is not accepted
from the browser. Existing v1 documents must be backfilled from `anchorAttemptId` before the v2
selection-scoped data is considered complete. The explicit maintenance runner is disabled by
default and is enabled with `reachany.reach-deck.whiteboard-selection-backfill=true` for that
migration. The index initializer retires the old cross-selection indexes and installs the new
selection-scoped indexes. Normal startup fails fast while legacy documents remain, which prevents
a deployment from silently hiding existing boards. The rollout order is: stop old content-service writers,
run one isolated content-service maintenance process with the backfill property enabled, verify its
completion log reports no conflicts and that no legacy documents remain, then stop that process and
deploy normal serving pods with the property disabled. The maintenance process must not receive
traffic. Do not use a rolling migration. The backfill assigns each legacy board to
the selection on its anchor attempt; it does not guess or duplicate boards that were previously
shared. After migration, an ordinary rollback is unsafe because the old cross-selection unique
index cannot represent selection-local slots; rollback requires a separately reviewed reverse plan.

Attempt scope reuses `anchorAttemptId` as the owning attempt: creation stores the authorized
attempt and copies stay inside it, so no new field or data backfill is required. Earlier boards
stay with the attempt that created them. Read-only verification on 2026-10-13 found 9 selections
with multiple attempts (6 active); the 11 existing boards occupied 9 scopes with only one anchor
attempt each. One board belonged to an older attempt of an active selection. The user explicitly
accepted that it remains stored under that attempt and is not shown in the latest attempt; no
migration or deletion is performed. The index initializer first creates
`ux_student_deck_whiteboard_attempt_slot` (`organizationId, studentId, anchorAttemptId,
pageId, slot`, unique) and `ix_student_deck_whiteboard_attempt_list` (`…, pageId, updatedAt desc`),
then drops `ux_student_deck_whiteboard_selection_slot` and `ix_student_deck_whiteboard_selection_list`.
If a replacement index build fails, the old quota indexes remain in place.
The unique index builds on existing data because slots were already unique per selection and each
attempt belongs to one selection. A rolling update has consistent whiteboard visibility only when
all boards belong to their selection's latest attempt. Current `createOrResume` returns the latest
existing attempt regardless of status, without creating replay attempts. Before deployment,
read-only compare board anchors with latest attempts; older-attempt boards require reassessing
mixed-version access. The 2026-10-13 check found one such board, and deployment remains separate
from the approved final visibility change. Start new replicas
sequentially during the index swap to avoid concurrent removal of the same retired index. After
rollout, verify the attempt indexes and restart one new content-service pod if an old pod recreated
selection indexes. Future replay support must enable new attempts only after all readers/writers
use attempt scope. Rollback
is safe only until a student creates a board in a second attempt that reuses a slot of an earlier
attempt, because the old selection-unique index cannot be rebuilt over that data.

## Health and operations

AI Runtime `GET /api/health` is a dependency-free liveness check. `GET /api/ready` verifies
PostgreSQL, JWT configuration, BullMQ/Redis, the namespaced event-store stream, content-service, and
model-service. Missing Scene worker heartbeats are returned as structured warnings without making
the API unready; each worker Deployment keeps its own exec readiness probe. Invalid event-store
retention configuration or a failed Redis probe is not ready, and probe connections are closed
before return.

Operational logs are allowlisted to `jobId`, attempt, reconnect count, event lag, stream expiry, cancellation, and terminal state. Prompts, documents, generated content, tokens, JWTs, environment values, and provider error bodies are not logged.

The standard Reach Deck browser client emits a bounded `http-conflict` observation for HTTP 409
responses. It contains only the status and sanitized code/message fields; URLs (including host/path
forms without a scheme), email addresses, UUIDs, identifier-shaped values, control characters, and
over-limit text are removed. It never includes the request URL, body, headers, context IDs, raw
response payload, credentials, or personal data. Decksmith keeps its independent observation path.

### Workspace conditional reads (Issue 799)

Every AI Runtime read of Reach Deck state goes through the workspace client in
`services/ai-runtime/lib/reach-deck/content-service-client.ts`. The client keeps a per-process,
byte-capped LRU (`workspace-resource-cache.ts`; 128 MiB in total, 16 MiB per entry) keyed by
organization, course, course node, module and draft module version. Each entry is the
`(ETag, data bytes)` pair of one content-service response. A read sends `If-None-Match` when an
entry exists and re-parses the stored bytes on `304`, so every caller receives an unshared object.
Only responses that carry an `ETag` are cached; whole `POST`/`PUT` responses refill the entry, and
any other workspace status or a failed write removes it. content-service still authorizes every
request and is the sole judge of freshness.

Workspace and individual generation-job polling use `getReachDeckWorkspaceReadProjection`.
After an authorized `304`, this path can reuse the fully validated workspace/recovery read model
for the exact cached response entry. Every new `200` runs the complete parser, including stored
result hashes and Interactive HTML auditing, even if its ETag repeats. Failed validation is never
cached. Actor ownership and generation-audit checks still run per request outside this cache.
The additional process-wide LRU holds at most 64 MiB of serialized projections, with a 16 MiB
per-projection limit, and references source entries weakly. V8 serialization preserves optional
undefined properties and returns independent objects on every hit. Writers, CAS retries and
post-reconciliation reloads retain complete parsing of fresh authorized reads.

Replacing, evicting or clearing a source entry immediately retires its projections. A delayed
`304` can still decode its captured raw response, but cannot repopulate a retired projection.
Projection serialization failures skip caching; decode failures fall back to full validation.
JSON decoding retains `cache-decode` and `reach_workspace_read_cache_decoded_bytes_total`;
V8 projections use `projection-decode` and `reach_workspace_read_projection_decoded_bytes_total`.
Slow-read logs separate `decoded_bytes` from `projection_decoded_bytes`.

Interactive HTML auditing keeps bounded lexical context for its script decisions and scans each
script once for network/worker capabilities; long scripts no longer repeatedly rescan every prefix.
This changes scanning cost, while preserving the offline policy and existing document size limit.

`PUT .../workspace/recovery` sends `Prefer: return=minimal` only when the cached entry's
`recoveryRevision` equals the expected revision. When the response carries
`Preference-Applied: return=minimal` and its `draftRevision` and `createdAt` match that entry, the
client recomposes the whole resource from the cached `workspace`, the `recovery` of the request body
and the version fields of the response. Otherwise it drops the entry and reads the workspace again;
the returned `workspace` half can then be newer than the write, and a failure of that read surfaces
after the recovery has been stored. `PUT .../workspace` never asks for a minimal response.

An older content-service ignores both headers and returns whole bodies without an `ETag`, which
leaves the cache empty and the behavior unchanged; there is no flag or environment variable. A `304`
is recorded in `reach_downstream_requests_seconds` with `error_type="none"`.

### Personal voice-clone deployment

Personal voice cloning is permanently enabled. There is no dedicated feature flag, UI gate,
clone-only credential, or operational kill switch. Model-service reuses the existing server-only
`REACHANY_VOLCENGINE_TTS_API_KEY` for clone provider calls; review its clone endpoint, timeout, and
retry settings. Align `REACHANY_AUTH_ISSUER` / `REACHANY_AUTH_AUDIENCE` at Teacher and
content-service; align `REACHANY_SERVICE_JWT_ISSUER` / `REACHANY_SERVICE_JWT_AUDIENCE` at
content-service, AI Runtime, and model-service; and verify existing OSS, Redis FIFO,
content-service, model-service, and `teacher.deck` worker dependencies. Record values only in
deployment secret/config management.

Roll out compatible code in this order:

1. model-service;
2. content-service;
3. teacher-service;
4. AI Runtime API and every `AI_RUNTIME_WORKER_SCENES=teacher.deck` replica on the `teacher-deck`
   channel;
5. Teacher UI.

Deploy the AI Runtime API and every `teacher.deck` worker as one synchronized rollout: all workers
must accept v5 before the API writes v5. Any queued staged v2, v3, or v4 job is rejected and requires
a fresh user retry; do not rely on a rollback reader. Every model-service replica must also
understand the voice-identity Redis fields before clone traffic arrives.

Rollback is a coordinated application deployment, not a runtime switch. Stop new requests while
versions converge; frozen clone jobs fail capability exchange rather than falling back. Keep raw
training-object cleanup and active-grant reconciliation running, retain consent/grant/training/audit
history, and do not delete or rewrite existing or published audio.

Remaining release gates and known limits:

- owner-list reads currently materialize all clones and query attempts per clone; add producer-side
  pagination/`LIMIT 101` and bounded attempt history before treating the endpoint as unbounded scale;
- the shared database retains 12 pre-existing live-only and 5 archive-only tables, unchanged by this
  feature; the current database remains authoritative;
- lock ordering and two-second lock timeout have deterministic tests, but no shared-PostgreSQL
  contention soak has been run;
- real Doubao entitlement, quota, fee, training quality, preview expiry, retention/deletion, and
  provider acceptance were not exercised in this work and require an explicit deployment gate with
  fully authorized test material;
- the OpenMAIC submodule may be absent in local worktrees, so its expected static-test skip is not
  evidence of a clone integration there; OpenMAIC clone use remains out of scope.

The one-time cutover from the retired standalone service requires stopping old producers, draining
the old BullMQ queue, then deploying Java content/model, AI Runtime, and Teacher BFF in that order.
New and old queue names, prefixes, and namespaces are not compatible. The authoritative cutover and
rollback runbook is
[`infra/appstack/services/ai-runtime/README.md`](../../../infra/appstack/services/ai-runtime/README.md#reach-deck-一次性硬切换).

## Local commands

```powershell
npx dotenvx run -f infra/env/dev.env -- pnpm --filter @reachany/ai-runtime dev
$env:AI_RUNTIME_WORKER_SCENES = "teacher.deck"
npx dotenvx run -f infra/env/dev.env -- pnpm --filter @reachany/ai-runtime worker
```

Use `http://127.0.0.1:3050` only for private health/readiness diagnostics. Browser acceptance always
uses Portal and the role frontend BFF.

### Authoring reliability and narration portability (Issue 652)

Planning-stage restart uses a fresh generation nonce; resume retains the existing nonce. The latest
planner job of each kind is selected by queue time before applied descriptors are hidden, so an old
completed candidate cannot reappear on refresh and supersede a new run. Existing content remains
visible while regeneration runs or fails, with its current progress/error controls. Revision and
input-digest fences and downstream invalidation remain authoritative.

Interactive player refreshes compare manifest and dependency content rather than object identity.
Identical media-URL refreshes do not recreate the iframe or discard its state. The initialization
watchdog counts visible foreground time; true scene changes and retry still get fresh bridge nonces.
Lifecycle listeners belong on `window`; generated and imported HTML that statically registers them
on `document` is rejected with a correction diagnostic. This is a static contract check, not an
execution proof for arbitrary author JavaScript. Existing persisted HTML is not rewritten. The
teacher startup error points to the existing regenerate-page action when reload does not help.

The Interactive narration menu also exposes `AI 重写本页`. It rewrites text from the current
materialized interactive page through AI Runtime, persists the prepared text before TTS, and lands
text/audio under the original page revision and content digests. It preserves HTML, learning-event
manifest, runtime dependencies and other scene content. Both generated and imported materialized
pages use this lane; a page without persisted narration is not eligible for this regeneration action.
A durable result awaiting landing at the same page revision blocks another rewrite, while an exact
idempotent replay remains allowed. Active media-batch members also block the action server-side.
Duplicate workers reuse the first persisted rewrite only when request provenance and queue identity
match; source-text and native continuation behavior is unchanged.
A narration commit still advances page revision and therefore reloads the preview as before.

### Start from blank

The initial teaching requirements screen offers “从空白开始 / Start from blank” alongside PPTX and
JSON import. `POST /api/reach-deck/workspace/blank` initializes a durable `manual-empty` workspace and
an empty native document through the existing writer lease and materialization path. Refresh returns
to the empty workbench; “添加第一页 / Add first page” opens the normal page insertion menu. This path
starts no AI generation and never overwrites an existing workspace. Empty drafts can be saved but
cannot be trialled or published until at least one valid page exists.
