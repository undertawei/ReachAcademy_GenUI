# Reach Deck capability integration

## Scope and baseline

Release branch: `daixsh01/reach-deck-capability`, based on `origin/test` at `faa5fe631`.
The original local checkout was the initial prompt source. The approved 2026-09-24 prompt revision
is maintained in the release worktree and is now the default source for future changes. Initial capability extraction and live
acceptance used `codex/reach-deck-capability-merge` at `e1cf5a5dc`; the release worktree is
`tmp/reach-deck-capability-release`. Its five implementation commits carry the selected capability
changes and outline repair navigation onto the latest fetched test baseline. The final baseline
updates rebased cleanly; the upstream changes concern Teacher quiz point allocation and
persisting ungraded short answers in the Student player.
Publishing this new branch is authorized. No PR, merge into test, deployment or database change
is part of the release handoff.

The existing worker, job runner, recovery, batch coordinator, TTS and speech preview execution
paths remain the runtime base. Queue payload additions only carry optional narration context;
they do not introduce another session, task state machine or media/audio lane.

## Authored assets

The versioned source corpus is in `services/ai-runtime/lib/reach-deck/prompts/corpus/`.
At the initial v4 baseline, `local-stages.ts`, `local-snippets.ts`, and `local-genui-diagram.ts`
preserved the original local prompt text, including all Chinese pedagogy, examples and conflict rules. Source-file comparison
passed after normalizing line endings and the two mechanical module changes (snippet import path
and exporting the existing function-plot constant).

The five narration example/calibration/reference source files also compare equal to the original
checkout. `narration-style-selector.ts` retains the local selection policy; its runtime type import
is adapted to the small capability adapter. Reference assets remain versioned under
`services/ai-runtime/reference-packs/v1/narration-humanization/`.

`manifest.ts` records every fragment's text, stage/call, purpose, original source file/version,
corpus version and SHA-256. Source stage prompts and effective composed prompts are separate entries.

Initial acceptance baseline (superseded for new generation by the v5 revision below):

- Corpus version: `reach-deck-capability-corpus/2026-09-23-v4`.
- Corpus digest: `348ae57a1097a7cc6f38b7089e179adb1909e2a7f37c689423bc3fc714780de2`.
- Fragments: 65.
- Narration corpus: `reach-deck-narration-corpus/2026-09-22-v1`.
- Narration digest: `326b5a41f67b48e4835a82debedc76766a029f6f7da59deba426e5124cae8c57`.
- Effective prompts: `lesson-plan/v22-capabilities`, `paged-outline/v59-capabilities`,
  `slide/v31-capabilities`, `quiz/v18-capabilities`, `narration/v28-capabilities`,
  `interactive/v36-creative-capabilities`.

The complete approved Stage 3 text, preparation pedagogy and knowledge micro-cycle guidance are
sent to the outline call. Tests assert complete source inclusion and hash the full inventory.
The page-responsibility contract is included in all six generation stages, not reduced to code
branches. The existing narration disclosure projection is explicitly subordinate to page roles.

### Default prompt revision — 2026-09-24

The user-approved edits in the release worktree are the default for subsequent generation:

- Corpus: `reach-deck-capability-corpus/2026-09-24-v5`, 65 fragments.
- Corpus digest: `901821ed5a4344c0e69eb10af2c3578e1096d1ca03a6cc5f1df3197cb553d60a`.
- Outline source: `paged-outline/v59-inquiry-scaffold`; effective call: `paged-outline/v60-capabilities`.
- GenUI diagram authoring/routing: `genui-diagram-media/v2`.
- Archived repair prompt: `genui-diagram-media/v2/runtime-repair`; this revision does not introduce a repair call.

This revision includes the approved exploration/Interactive choices, synthesis after 2–4 completed
groups, and diagram layout/direction guidance. Limited space is handled by repositioning labels to
avoid the main graphic, preserving the user's latest wording. The effective outline includes the
full revised source; GenUI authoring consumes the revised corpus directly. The derived visual
policy is `genui-diagram-media/v2/routing-v3`, isolating new media requests from v1 cached receipts.

Deploy or restart the API and `teacher.deck` workers with this worktree's code before expecting
running services to use v5. Existing generated outlines/pages remain unchanged; regenerate them
explicitly when the new prompt is required. Historical acceptance results below describe their
recorded baseline and are not evidence of live visual acceptance for v5.

## Contract and UI changes

