# Reach Deck

Current product rules. Runtime depth: [reach-deck service](../services/reach-deck.md). Pins:
[tracks.md](tracks.md).

Teacher 工作台工具栏与重生成优化需求见 [工作台产品文档](reach-deck-workbench.md)：
包含已确认规则、全部勾选组合、页面状态矩阵和待确认边界，当前为需求归档，尚未实现。

## Identity

- `module_type = 'reach-deck'`. Authoring workspace is the AI Runtime `teacher.deck` Scene.
  Content-service owns authorization, materialization, publication, and learner APIs.
- One persistent draft `module_version` per module. Publish inserts an immutable published version
  and a learner-safe Mongo `reach-deck-document/v2`. The draft UUID stays. Identical digest republish
  is a no-op.
- Outer documents are v2-only. Nested scene contracts named `*/v1` are independent of that outer
  version.
- Deck pages use `slide`, `quiz`, or `interactive` throughout generation, editing, and playback.

## Teacher Trial

- Trial is teacher-side preview of the saved draft in the Player. It is not a student attempt and
  does not write page runtime or learning-fence mastery.
- Trial must save the authoritative draft first. Unpublished Managed Decks keep a disabled preview
  action; published preview never reads draft.

## Narration voice

- A personal clone belongs to its account, not to a course. Course agent settings may grant one
  active clone per agent role; this release supports the `teacher` role only and leaves assistant and
  classmate role selection for later work.
- Reach Deck resolves the teacher-role choice on the server when a new generation or explicit
  regeneration job is created. The frozen grant, opaque clone ID, and synthesis revision remain with
  that job; changing the course setting affects later jobs, not queued work or already materialized
  and published audio.
- With no active clone grant, narration keeps the exact explicit
  `zh_female_vv_uranus_bigtts` request and prior cache/queue behavior. A selected clone that is
  revoked, unavailable, or stale fails explicitly; it never silently falls back to the default.
- Provider speaker IDs and short-lived capabilities are server-only. The browser and Decksmith model
  can select neither a provider speaker nor an arbitrary clone ID.

## Decksmith context and conversation

- Conversation is teacher-private and persistent as one chronological column per stable page ID.
  Page switching never merges histories.
- `New topic` leaves a visible divider in that column and keeps earlier messages visible, but later
  requests exclude everything before the divider. There is no topic browser, parallel topic, or
  separate Clear context action.
- Conversation deletion is current-page-only and soft: it hides the earlier column and excludes it
  from future model context while retaining Runtime audit facts. There is no teacher export,
  whole-deck delete, restore UI, scheduled purge, or automatic transcript deletion.
- Current page and `@page` chips are explicit UI context. `@page` makes Decksmith read that exact
  page document; it never imports that page's conversation. Slide elements and explicitly marked
  Interactive components support focus. Quiz uses whole-page context.
- The three preset modification prompts appear only on Slide pages. Quiz and Interactive retain
  the free-form Decksmith composer.
- Long history uses page-and-topic-local rolling summaries plus a bounded recent complete-turn
  window. Raw transcript facts are retained. Teachers see ordinary/approaching/compacting/blocked
  guidance without token counts; blocked requests suggest `New topic` and do not call the model.

## Interactive pages

- Canonical and recognized legacy blank Interactive pages are valid and publishable. The Player
  does not create an iframe for them: Teacher renders an authoring action and Student renders a
  neutral localized intentional-empty state.
- Nonblank scenes remain offline in an opaque-origin `sandbox="allow-scripts"` iframe. Host CSP and
  publication checks reject external resources, network APIs, workers, nested documents, plugins,
  external form actions, and policy overrides; the CSP also disables form submission.
- New generated scenes declare exactly the pinned local runtimes they use:
  `animate-css@4.1.1`, `expression@3.0.3`, and `function-plot@1.25.4`. Legacy v2 scenes without a
  declaration retain only the historical declarative function-plot compatibility path. No CDN is
  enabled.
- Stored Interactive HTML is limited to 512 KiB; requested runtime bytes and host bootstrap must
  keep the assembled `srcdoc` within 1 MiB. Only authoring mode accepts focus from elements marked
  with `data-reach-component-id`; learner playback rejects component-focus messages.
- A nonblank generated Interactive page may carry one optional
  `reach-interactive-narration/v1` single-paragraph narration (inline formulas allowed, no line
  breaks). It briefly tells the learner what to operate and what to observe or discover. Teachers may
  add optional speech marks (`speechMarkup`), which are saved and spoken in the final audio. Its audio
  is synthesized as one track without timestamps, captions, reveal bindings, animation alignment, or
  timeline duration. Legacy, imported, and blank Interactive pages remain valid without narration.
