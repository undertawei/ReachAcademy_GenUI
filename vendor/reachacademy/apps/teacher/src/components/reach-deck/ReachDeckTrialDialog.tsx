'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ChevronDown, FileText, Info, Minimize2, X } from 'lucide-react';
import {
  Button,
  IconButton,
  PersistentPortal,
  useLayer,
  useVerticalKeyboardNavigation,
} from '@reachany/ui';

import type {
  ReachDeckDocument,
  ReachDeckNativeSlideV2,
  ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';
import { reachDeckNarrationMarkdown } from '@reachany/reach-deck-dsl';
import { QuizRichTextContent } from '@/src/components/student/QuizRichTextContent';
import { markdownToTiptapJson } from '@/src/lib/quiz/markdown-to-tiptap';
import {
  NativeV2SlideRenderer,
  ReachDeckAutoAdvanceToggle,
  ReachDeckPlayer,
  type ReachDeckPlayerActivity,
  type ReachDeckPlayerEvent,
  type ReachDeckAttachmentUrlResolver,
  type ReachDeckAttachmentUnavailablePredicate,
} from '@reachany/reach-deck-player';

import { TutorPanel, useTutorPanel } from '@reachany/tutor-ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { PortalTranslator } from '@/src/lib/i18n';

import styles from './ReachDeckTrialDialog.module.css';
import { TeacherReachDeckTutorDiscussion } from './TeacherReachDeckTutorDiscussion';
import type { TeacherReachDeckTrialAttempt } from './teacher-trial-attempt';
import { downloadTeacherTrialAsset, uploadTeacherTrialAsset } from './teacher-trial-asset';
import type { TeacherTrialTutorLearningContext } from './useTeacherTrialTutorThread';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"]):not([data-focus-guard])';

interface TeacherTrialFence {
  activatedAt: string;
  key: string;
  pageId: string;
  prompt: string;
  questionId: string;
  sceneId: string;
}

export function calculateTrialNativePlayerMaxWidth({
  panelInnerHeight,
  panelInnerWidth,
  shellExtraHeight,
  shellExtraWidth,
  stageHeight,
  stageWidth,
}: {
  panelInnerHeight: number;
  panelInnerWidth: number;
  shellExtraHeight: number;
  shellExtraWidth: number;
  stageHeight: number;
  stageWidth: number;
}): number | undefined {
  if (panelInnerHeight <= 0 || panelInnerWidth <= 0 || stageHeight <= 0 || stageWidth <= 0) {
    return undefined;
  }
  const availableStageHeight = Math.max(0, panelInnerHeight - Math.max(0, shellExtraHeight));
  return Math.max(
    0,
    Math.min(
      panelInnerWidth,
      availableStageHeight * (stageWidth / stageHeight) + Math.max(0, shellExtraWidth),
    ),
  );
}

export function ReachDeckTrialDialog({
  attempt,
  deck,
  nativeResourceUrlsById,
  resolveAttachmentUrl,
  isAttachmentUnavailable,
  onClose,
  returnFocusTo,
  embedded = false,
  expandedPreview = false,
  expandedPreviewDismissAction = 'shrink',
  showStaticSlideBeforePlayback = false,
  mode = 'trial',
}: {
  attempt?: TeacherReachDeckTrialAttempt;
  deck: ReachDeckDocument;
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  isAttachmentUnavailable?: ReachDeckAttachmentUnavailablePredicate;
  onClose: () => void;
  returnFocusTo?: HTMLElement;
  /** Render a read-only preview inside a page without modal focus isolation. */
  embedded?: boolean;
  /** Shared read-only presentation layout; never used by a trial attempt. */
  expandedPreview?: boolean;
  /** Describe whether dismissal returns to an embedded player or ends the preview. */
  expandedPreviewDismissAction?: 'shrink' | 'close';
  /** Opt in to the complete static slide for read-only previews before playback. */
  showStaticSlideBeforePlayback?: boolean;
  mode?: 'preview' | 'trial';
}) {
  const { t, locale } = usePortalI18n();
  const presentation = expandedPreview && mode === 'preview' && !embedded;
  const presentationDismissLabel = t(
    expandedPreviewDismissAction === 'close'
      ? 'reachDeck.preview.closeExpanded'
      : 'teacher.marketplace.detail.shrinkPreview',
  );
  const [notesOpen, setNotesOpen] = useState(true);
  const notesId = useId();
  const copyPrefix = mode === 'preview' ? 'reachDeck.preview' : 'reachDeck.trial';
  const orderedPages = useMemo(
    () => [...deck.pages].sort((left, right) => left.order - right.order),
    [deck.pages],
  );
  const nativeSlidesByPageId = useMemo(
    () =>
      deck.schemaVersion === 'reach-deck-document/v2'
        ? new Map(deck.nativeSlides.map((binding) => [binding.pageId, binding.slide]))
        : new Map<string, ReachDeckNativeSlideV2>(),
    [deck],
  );
  const nativeStage = deck.schemaVersion === 'reach-deck-document/v2' ? deck.stage : undefined;
  const nativeThemeColors =
    deck.schemaVersion === 'reach-deck-document/v2'
      ? deck.resources.themes.find((theme) => theme.id === deck.defaultThemeId)?.colors
      : undefined;
  const [activePageId, setActivePageId] = useState(orderedPages[0]?.pageId);
  const activePage =
    orderedPages.find((candidate) => candidate.pageId === activePageId) ?? orderedPages[0];
  const activePageIndex = activePage
    ? orderedPages.findIndex((candidate) => candidate.pageId === activePage.pageId)
    : -1;
  const activeNativeSlide =
    activePage?.sceneType === 'slide' ? nativeSlidesByPageId.get(activePage.pageId) : undefined;
  const narration =
    activeNativeSlide !== undefined
      ? (reachDeckNarrationMarkdown(activeNativeSlide.narration) ?? '')
      : activePage?.sceneType === 'interactive'
        ? (activePage.scene.narration?.text ?? '')
        : '';
  const narrationDocument = useMemo(() => markdownToTiptapJson(narration), [narration]);
  const tutorEnabled = mode === 'trial' && attempt !== undefined;
  const [tutorActivity, setTutorActivity] = useState<{
    activity: ReachDeckPlayerActivity;
    attemptId: string;
  } | null>(null);
  const [trialFence, setTrialFence] = useState<TeacherTrialFence | null>(null);
  const [trialFences, setTrialFences] = useState<TeacherTrialFence[]>([]);
  const [quizTutorUnlockedPages, setQuizTutorUnlockedPages] = useState<Set<string>>(
    () => new Set(),
  );
  const settledTrialFenceKeys = useMemo(() => new Set<string>(), [attempt?.attemptId]);
  const tutorPanel = useTutorPanel({
    onForceExit: (key) => {
      settledTrialFenceKeys.add(key);
      setTrialFence(null);
    },
  });
  const {
    overlay: fenceOverlay,
    setOverlay: setFenceOverlay,
    openFence,
    requestExit: requestFenceOverlayExit,
  } = tutorPanel;
  const selectedTrialFence =
    fenceOverlay === null
      ? null
      : trialFence?.key === fenceOverlay.key
        ? trialFence
        : (trialFences.find((fence) => fence.key === fenceOverlay.key) ?? null);
  const quizTutorLocked =
    activePage?.sceneType === 'quiz' && !quizTutorUnlockedPages.has(activePage.pageId);
  const activeTutorActivity =
    tutorActivity !== null &&
    attempt !== undefined &&
    tutorActivity.attemptId === attempt.attemptId &&
    tutorActivity.activity.pageId === activePage?.pageId
      ? tutorActivity.activity
      : null;
  const tutorDomainScope = useMemo(
    () =>
      attempt === undefined
        ? undefined
        : {
            organizationId: attempt.organizationId,
            courseId: attempt.courseId,
            courseNodeId: attempt.courseNodeId,
            moduleId: attempt.moduleId,
            moduleVersionId: attempt.moduleVersionId,
            attemptId: attempt.attemptId,
            tutorDomain: 'ordinary',
          },
    [attempt],
  );
  const fenceTutorDomainScope = useMemo(() => {
    if (tutorDomainScope === undefined) return undefined;
    const fence = selectedTrialFence;
    return fence === null
      ? undefined
      : {
          ...tutorDomainScope,
          tutorDomain: 'learning_fence',
          pageId: fence.pageId,
          questionId: fence.questionId,
          sceneId: fence.sceneId,
        };
  }, [selectedTrialFence, tutorDomainScope]);
  const tutorLearningContext = useMemo<TeacherTrialTutorLearningContext | null>(() => {
    if (!tutorEnabled || activeTutorActivity === null || attempt === undefined) return null;
    const fenceContext = selectedTrialFence;
    return {
      schemaVersion: 'reach-deck-teacher-trial-context/v1',
      attemptId: attempt.attemptId,
      pageId: activeTutorActivity.pageId,
      observedAt: new Date().toISOString(),
      activity: activeTutorActivity,
      ...(fenceContext !== null && activeTutorActivity.pageId === fenceContext.pageId
        ? {
            learningFence: {
              questionId: fenceContext.questionId,
              sceneId: fenceContext.sceneId,
            },
          }
        : {}),
    };
  }, [activeTutorActivity, attempt, selectedTrialFence, tutorEnabled]);
  const fencedQuiz =
    activePage?.sceneType === 'quiz' &&
    activePage.scene.content.questions.some(
      (question) => question.learning_fence?.enabled === true,
    );
  const [pageRailOpen, setPageRailOpen] = useState(false);
  const pageRailToggle = useRef<HTMLButtonElement>(null);
  const pageRailId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const playerPanelRef = useRef<HTMLElement>(null);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const fenceOverlayRef = useRef(fenceOverlay);
  const requestFenceOverlayExitRef = useRef<() => boolean>(() => false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const keyboardNavigation = useVerticalKeyboardNavigation({
    root: dialogRef,
    enabled: mode === 'preview',
    locked: trialFence !== null,
    onNavigate: (direction) => {
      const next = orderedPages[activePageIndex + direction];
      if (next) setActivePageId(next.pageId);
    },
  });
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [nativePlayerMaxWidth, setNativePlayerMaxWidth] = useState<number>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  fenceOverlayRef.current = fenceOverlay;

  requestFenceOverlayExitRef.current = requestFenceOverlayExit;

  const requestDismiss = () => {
    if (!requestFenceOverlayExitRef.current()) closeRef.current();
  };

  const layer = useLayer({
    active: !embedded,
    elements: [dialogRef],
    kind: 'modal',
    outside: false,
    onDismiss: (_reason, event) => {
      if (event instanceof KeyboardEvent && event.isComposing) return;
      requestDismiss();
    },
  });

  useEffect(() => {
    if (activePageId && orderedPages.some((page) => page.pageId === activePageId)) return;
    setActivePageId(orderedPages[0]?.pageId);
  }, [activePageId, orderedPages]);

  useLayoutEffect(() => {
    const panel = playerPanelRef.current;
    const shell = playerShellRef.current;
    if (
      activeNativeSlide === undefined ||
      nativeStage === undefined ||
      panel === null ||
      shell === null
    ) {
      setNativePlayerMaxWidth(undefined);
      return;
    }
    let animationFrame = 0;
    let slot: HTMLElement | null = null;
    const measure = () => {
      if (slot === null) {
        setNativePlayerMaxWidth(undefined);
        return;
      }
      // The shared learner dock owns its actual height; fit the remaining canvas slot.
      // Measure the full-width parent so a previously capped canvas can grow again.
      const nativeRoot = shell.querySelector<HTMLElement>('[data-native-v2-readonly]');
      const next = calculateTrialNativePlayerMaxWidth({
        panelInnerHeight: slot.clientHeight,
        panelInnerWidth:
          presentation && nativeRoot !== null ? nativeRoot.clientWidth : slot.clientWidth,
        shellExtraHeight: 0,
        shellExtraWidth: 0,
        stageHeight: nativeStage.height,
        stageWidth: nativeStage.width,
      });
      setNativePlayerMaxWidth((current) =>
        next === undefined || current === undefined || Math.abs(current - next) >= 1
          ? next
          : current,
      );
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleMeasure);
    // Controlled page changes can mount the native renderer after this layout effect.
    // Follow renderer replacement so returning from GenUI restores the canvas fit.
    const bindSlot = () => {
      const next = shell.querySelector<HTMLElement>('[data-native-v2-slide-renderer]');
      if (next === slot) return;
      if (slot !== null) resizeObserver?.unobserve(slot);
      slot = next;
      if (slot !== null) resizeObserver?.observe(slot);
      scheduleMeasure();
    };
    bindSlot();
    measure();
    resizeObserver?.observe(panel);
    resizeObserver?.observe(shell);
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(bindSlot);
    mutationObserver?.observe(shell, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      cancelAnimationFrame(animationFrame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [activeNativeSlide, nativeStage, embedded, presentation, notesOpen]);

  useEffect(() => {
    if (embedded) return;
    const previousFocus =
      returnFocusTo ??
      (globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : null);
    const previousOverflow = globalThis.document.body.style.overflow;
    globalThis.document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const isolatedNodes = isolateModalSubtree(backdropRef.current);

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const activeDialog = target?.closest('[role="dialog"], [role="alertdialog"]');
      if (activeDialog && activeDialog !== dialogRef.current) return;
      if (event.key !== 'Tab' || dialogRef.current === null) return;
      const focusable = dialogFocusableControls(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && globalThis.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && globalThis.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    globalThis.document.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.document.removeEventListener('keydown', handleKeyDown);
      globalThis.document.body.style.overflow = previousOverflow;
      restoreIsolatedNodes(isolatedNodes);
      const restoreFocus = () => {
        if (previousFocus?.isConnected && !previousFocus.matches(':disabled')) {
          previousFocus.focus();
        }
      };
      restoreFocus();
      // The parent commit re-enables the trial trigger after this dialog unmounts; retry once
      // after that commit so the real disabled-while-open control, not only test harnesses, wins.
      queueMicrotask(restoreFocus);
    };
  }, [embedded]);

  const content = (
    <div
      className={
        embedded
          ? styles.embedded
          : `${styles.backdrop} ${presentation ? styles.presentationBackdrop : ''}`
      }
      onMouseDown={(event) => {
        if (!embedded && event.button === 0 && event.target === event.currentTarget)
          requestDismiss();
      }}
      ref={backdropRef}
      role="presentation"
      style={embedded ? undefined : { zIndex: layer.zIndex }}
    >
      <section
        {...keyboardNavigation}
        aria-describedby={embedded ? undefined : descriptionId}
        aria-labelledby={embedded ? undefined : titleId}
        aria-label={embedded ? deck.title : undefined}
        aria-modal={embedded ? undefined : true}
        className={
          embedded
            ? styles.embeddedContent
            : `${styles.dialog} ${presentation ? styles.presentation : ''}`
        }
        ref={dialogRef}
        role={embedded ? 'region' : 'dialog'}
        style={
          presentation && nativeStage !== undefined
            ? ({
                '--presentation-stage-ratio': nativeStage.height / nativeStage.width,
              } as CSSProperties)
            : undefined
        }
        tabIndex={mode === 'preview' ? 0 : -1}
      >
        <span
          className={styles.focusGuard}
          data-focus-guard
          onFocus={() => focusLastDialogControl(dialogRef.current)}
          tabIndex={embedded ? -1 : 0}
        />
        <header className={styles.header} hidden={embedded}>
          <div className={styles.heading}>
            <span>{presentation ? 'Reach Deck' : t(`${copyPrefix}.eyebrow`)}</span>
            <div>
              <h2 id={titleId}>{presentation ? deck.title : t(`${copyPrefix}.title`)}</h2>
              {!presentation && <strong>{deck.title}</strong>}
            </div>
            <p id={descriptionId}>
              {t(
                presentation
                  ? 'teacher.marketplace.expanded.description'
                  : `${copyPrefix}.description`,
              )}
            </p>
          </div>
          {presentation ? (
            <Button
              aria-label={presentationDismissLabel}
              className={styles.shrinkPreview}
              iconStart={
                expandedPreviewDismissAction === 'close' ? (
                  <X aria-hidden size={16} />
                ) : (
                  <Minimize2 aria-hidden size={16} />
                )
              }
              onClick={requestDismiss}
              ref={closeButtonRef}
              variant="outline"
            >
              {presentationDismissLabel}
            </Button>
          ) : (
            <IconButton
              icon={<X aria-hidden />}
              label={t(`${copyPrefix}.close`)}
              hidden={embedded}
              onClick={requestDismiss}
              ref={closeButtonRef}
              size="lg"
            />
          )}
        </header>

        <div
          className={`${styles.workspace} ${tutorEnabled ? styles.workspaceWithTutor : ''}`}
          data-notes-open={presentation && notesOpen}
          data-native-fit={activeNativeSlide !== undefined}
        >
          {(embedded || presentation) && (
            <Button
              ref={pageRailToggle}
              className={styles.pageRailToggle}
              variant="outline"
              iconEnd={<ChevronDown aria-hidden size={14} />}
              aria-expanded={pageRailOpen}
              aria-controls={pageRailId}
              onClick={() => setPageRailOpen((open) => !open)}
            >
              {t(`${copyPrefix}.pageList`)}
            </Button>
          )}
          <aside
            id={pageRailId}
            data-open={pageRailOpen}
            aria-label={t(`${copyPrefix}.pageList`)}
            className={styles.pageRail}
            onKeyDown={(event) => {
              if ((embedded || presentation) && event.key === 'Escape' && pageRailOpen) {
                event.stopPropagation();
                setPageRailOpen(false);
                pageRailToggle.current?.focus();
              }
            }}
          >
            <div className={styles.pageRailHeader}>
              <strong>{t(`${copyPrefix}.pageList`)}</strong>
              <span aria-atomic="true" aria-live="polite">
                {t(`${copyPrefix}.pageCount`, {
                  current: Math.max(1, activePageIndex + 1),
                  total: orderedPages.length,
                })}
              </span>
            </div>
            <ol>
              {orderedPages.map((page, index) => (
                <li key={page.pageId}>
                  <button
                    aria-current={page.pageId === activePage?.pageId ? 'page' : undefined}
                    aria-label={t(`${copyPrefix}.pageLabel`, {
                      number: index + 1,
                      title: page.title,
                    })}
                    onClick={() => {
                      if (trialFence !== null) return;
                      setActivePageId(page.pageId);
                      if ((embedded || presentation) && pageRailOpen) {
                        setPageRailOpen(false);
                        pageRailToggle.current?.focus();
                      }
                    }}
                    type="button"
                  >
                    <PageThumbnail
                      nativeResourceUrlsById={nativeResourceUrlsById}
                      nativeSlide={nativeSlidesByPageId.get(page.pageId)}
                      nativeStage={nativeStage}
                      nativeThemeColors={nativeThemeColors}
                      page={page}
                      t={t}
                    />
                    <span>
                      {index + 1}. {page.title}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>

          <main
            className={`${styles.playerPanel} ${!presentation ? styles.learnerPlayer : ''}`}
            data-scene-type={activePage?.sceneType}
            data-native-fit={activeNativeSlide === undefined ? undefined : true}
            ref={playerPanelRef}
          >
            {fencedQuiz && mode === 'preview' && !presentation ? (
              <p className={styles.fenceNotice} role="note">
                <Info aria-hidden size={16} />
                {t(`${copyPrefix}.fenceNotice`)}
              </p>
            ) : null}
            <div className={styles.playerShell} ref={playerShellRef}>
              {fencedQuiz && mode === 'preview' && presentation ? (
                <p className={styles.fenceNotice} role="note">
                  <Info aria-hidden size={16} />
                  {t(`${copyPrefix}.fenceNotice`)}
                </p>
              ) : null}
              <ReachDeckPlayer
                appearance="learner"
                isAttachmentUnavailable={isAttachmentUnavailable}
                resolveAttachmentUrl={
                  resolveAttachmentUrl || attempt
                    ? async (ref, disposition) => {
                        if (ref.questionId && ref.pageId && attempt) {
                          return await downloadTeacherTrialAsset(
                            attempt,
                            { ...ref, questionId: ref.questionId, pageId: ref.pageId },
                            disposition,
                            t,
                          );
                        }
                        if (!resolveAttachmentUrl) throw new Error(t('attachment.loadFailed'));
                        return resolveAttachmentUrl(ref, disposition);
                      }
                    : undefined
                }
                enableWheelPageNavigation={activePage?.sceneType === 'slide'}
                // Teacher Trial/preview has no server attempt: grade objective questions locally
                // and show references for AI-graded questions without grading them.
                quizGradingMode="trial"
                quizLayout="learner"
                showPageControls
                showPageIndicator
                showStaticSlideBeforePlayback={showStaticSlideBeforePlayback}
                {...(mode === 'trial' && attempt !== undefined
                  ? {
                      uploadQuizAnswerAsset: (file, context) =>
                        uploadTeacherTrialAsset(attempt, file, context, t),
                    }
                  : {})}
                locale={locale}
                activePageId={activePage?.pageId}
                autoAdvance={autoAdvance}
                document={deck}
                nativeResourceUrlsById={nativeResourceUrlsById}
                nativeSlideMaxWidth={nativePlayerMaxWidth}
                pageNavigationLocked={trialFence !== null}
                onActivityChange={(activity) => {
                  if (attempt !== undefined) {
                    setTutorActivity({ activity, attemptId: attempt.attemptId });
                  }
                }}
                onEvent={(event: ReachDeckPlayerEvent) => {
                  if (mode !== 'trial' || event.type !== 'quizSubmit') {
                    return;
                  }
                  const page = orderedPages.find((candidate) => candidate.pageId === event.pageId);
                  if (page?.sceneType !== 'quiz') return;
                  const question = page.scene.content.questions.find(
                    (candidate) => candidate.id === event.questionId,
                  );
                  if (question?.learning_fence?.enabled !== true) {
                    setQuizTutorUnlockedPages((current) => {
                      const next = new Set(current);
                      next.add(page.pageId);
                      return next;
                    });
                    return;
                  }
                  // Trial mode has no server grading: only a locally graded objective miss
                  // activates the fence; AI-graded and unscored questions just unlock the tutor.
                  if (
                    event.trialGrade?.mode !== 'GRADED' ||
                    event.trialGrade.result !== 'incorrect'
                  ) {
                    setQuizTutorUnlockedPages((current) => {
                      const next = new Set(current);
                      next.add(page.pageId);
                      return next;
                    });
                    return;
                  }
                  const nextFence = {
                    activatedAt: new Date().toISOString(),
                    key: teacherTrialFenceKey(page.pageId, question.id, page.scene.id),
                    pageId: page.pageId,
                    sceneId: page.scene.id,
                    questionId: question.id,
                    prompt: question.learning_fence.prompt,
                  };
                  if (
                    settledTrialFenceKeys.has(nextFence.key) ||
                    fenceOverlayRef.current?.key === nextFence.key
                  ) {
                    return;
                  }
                  setTrialFence(nextFence);
                  setTrialFences((current) => upsertTeacherTrialFence(current, nextFence));
                  openFence(nextFence.key, 'active');
                }}
                onPageChange={(page) => {
                  if (trialFence !== null) return;
                  setActivePageId(page.pageId);
                }}
                timelineExtra={
                  <ReachDeckAutoAdvanceToggle
                    checked={autoAdvance}
                    label={t(`${copyPrefix}.autoAdvance`)}
                    onCheckedChange={setAutoAdvance}
                    translate={t}
                  />
                }
                translate={t}
              />
            </div>
            {presentation && (
              <footer className={styles.presentationControls}>
                <Button
                  variant="secondary"
                  iconStart={<FileText aria-hidden size={16} />}
                  aria-expanded={notesOpen}
                  aria-controls={notesId}
                  onClick={() => setNotesOpen((open) => !open)}
                >
                  {t(
                    notesOpen
                      ? 'teacher.marketplace.expanded.hideNotes'
                      : 'teacher.marketplace.expanded.showNotes',
                  )}
                </Button>
              </footer>
            )}
          </main>
          {presentation && (
            <aside
              id={notesId}
              className={styles.scriptPanel}
              data-vertical-navigation-ignore
              hidden={!notesOpen}
              aria-label={t('teacher.marketplace.expanded.notes')}
            >
              <header>
                <strong>
                  <FileText aria-hidden size={16} />
                  {t('teacher.marketplace.expanded.notes')}
                </strong>
                <span>
                  {Math.max(0, activePageIndex + 1)} / {orderedPages.length}
                </span>
              </header>
              <div
                className={styles.scriptBody}
                key={activePage?.pageId}
                tabIndex={0}
                role="region"
                aria-label={t('teacher.marketplace.expanded.notes')}
              >
                <h3>{activePage?.title}</h3>
                {narration.trim() ? (
                  <QuizRichTextContent
                    value={narrationDocument}
                    ariaLabel={t('teacher.marketplace.expanded.notes')}
                    emptyLabel={t('teacher.marketplace.expanded.notesEmpty')}
                  />
                ) : (
                  <p>{t('teacher.marketplace.expanded.notesEmpty')}</p>
                )}
              </div>
              <p className={styles.scriptHint}>{t('teacher.marketplace.expanded.notesHint')}</p>
            </aside>
          )}
          {tutorEnabled && tutorDomainScope !== undefined ? (
            <TutorPanel
              className={styles.tutorPanel}
              controller={tutorPanel}
              key={attempt.attemptId}
              title={t(
                fenceOverlay?.kind === 'history'
                  ? 'reachDeck.trial.fenceHistoryCardTitle'
                  : fenceOverlay?.kind === 'mastered'
                    ? 'reachDeck.trial.fenceMasteredTitle'
                    : 'reachDeck.trial.fenceActive',
              )}
              closeLabel={t(
                fenceOverlay?.kind === 'history'
                  ? 'reachDeck.trial.fenceCloseHistory'
                  : fenceOverlay?.kind === 'mastered'
                    ? 'reachDeck.trial.fenceLeave'
                    : 'reachDeck.trial.fenceForceExit',
              )}
              renderFence={(overlay) =>
                selectedTrialFence === null ? null : (
                  <TeacherReachDeckTutorDiscussion
                    activePageId={activePage?.pageId}
                    domainScope={fenceTutorDomainScope ?? tutorDomainScope}
                    key={overlay.key}
                    learningContext={tutorLearningContext}
                    onNavigateToPage={overlay.kind === 'history' ? setActivePageId : undefined}
                    onTrialFenceReleased={
                      overlay.kind !== 'active'
                        ? undefined
                        : () => {
                            const releasedKey = overlay.key;
                            settledTrialFenceKeys.add(releasedKey);
                            if (selectedTrialFence !== null) {
                              setQuizTutorUnlockedPages((current) => {
                                const next = new Set(current);
                                next.add(selectedTrialFence.pageId);
                                return next;
                              });
                            }
                            setTrialFence((current) =>
                              current?.key === releasedKey ? null : current,
                            );
                            setFenceOverlay((current) =>
                              current?.key === releasedKey && current.kind === 'active'
                                ? { ...current, kind: 'mastered' }
                                : current,
                            );
                          }
                    }
                    openingMessage={t('reachDeck.trial.fenceOpening')}
                    pages={orderedPages}
                    readOnly={overlay.kind !== 'active'}
                    readOnlyNotice={
                      overlay.kind === 'mastered'
                        ? t('reachDeck.trial.fenceMasteredReadOnly')
                        : undefined
                    }
                    systemNotice={
                      overlay.kind === 'mastered'
                        ? t('reachDeck.trial.fenceMasteredMessage')
                        : undefined
                    }
                    variant="learning-fence"
                  />
                )
              }
            >
              <TeacherReachDeckTutorDiscussion
                activePageId={activePage?.pageId}
                domainScope={tutorDomainScope}
                learningFences={trialFences}
                learningContext={tutorLearningContext}
                onNavigateToPage={setActivePageId}
                onOpenLearningFence={(key, source) => {
                  const fence = trialFences.find((candidate) => candidate.key === key);
                  if (fence === undefined) return;
                  setActivePageId(fence.pageId);
                  openFence(key, 'history', source);
                }}
                pages={orderedPages}
                readOnly={quizTutorLocked}
                readOnlyNotice={quizTutorLocked ? t('reachDeck.trial.quizTutorLocked') : undefined}
              />
            </TutorPanel>
          ) : null}
        </div>
        <span
          className={styles.focusGuard}
          data-focus-guard
          onFocus={() => closeButtonRef.current?.focus()}
          tabIndex={embedded ? -1 : 0}
        />
      </section>
    </div>
  );

  return (
    <PersistentPortal inline={embedded}>
      <layer.Provider>{content}</layer.Provider>
    </PersistentPortal>
  );
}

function teacherTrialFenceKey(pageId: string, questionId: string, sceneId: string): string {
  return JSON.stringify([pageId, questionId, sceneId]);
}

function upsertTeacherTrialFence(
  current: TeacherTrialFence[],
  incoming: TeacherTrialFence,
): TeacherTrialFence[] {
  const existing = current.find((fence) => fence.key === incoming.key);
  const next =
    existing === undefined ? incoming : { ...incoming, activatedAt: existing.activatedAt };
  return [...current.filter((fence) => fence.key !== incoming.key), next].sort((left, right) =>
    left.activatedAt.localeCompare(right.activatedAt),
  );
}

function PageThumbnail({
  nativeResourceUrlsById,
  nativeSlide,
  nativeStage,
  nativeThemeColors,
  page,
  t,
}: {
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  nativeSlide?: ReachDeckNativeSlideV2;
  nativeStage?: { width: number; height: number };
  nativeThemeColors?: Readonly<Record<string, string>>;
  page: ReachDeckPublishedPage;
  t: PortalTranslator;
}) {
  if (page.sceneType === 'slide' && nativeSlide !== undefined && nativeStage !== undefined) {
    return (
      <span className={styles.thumbnail}>
        <span aria-hidden="true" className={styles.nativeThumbnailPreview} inert>
          <NativeV2SlideRenderer
            className={styles.nativeThumbnail}
            hideDiagnostics
            resourceUrlsById={nativeResourceUrlsById ?? {}}
            slide={nativeSlide}
            stage={nativeStage}
            themeColors={nativeThemeColors ?? {}}
          />
        </span>
        <small>{sceneTypeLabel(page.sceneType, t)}</small>
      </span>
    );
  }
  return (
    <span className={styles.thumbnail}>
      <small>{sceneTypeLabel(page.sceneType, t)}</small>
      <strong>{page.title}</strong>
    </span>
  );
}

function sceneTypeLabel(sceneType: ReachDeckPublishedPage['sceneType'], t: PortalTranslator) {
  return t(`reachDeck.editor.sceneType.${sceneType}`);
}

interface IsolatedNodeState {
  ariaHidden: string | null;
  inert: boolean;
  node: HTMLElement;
}

function isolateModalSubtree(modalLayer: HTMLElement | null): IsolatedNodeState[] {
  if (modalLayer === null) return [];
  const isolated: IsolatedNodeState[] = [];
  let current: HTMLElement = modalLayer;
  while (current.parentElement !== null) {
    const parent = current.parentElement;
    for (const sibling of parent.children) {
      if (
        sibling === current ||
        !(sibling instanceof HTMLElement) ||
        sibling.hasAttribute('data-rx-portal-root')
      )
        continue;
      isolated.push({
        ariaHidden: sibling.getAttribute('aria-hidden'),
        inert: sibling.hasAttribute('inert'),
        node: sibling,
      });
      sibling.setAttribute('aria-hidden', 'true');
      sibling.setAttribute('inert', '');
    }
    if (parent === globalThis.document.body) break;
    current = parent;
  }
  return isolated;
}

function restoreIsolatedNodes(states: IsolatedNodeState[]): void {
  for (const { ariaHidden, inert, node } of states) {
    if (inert) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
    if (ariaHidden === null) node.removeAttribute('aria-hidden');
    else node.setAttribute('aria-hidden', ariaHidden);
  }
}

function focusLastDialogControl(dialog: HTMLElement | null): void {
  const focusable = dialogFocusableControls(dialog);
  (focusable.at(-1) ?? dialog)?.focus();
}

function dialogFocusableControls(dialog: HTMLElement | null): HTMLElement[] {
  if (dialog === null) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    for (
      let node: HTMLElement | null = element;
      node !== null && node !== dialog;
      node = node.parentElement
    ) {
      if (
        node.hidden ||
        node.hasAttribute('inert') ||
        getComputedStyle(node).display === 'none' ||
        getComputedStyle(node).visibility === 'hidden'
      )
        return false;
    }
    return true;
  });
}