- Lesson contracts preserve stable objectives, sections, points and individual atoms, with concrete
  evidence, prerequisites, learner attempts and reveals. Legacy lesson plans remain readable.
- The compact outline adapter preserves roles/functions, section/objective/knowledge references,
  micro-cycles, assessment/GenUI intent, visible-title modes and roadmap knowledge order.
- Compact `focusStatement` plus zero to five details maps mechanically to one to six legacy
  `keyPoints`; legacy-only pages retain their existing three-to-five contract.
- The Teacher UI displays knowledge points and their section/objective/evidence relationships,
  plus page semantics and reference errors. It uses the existing polling, editing and save flow.
- No title-page checkbox is added. New plans default to a title page; stored explicit `false`
  remains readable. No extra title-page restoration or regeneration state is introduced.
- Quiz contracts retain targets, evidence type, scoring points and partial-credit examples.

Live model acceptance exposed one overly strict adapter rule: a title, organizer or closing page
with no primary knowledge point can legitimately connect objectives from multiple chapters.
The parser and Teacher now share `pageAllowsCrossSectionObjectives` for those structural pages.
Known/unique references remain mandatory; a normal development page or any page with a primary
knowledge point still obeys chapter ownership. The fix preserves the first model response's
whole-course objectives and summary references instead of forcing the model to delete them.
Both generated and saved DSL outline readers use the same rule. Legacy pages without page-role
or knowledge-point semantics keep their prior read contract. Teacher checks fall back to the
story's objective IDs when a legacy lesson has no explicit objectives array.

Browser acceptance also added a small responsive CSS adjustment: the four Stage 2 tabs use two
columns on narrow screens, and Stage 2/3 footer messages and actions remain within the viewport.

## Narration and GenUI

Natural narration is authored as complete Markdown before binding visual groups. The adapter keeps
the existing TTS/caption input boundary, preserves formulas and saved teacher prose, allows shared
phrases and approximate visual timing, and does not require every element to be narrated or bound.
An unrelated reveal phrase is omitted rather than invented at the first sentence. An unrelated
scientific-state phrase uses the existing output-validation/manual-review path while retaining prose.

Creative GenUI keeps the complete `interactive/v34-creative` source. Host adapters retain CSP,
bridge, pinned dependencies, valid scripts and selected capability APIs. Historical engine-preference
rules are archived but are not reintroduced into the effective creative prompt. Custom safe
HTML/SVG/Canvas computation remains allowed even when an optional scientific kit is available.

Scientific image briefs route to code capture before material lookup/cache/image generation.
JPG/GIF results enter the existing generated-media and PPT image binding with `contain`.
Scientific failures propagate without image-model fallback; function plots retain their deterministic
renderer. Chromium capture has a bounded pool, network isolation and cancellation/deadline cleanup.

No preparation/outline sessions, continuation, format repair, aesthetic scoring, visual audits,
page-local repair, Player QA controller, separate media queue or audio/media lane were imported.
Unused local page-budget and extra continuity-summary interfaces/parsers were removed during
the final scope audit. The existing per-page continuity contract still carries the teaching brief.

Production capture also needs a browser binary. The shared base declaration now installs Chromium
and sets `REACH_DECK_PLAYER_CHROMIUM_PATH=/usr/bin/chromium`. The proposed base tag is
`node24-bookworm-reach-fonts-metafile-chromium-2026-09-23`, synchronized across the base build script,
API/worker Dockerfiles and image matrix. This tag has not been built or pushed during local work.
Publish and verify it in the authorized cloud build environment before deploying this branch.
Node, pnpm, ffmpeg, source fonts and their checksums/licenses have not changed.

## Acceptance evidence