- Teacher editing shows Interactive audio state in a fixed-height track directly below the preview,
  using the slide timeline's visual language without exposing a scrubber, ticks, waveform, or fake
  percentage. The track remains visible when the narration panel is closed and reflects the real
  dirty, queued, generating, ready, or failed state.

## Student playback

- Entry is the track selection. The attempt pins the published `module_version_id`.
- Page runtime is Mongo `student_deck_page_runtime_documents` (`attemptId × pageId`) with
  append-only `student_deck_behavior_events`.
- Re-entry reads the server-authoritative progress summary for the current attempt and opens the
  first incomplete stable `pageId` in immutable document order. Refresh, re-login, browser storage
  loss, and another device therefore do not erase accepted coverage. Page IDs and coverage never
  cross attempts or pinned versions.
- Slides without narration audio and `completionMode:none` Interactive pages gain coverage from an
  accepted Mongo `page_enter`. A slide with narration audio (Issue #804) also needs its narration
  played: content-service rebuilds played intervals from the page's narration events (play opens,
  pause closes, seek closes at `fromMs` and reopens at `toMs`, unclosed intervals do not count, each
  interval is capped at wall-clock × 10, the maximum custom playback rate, + 1 s) and requires the union to cover at least 90% of the
  narration length (the last narration segment end, else the slide duration)
  (`ReachDeckNarrationCoverage`). Attempts already `completed` keep entry-based slide coverage. The
  Student host mirrors the same algorithm (`reach-deck-narration-coverage.ts`) on the events it
  sends, unlocking the next page as soon as 90% is reached, and refreshes server progress after a
  pause or seek is delivered. Quiz pages require every published question to have a server-confirmed
  `question_submit` and no active learning fence; entering the page or autosaving a draft does not
  complete it. Explicit/automatic Interactive pages require the existing PostgreSQL
  `interactive_result` written only by the dedicated atomic page-completion command. The generic
  attempt-event endpoint rejects new `interactive_result` writes while historical rows remain
  readable. Completion rechecks this exact evidence on the server, so a direct browser completion
  request cannot bypass missing pages.
- Controlled page changes close the previous slide's narration session at its actual playback
  position before starting the next page at zero. A host's page selection or playhead reset must not
  overwrite the previous page's closing evidence.
- After accepted coverage writes, the Student player refreshes the authoritative attempt projection.
  Responses merge page IDs monotonically so a delayed older response cannot revoke newer evidence,
  and a terminal server lifecycle makes the current tab's learning records read-only. Tabs and
  devices therefore converge on the server union. All page types complete the attempt
  automatically after the last required activity, including any triggered learning fence; there is
  no manual completion button.
- A failed attempt-progress read remains pending independently of quiz grading. Visible, online
  clients retry with backoff until a successful read; a save retry rereads progress even when the
  submitted answer has already been acknowledged and its command queue is empty. Reload and
  re-entry restore the exact backend progress before deriving the next reachable page. These reads
  do not complete missing earlier pages or bypass a learning fence.
- Opening the finish dialog pauses playback, synchronizes pending learning records, and queries
  authoritative attempt progress plus the module navigation. Only a server-completed attempt gets
  the congratulations message. Missing pages, pending grading/completion, and synchronization or
  query errors have separate explanations; failed confirmation can be retried. The dialog keeps
  the next module's name and lock reason visible and offers its source-preserving link once the
  refreshed navigation permits entry. Opening the dialog itself does not submit completion.
- Coverage is monotonic within an attempt. Separately, once any authorized Reach Deck attempt for
  the exact selection and pinned version is completed, selection completion and sequential unlock
  remain latched; a later partial replay cannot revoke them. The replay still owns its own resume
  position and attempt-specific progress.
- Private whiteboards (`student_deck_whiteboards`) are a sibling store: ten boards per
  student × learning attempt × page. Every replay attempt starts with a fresh, empty set; boards
  from earlier attempts are kept but not shown. Students can create, edit, copy, and delete boards
  after attempt completion without changing learning records; abandoned attempts cannot write
  boards. Opening a board locks page and track navigation until the board is closed.
- Slide narration playback appends `narration_play`, `narration_pause`, `narration_seek`, and
  `narration_rate_change` to `student_deck_behavior_events`. Every slide start and stop is
  reported; starts and stops the learner did not click (auto-play, natural end, page change while
  playing, buffering interruption, host pause, unmount) carry `metadata.automatic = true`. The Student host
  persists the fixed event body in an attempt-scoped browser outbox before delivery and retries that
  body unchanged across reloads and online recovery. Deterministic 4xx/409 rejection parks the fixed
  body in a bounded, durable local dead-letter list so it cannot block later valid events; auth,
  throttling, timeout, network, and 5xx failures remain retryable at the queue head. Signed audio
  URLs never enter the outbox, dead-letter list, or event metadata.
- Narration audit delivery may finish after the attempt is completed when `occurredAt` remains
  inside the attempt window. The interactive learning-event endpoint remains in-progress-only.
  Natural narration end does not produce `scene_complete`.
- Interactive narration exposes play, pause, replay, and the same playback-rate choices as slides.
  It does not seek, complete the activity, or advance the Deck. Its play/pause/rate-change audit
  uses the same attempt-scoped narration outbox, while content-service verifies the exact published
  Interactive page revision and its declared audio resource (seek events stay slide-only).
- The Student player defaults to auto-play (on/off pill in the control bar, player prop `autoPlay`):
  entering a slide or a narrated Interactive page starts its narration; a slide that finishes
  naturally turns to the next reachable page and keeps playing; Interactive narration end and quiz
  pages stop and wait for the learner. Automatic slide starts append `automatic` narration events;
  automatic Interactive narration starts append none. When the browser refuses playback without a
  gesture the page stays paused.
  Teacher trial keeps the opt-in auto-advance switch.
- Student narration dock (`appearance="learner"`, Issue #804): the teacher-agent avatar is the
  play/pause control, the page chip `n/N` beneath it opens a progress popover over the control row
  (−10 s / +10 s, volume, rate, previous/next, auto-play, notes). The control row has three tiers by
  its measured width: if the labelled controls leave the progress bar at least half of the row, the
  bar sits inline and the page chip is plain text; otherwise the bar moves into the page-chip popover;
  if even the labelled controls do not fit, the text labels (back/forward/speed/previous/next/finish)
  are hidden. The avatar is the course's enabled
  `teacher` agent, read through
  `GET /api/v1/my/track-modules/{selectionId}/attempts/{attemptId}/course-agent-avatar/teacher`
  (attempt-scoped, 404 falls back to a generic icon). Pages not yet learned (server coverage or the
  local 90% mirror) accept only backward seeks; forward seeks, skips and host seek requests stop at
  the furthest point reached by actual playback (player prop `restrictNarrationForwardSeek`). GenUI
  narration seeks freely and does not count toward coverage.

## In-class quiz grading

Grading is server-authoritative through the unified
[assessment grading](../services/assessment-grading.md) capability (sourceKind `reach_deck`,
Scene `student.reach-deck.grading` with its own capability and model slot `reach-deck.grade.chat`,
Issue #766).

- **Answer freeze.** Once `submitted[questionId]` is true, the stored `answers[questionId]` wins over
  any later autosave or command state.
- **Submit.** The first `question_submit` for a question converts the frozen `QuestionAnswer` v1
  into a `GradableResponse` and calls `AssessmentGradingService.submit` inside the same Mongo
  transaction as the runtime write (PostgreSQL attempt row lock held). Objective questions and
  verbatim fill answers are graded immediately. Other fill and short-answer questions (including
  those without a reference answer) go to AI grading after commit. Unscored questions (objective
  without `has_answer`, `points <= 0`, or composites whose sub-problems are all objective) get no
  grading entry. A submit command opens the Mongo transaction first (no server operation yet), then
  the PostgreSQL transaction that locks the attempt row; PostgreSQL, including any objective
  `quiz_result`, commits before Mongo. A failed PostgreSQL commit rolls Mongo back; if Mongo fails
  after PostgreSQL committed, the replayed submit derives the same `gradingId` (deterministic from
  attempt, page and question), so the existing `quiz_result` is treated as written. Other commands
  keep PostgreSQL outermost.
- **Wrong objective answers still get AI feedback (#804).** The score is pinned at submit and the
  entry is written as `graded` at once (result event, fence, and completion behave exactly as for
  objective grading) with `feedbackStatus: grading`; the AI callback only fills `rationale` /
  `feedbackMarkdown` and drops `feedbackStatus` without re-evaluating the fence. A failed feedback
  becomes `feedbackStatus: failed`, keeps the score and never retracts `quiz_result`; the learner can
  regenerate it, also after the attempt completed. The Student player polls only the page in view
  while its feedback is generating, so learners can move on and read it when they come back.
- **Projection.** `state.serverGrading[questionId] =
{status: grading|graded|failed, gradingId, maxScore, score?, result?, rationale?, feedbackMarkdown?, feedbackStatus?}`
  (scores are JSON numbers; `result` is `correct|incorrect`). `serverGrading` is server-owned: client
  values are stripped at any depth and the stored map is re-injected. The runtime GET and the
  Teacher classroom page detail return it unchanged. Rationale and feedback never enter behavior
  events or learning events.
- **Results.** The server writes PostgreSQL `quiz_result` (`itemId=questionId`,
  `score = score / maxScore × 100`, deterministic `eventId` derived from `gradingId`) for top-level
  scored questions. The generic attempt-event endpoint rejects client `quiz_result` with 400.
  Scored items follow the unified grader. Compared with the pre-#766 rule (every top-level
  `has_answer=true`, non-coding question), `points = 0` questions and objective-only composites are
  now unscored, while fill and short-answer questions without a reference answer are scored by AI.
  The attempt aggregate (`sum of best item scores / scored item count`) therefore uses the new
  denominator, and the Teacher classroom per-question results show no result for unscored items and
  AI results for subjective items without a reference answer. Stored attempt scores are not recomputed.
- **AI write-back.** Before the grading service sends its first Mongo operation,
  `ReachDeckGradingAdapter.withSourceLock` locks the attempt row in its own PostgreSQL transaction, so
  the Mongo snapshot starts after the lock. Inside it the adapter updates the entry with a revision
  CAS, appends a digest-only `question_graded` behavior event, and writes `quiz_result`; PostgreSQL
  commits before Mongo. Remaining Mongo write conflicts retry the whole transaction up to 3 times,
  then return 409 `concurrent_update`. Failure sets `status=failed` with no result event and no fence.
- **Deadline.** The 30-minute deadline counts from when the AI run starts executing (first bundle
  fetch); queue time is not counted. A cycle that has not started after 3 hours fails with
  `queue_timeout`. Under backlog a question can therefore stay `grading` for up to about 3.5 hours,
  and the `grading_pending_fence` / `grading_pending` gates below can block for that long (not 30
  minutes). Expired entries are finalized as `failed` by the scheduler's finalization pass (up to
  200 per minute).
- **Grading context.** The AI bundle `attachments` carry short-lived URLs for the learner's answer
  attachments (only with an `assetId` owned by the organization) and for question media (stem,
  options, answers, blanks, analysis and sub-problem attachments and inline images that are
  registered in the pinned `resources.media` and owned by the module organization). Inline nodes keep
  only `objectKey`; the runtime resolves URLs from `attachments`.
- **Retry.** `POST /api/v1/my/attempts/{attemptId}/pages/{pageId}/questions/{questionId}/grading/retry`
  (Student BFF passthrough) restarts a failed grading. The limit is 2 retries per question and the
  cooldown is 60 seconds (`retry_cooldown` 429 with `retryAfterSeconds`). The response is the updated
  page runtime with the entry back at `grading`.
- **Fenced wrong answers.** While a learning fence is unmastered, the question shows its verdict and
  score at once, but the reference answer, analysis, and AI feedback stay hidden until mastery
  (#804). The fence Tutor opens with “你的回答还有改进的空间……请先说说，你刚才的作答思路是什么？”.
- **Gates.** While a fenced question is `grading`, `page_enter` to another page returns 409
  `grading_pending_fence`. Attempt completion returns 409 `grading_pending` while any page has a
  `grading` entry. `failed` never blocks. Quiz page coverage is unchanged (submitted and no active
  fence).
- **Student UI.** `StudentReachDeckAttemptPlayer` passes each page's `serverGrading` to the player
  (`quizGradingByPageId`); the student path never grades locally and never posts `quiz_result`.
  `QuizScenePlayer` shows grading in progress (polite live region), correct / partially correct
  (`0 < score < maxScore`) / incorrect with `score / maxScore`, AI feedback (rationale and feedback
  rendered by the host's controlled Markdown renderer; plain text otherwise, never HTML), and failed
  with a "grade again" button. Answer reveal waits for terminal grading (`after_submit`: this
  question graded/failed, or unscored = no entry; `after_scene`: every question). While any entry
  is `grading`, the host re-reads that page's runtime every 3 seconds (exponential back-off to 30
  seconds on errors; stops when none remain, on completion, or on unmount). When an entry settles
  it refreshes the learning fence and attempt progress; questions still `grading` never count as
  mastered. Retry goes through
  `POST /api/student/reach-deck/attempts/{attemptId}/pages/{pageId}/questions/{questionId}/grading/retry`;
  the BFF passes `data.reason` through and the host maps cooldown (with seconds), limit, not-failed,
  not-found and concurrency reasons to catalog copy. A page with a fenced question in `grading`
  locks navigation; a `grading_pending_fence` refusal is shown as a notice (not a save error) and
  that page entry is resent once grading settles. Auto-completion waits for grading and resumes
  automatically after a `grading_pending` refusal.
- **Teacher Trial.** No server attempt: objective questions are graded locally with
  `gradeObjectiveQuestion` (shared fixtures with the Java `ObjectiveGrader`), and the trial
  `quizSubmit` event carries `trialGrade`. AI-graded questions show that trial mode skips AI
  grading plus the reference answer, and never trigger a fence; only a locally graded objective
  `incorrect` does.

## Learning fence

- Optional per quiz question. The fence activates from the unified grading result: immediately at
  submit for objective questions, or when the AI result arrives for subjective questions. It
  requires an `incorrect` result, the fence enabled on the question, and no other active fence. The
  fence ID is derived from `gradingId`. Client `learningFence` fields are stripped.
- An active fence blocks other pages and attempt completion. Only `student.tutor` tool
  `learning_fence.mark_mastered` can write mastery, with a matching service token and run.
- A fence is a separate identity-bound Tutor Thread, not ordinary Tutor messages. It replaces the
  Tutor column while active; Students cannot exit until mastery, while Teacher Trial has an explicit
  force-exit because Trial never writes Student mastery.
- Ordinary Tutor Threads use `tutorDomain=ordinary`; fence Threads use
  `tutorDomain=learning_fence` plus the exact fence/page/question/scene identity. Runtime checks the
  authoritative active fence before persisting a new Student Run and again before worker execution.
  Same-scope creation is atomic; legacy duplicate Threads and discriminator-less ordinary history
  are projected through one canonical logical conversation.
- After mastery, ordinary Tutor shows one non-replyable card in the matching page group. It opens the
  exact fence transcript read-only. Ordinary Tutor may read bounded fence history only through the
  no-argument, current-actor/current-attempt-scoped `learning_fence.read_history` tool.
- Teacher Trial Tutor releases a fence only by calling `learning_fence.release_trial`, which emits
  the durable `learning_fence.trial_released` event. Generic Run completion does not release it;
  reconnect/history restoration also consumes that event. The releasing Run finishes its final
  Tutor message before the passed system message appears. Release then unlocks navigation while
  keeping the dialogue open with a disabled composer; the teacher leaves it manually from the
  top-right control. A transient SSE disconnect after release reconnects instead of presenting the
  passed state early. Unresolved fences retain the explicit force-exit control.

## Imports

- PPTX and MAIC go Teacher → `/api/reach-deck/*` → AI Runtime. Preflight is mutation-free; apply is
  atomic and CAS-guarded. Remote MAIC media is fetched only by AI Runtime and promoted through
  content-service.
- A single self-contained HTML file can replace the activity on **one** existing Interactive page
  through the same two-step contract. It is page-scoped, so there is no create/insert mode and no
  degraded confirmation. Uploaded activities are `completionMode: none` like imported MAIC ones.
  Only the Tailwind Play CDN, pinned KaTeX 0.16.x, and a three.js import map are converted to
  built-in runtimes; anything else is an error. The teacher-facing authoring spec that this upload
  path enforces is `docs/reach-deck/interactive-html-authoring.md`, and the upload panel hands out
  the same bytes for teachers to give their own AI assistant.

## Do not invent

- Reach Deck is not OpenMAIC and is not stored in `openmaic_*` schemas.
- Single-module assign for Reach Deck does **not** create a reviewer row.

## Editor autosave and narration drafts

- Ordinary page edits are autosaved after a 600 ms debounce from the latest edit, rather than on a
  fixed timer. Changed pages are saved sequentially; explicit operations flush pending autosaves.
- Narration text and speech marks remain local until the teacher explicitly saves the draft or
  generates audio. The Deck editor caches raw narration drafts by stable page ID for its current
  mounted session, including incomplete drafts, across page and panel switches. Browser refresh or
  leaving the editor ends this cache; it is not server persistence.
- Background refill updates clean narration drafts. Unsaved narration stays available until an
  explicit save or confirmed AI rewrite; manual-review candidates take precedence. A save that
  completes after a page switch only updates the original page's cache.
- Generation job status normally polls every 2 seconds (or a longer server-provided interval), and
  active workspace generation polls every 3 seconds. Request time is additional. Read timeout is
  15 seconds; failures and unlanded results retry with 2–30 second exponential backoff. Returning
  online or making the tab visible wakes polling. Completed narration document adoption is serialized, with at most four jobs per round, so sibling
  requests do not invalidate one another. Job status reads remain parallel.
- Before narration validation and submission, redundant empty paragraphs are normalized together
  with SSML offsets. Meaningful single line breaks and formula content are retained; an entirely
  empty narration still fails validation.