| Requirement                                                              | Evidence                                                                              | Status                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Baseline recovery, preview, TTS, fallback, guardrails, MAIC and batching | Existing Reach Deck suite; core runner/recovery/TTS files unchanged                   | Offline regression passed                                      |
| Old/new DSL and strict references                                        | DSL suite, compact tests, pedagogy acceptance                                         | Passed                                                         |
| Complete prompt/source fidelity                                          | Full corpus hashes, source comparisons, source-inclusion tests                        | Passed                                                         |
| Knowledge cycles and Quiz evidence                                       | Fixed provider outputs through actual pipeline and parser                             | Passed for contract transport                                  |
| Six page-role conflicts                                                  | Fixed-output contracts and six real model page artifacts                              | Passed for these samples                                       |
| Title default/history and knowledge UI                                   | Teacher tests and 12 real Chromium component scenarios                                | Passed                                                         |
| Natural prose, references, formulas, approximate bindings                | Narration tests plus four real Chinese narration outputs                              | Passed for these samples                                       |
| Free GenUI and host safety                                               | Prompt/geometry/Tailwind tests plus live Canvas/SVG Player interaction                | Runtime passed; artifact quality limits below                  |
| JPG/GIF and no image fallback                                            | Chromium lifecycle tests plus live model code-to-JPG/GIF generation                   | Passed                                                         |
| Stage 3 transport/checkpoints                                            | JSON/SSE 6, 20, 40 and 41-page fixtures; runner persistence failures                  | Passed                                                         |
| Teacher production build                                                 | Next production build                                                                 | Passed                                                         |
| AI Runtime production packaging                                          | Full package build, relocated geometry worker verification and MAIC font verification | Passed locally                                                 |
| Capture browser in production image                                      | Versioned Chromium base declaration and deployment contract tests                     | Static contract passed; image publication/verification pending |
| Real model token counts and output quality                               | Live planning, conflict, narration and creative media samples                         | Measured; generated-code limitations documented below          |
| Full-stack Teacher/browser generation                                    | Production components exercised with fixture workspace and callbacks                  | Component browser passed; authenticated full-stack not run     |

Final local verification:

- Reach Deck plus startup-contract suite: 2,155 passed across 125 files.
- DSL: 918 passed across 39 files, including a rerun after unused interface removal.
- After that removal, the focused parser/pedagogy/corpus/queue/workspace suite: 188 passed.
- Teacher authoring and translation tests: 94 passed after the structural-reference fix.
- Compact/parser pedagogy tests: 38 passed after that fix; Runtime and Teacher typechecks passed.
- Final reader-boundary review: DSL 918, Teacher 94, Runtime parser/queue/workspace 184 and
  prompt/corpus/context 67 passed after the last targeted adjustments.
- AI Runtime TypeScript lint and full `pnpm --dir services/ai-runtime build`: passed.
- Teacher production build: passed.
- Deployment packaging contracts: 37 passed, one existing platform-dependent test skipped.
- Real Chromium capture: JPG dimensions, distinct GIF frames, invalid invariant rejection,
  stalled-page deadline cleanup and late-launch cancellation all passed.

The standalone tracing fix includes the geometry external package's three runtime files at its
package address, so a relocated Windows artifact resolves its own worker without escaping into the
checkout. Deployment test helpers normalize CRLF and directory separators to test the same contracts
on Windows. No production worker/recovery algorithm was changed for either packaging check.

Independent review found and verified fixes for unrelated-anchor timing and conflicting scientific
engine-selection instructions. The reviewer independently reran 26 prompt/narration tests.

## Separate transport and capacity result

The baseline already converts JSON and SSE to the same internal response envelope. Successful
6/20/40-page fixtures call the model once, parse complete assistant content once and checkpoint
twice, regardless of SSE event count. No per-event Redis write layer needed replacing.
Existing persistence-outage tests verify that completed provider work is not repeated.

| Pages | Wire     | Frames | Model calls | Full content parses | Checkpoints | Parser ms |
| ----- | -------- | -----: | ----------: | ------------------: | ----------: | --------: |
| 6     | JSON     |      1 |           1 |                   1 |           2 |      3.97 |
| 20    | JSON     |      1 |           1 |                   1 |           2 |      2.09 |
| 40    | JSON     |      1 |           1 |                   1 |           2 |      3.48 |
| 6     | SSE      |     57 |           1 |                   1 |           2 |      1.34 |
| 20    | SSE      |    184 |           1 |                   1 |           2 |      2.93 |
| 40    | SSE      |    364 |           1 |                   1 |           2 |      4.45 |
| 41    | JSON/SSE |  1/373 |           2 |                   2 |           1 | 0.14/0.15 |

These are local mocked HTTP measurements with real parsing, not model latency/token measurements.
The 41-page case retains the existing 40-page capacity limit and one output correction; its second
call is a validation correction, not a persistence replay. Raising page/token limits remains a
separate capacity change, as requested.

## Live model and browser acceptance

The canonical main checkout `infra/env/dev.env` loads the business model configuration and starts
the child command successfully. A corrected non-secret `spawnSync` probe verified both facts.
The previous shell-quoted probe incorrectly reported that the child did not launch. Decryption
warnings concern three unrelated Android signing entries only; ordinary business commands do not
depend on them. No env contents were read or copied, and no alternate environment was used.

The old harness default `openrouter/openai/gpt-5.6-terra` returned HTTP 403 (model blocked).
The canonical gateway's allowed-model list supplies `openai/gpt-5.6-terra`, used for all successful
live samples. No credential or server access policy was changed.

Planning evidence is in `tmp/live-planning-acceptance/` and
`tmp/live-planning-acceptance-final/`. The physics source contains two knowledge points. Stage 2
produced two ordered sections/objectives/points, stable atom IDs, observable evidence, full story
and a default title page. Stage 3 produced 11 pages: six Slide, four Quiz and one Interactive.
Point 1 uses exploration, submitted prediction, explanation and consolidation; point 2 opens a
concrete discrepancy, then uses a submitted calculation, worked explanation and transfer Quiz.
The final page reconnects both points to the opening question without adding a new topic.

| Call                        | Input tokens | Output tokens | Observation                                                         |
| --------------------------- | -----------: | ------------: | ------------------------------------------------------------------- |
| Stage 2                     |        7,477 |         3,291 | One call, approximately 26.4 seconds                                |
| Stage 3 first response      |       16,546 |         4,541 | Complete corpus, approximately 47,601 request characters            |
| Stage 3 old-rule correction |       21,136 |         4,540 | Triggered by the structural-page ownership defect, now fixed        |
| Stage 3 after fix           |       16,546 |         4,541 | One response, no correction, full cross-chapter references retained |

The post-fix identical request completed in 279 ms and returned identical content/usage, consistent
with provider caching; it is not an uncached latency benchmark. The original Stage 3 including
correction took 62.5 seconds. No prompt examples were shortened to obtain these results.

Six real page-role conflicts and four Chinese narrations are recorded in
`tmp/live-role-acceptance/manual-review.json`. Ten calls passed parsing on the first response,
using 95,711 input and 10,215 output tokens. Explanation and reveal pages directly answered;
Quiz retained answer reveal after submission; close introduced no acceleration topic; transfer
used the new bus data without restarting the definition or becoming close merely due to page
position. Free Interactive removed the requested four-step unlocking while preserving the
nonconflicting motion records. Narration preserved the exact LaTeX formula, used neutral
cross-page continuity and shared natural anchors. The selected hand-authored teacher example
was present verbatim in the actual system prompt. There was no ablation study, so this verifies
injection and observed prose, not a causal quality improvement attributable to one example.

`tmp/live-diagram-acceptance/` contains two real scientific authoring results routed through the
production code-capture path: a 1280 x 720 JPG of proportional distances and a 40-frame GIF of
2:3 displacements. Pixel checks were nonblank, GIF frames differed, and manual image inspection
confirmed common origins/scales, correct quantities and uncropped labels. Generation plus capture
took approximately 20.3 and 47.6 seconds. No image-model request was used.

`tmp/teacher-browser-acceptance/REPORT.md` records 12 Chromium scenarios: Chinese/English,
1440px desktop/390px touch, Stage 2/valid Stage 3/invalid Stage 3. Production React components,
styles and controls were used with a fixture workspace and recorded callbacks. Keyboard/touch,
reference error display, disabled adoption, knowledge relationships, title-checkbox absence and
historical false preservation passed. There were no page errors. This is component browser
acceptance, not authenticated Portal/BFF/database end-to-end acceptance.

## Generated-code quality limits

Two live creative samples (custom Canvas light mixing and custom SVG equivalent fractions) used
20,665 input and 6,615 output tokens. The production Player initialized both on desktop and mobile,
with no console/page errors or external network requests. Mouse/touch/keyboard actions, pixel
changes, resize, ordinary remount and reset were exercised. First-draft defects were retained in
`tmp/live-genui-acceptance/observations.json`: the fraction sample rejected a reachable zero state
on restore and drew SVG lines from incorrect coordinates; small-screen labels were too small or
clipped. These are real model-authored defects and do not count as visual-quality passes merely
because parsing succeeded.

One explicit teacher-feedback regeneration of the fraction sample, through the unchanged page
generation entry, fixed all three observed defects. Its additional 13,554 input and 3,542 output
tokens produced a sample that passed 12 desktop/mobile browser checks, including the zero-state
boundary, correct SVG line coordinates and readable mobile labels. Original failures remain in
the evidence alongside `tmp/live-genui-acceptance/iteration-2/observations.json`. No automatic
repair loop was added. The first RGB sample's clipped mobile BLUE label remains a documented
generated-artifact defect; its channel control still exposes the numeric value.

One teacher-feedback regeneration of RGB then fixed the clipped channel labels, using another
13,647 input and 3,507 output tokens. Its 12 desktop/mobile interaction checks passed, including
exact color pixels, touch, keyboard, resize, remount and reset. The mobile BLUE label fits within
the Canvas and has visible glyph pixels. Manual inspection still found a small contrast issue:
the central "MIXED LIGHT" label extends slightly outside the light-colored circle into the dark
background. No second correction was attempted. Both original and regenerated artifacts remain
in the evidence; successful runtime checks are not presented as flawless visual quality.

The free-motion conflict sample additionally placed `eventVersion` inside event payloads and used
field names differing from its manifest. The production bridge correctly rejected those events.
A narrow host API prompt clarification now gives an exact call example and explains that the
host attaches `eventVersion` outside the payload. The effective prompt and corpus versions were
advanced; the original v34 creative corpus is unchanged. With v36, the same conflict sample
emitted two valid learning events on each viewport, passing production envelope validation with
only manifest-declared `vehicle` and `distance` fields. Evidence is in
`tmp/live-role-acceptance-v36/manual-review.json`. This run used 25,018 input and 8,258 output tokens
over two calls: the unchanged single-correction path handled an initial JavaScript syntax error.
No new runtime audit, repair loop, layout mechanism or mandatory evidence collection was introduced.
Small mobile SVG labels in this motion sample remain a model-artifact quality limitation.
Final review further narrowed the API prose to permit a legitimately declared scalar field named
`name`; only transport-envelope copying and undeclared metadata are prohibited. The updated
digest is locked by tests. The preceding live sample retains its actual earlier v36 draft prompt
and digest in the evidence; it was not silently relabeled as a call with the final wording.

Full-stack authentication/persistence, live TTS/audio listening, physical-device interaction and
production Chromium image publication were not exercised. Existing regression tests cover the
unchanged TTS, preview, queue and recovery paths. The new image must be published and verified by
the cloud build before deployment; local Docker was not used.

The final independent rereview confirmed the DSL/Teacher chapter-ownership fixes, legacy
compatibility, exact bridge payload clarification and narrow-screen CSS changes. No further
actionable implementation finding remained in that bounded review.

Staged whitespace checking reports two inherited source notices: a trailing space inside a
hand-authored narration template literal and a final blank line in the imported reference README.
They are deliberately preserved for source fidelity. The check passes with only blank-at-eol and
blank-at-eof notices excluded; authored implementation files pass scoped Prettier checks.

## Release verification

The release worktree reran all 918 DSL tests, 94 Teacher authoring/translation tests, and Teacher
and AI Runtime TypeScript checks successfully. Its full Reach Deck Runtime run passed 2,150 of
2,151 tests; the Player harness HTTP boundary test exceeded its default five-second timeout.
An isolated rerun passed all four tests in that file, including the same HTTP boundary test.
The generation pipeline, corpus hashes, narration adapters, scientific media routing and Stage 3
6/20/40/41-page transport fixtures passed on the release code.
After the final upstream short-answer update, Student attempt tests (43), Teacher trial tests (9)
and Quiz Player tests (18) also passed on the rebased release branch.

The first targeted capture run could not locate ffmpeg on the shell PATH. Rerunning with the
existing local binary selected through `REACH_DECK_FFMPEG_PATH` passed all five real Chromium
JPG/GIF, scientific-invariant, timeout and cancellation checks. No encoder or prompt code change
was needed. The subsequent full Runtime run also passed these capture tests.

The repair-navigation commit marks invalid pages and makes the footer button open the first page
requiring correction. It does not repair the old local outline-session single-page regeneration
flow: that local flow and its session routes are intentionally excluded from this release. The
release retains test's whole-outline regeneration, editing and adoption workflow.

Independent source comparison reconfirmed exact original snippets and five authored narration
source files after line-ending normalization. The earlier live-model/component-browser evidence
above belongs to the initial integration worktree; it was not rerun as authenticated full-stack
acceptance on the final release baseline. The deployment and live TTS limitations still apply.
