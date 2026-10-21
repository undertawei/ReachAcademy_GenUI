'use client';

import { MessageSquareText, Pause, Play, RotateCcw } from 'lucide-react';
import type { ControlTouchTarget } from '@reachany/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import {
  LearnerNarrationDock,
  NARRATION_SKIP_SECONDS,
  NarrationRateControl,
  NarrationSkipButton,
  NarrationVolumeControl,
  type NarrationVolume,
} from './LearnerNarrationDock.js';
import { PlaybackRateSelect } from './PlaybackRateControl.js';
import { isPlaybackRate } from './playbackRates.js';
import { useNarrationOverflow } from './useNarrationOverflow.js';
import { useMediaStallRecovery } from './useMediaStallRecovery.js';
import { useRetainedMediaSource } from './useRetainedMediaSource.js';

export interface InteractiveNarrationBarProps {
  audioSrc?: string;
  onMediaError?: (src: string) => void;
  onMediaLoaded?: (src: string) => void;
  onMediaPlayingChange?: (playing: boolean) => void;
  /**
   * 进入本页（或本页音频地址首次就绪）时自动开始播放一次。自动开始不是学习者操作，
   * 不回调 onPlay；由它开始的播放自然结束时也不回调 onPause。
   */
  autoPlay?: boolean;
  pageId: string;
  text: string;
  scrollable?: boolean;
  translate?: ReachDeckTranslate;
  onPause?: (positionSeconds: number) => void;
  onPlay?: (positionSeconds: number) => void;
  /** 学习者改了倍速（与幻灯片时间轴同一套档位）；换页后倍速保留。 */
  onRateChange?: (fromRate: number, toRate: number, positionSeconds: number) => void;
  touchTarget?: ControlTouchTarget;
  /**
   * `dock`：学习者讲稿区排布（头像播放键 + 讲稿 + 页码进度 + 控制行），翻页与宿主扩展位
   * 由 `navigation` 放进控制行；缺省 `bar` 保持原来的单行讲稿条。
   */
  layout?: 'bar' | 'dock';
  avatar?: ReactNode;
  navigation?: ReactNode;
  pageNumber?: { current: number; total: number };
  volume?: NarrationVolume;
  onVolumeChange?: (volume: NarrationVolume) => void;
}

/** A deliberately timeline-free audio control for one Interactive guidance paragraph. */
export function InteractiveNarrationBar({
  audioSrc: latestAudioSrc,
  onMediaError,
  onMediaLoaded,
  onMediaPlayingChange,
  autoPlay = false,
  pageId,
  text: narrationText,
  scrollable = false,
  translate,
  onPause,
  onPlay,
  onRateChange,
  touchTarget,
  layout = 'bar',
  avatar,
  navigation,
  pageNumber,
  volume,
  onVolumeChange,
}: InteractiveNarrationBarProps) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  const audioRef = useRef<HTMLAudioElement>(null);
  const { ref: narrationRef, overflowing } = useNarrationOverflow(scrollable, narrationText);
  const [playing, setPlaying] = useState(false);
  const desiredPlayingRef = useRef(false);
  const positionRef = useRef(0);
  const restoringRef = useRef(false);
  const failedRef = useRef(false);
  const preferencesRef = useRef<{ volume: number; muted: boolean } | undefined>(undefined);
  const {
    source: audioSrc,
    adoptLatest,
    markHealthy,
    retryRevision,
  } = useRetainedMediaSource(
    latestAudioSrc,
    (playing || desiredPlayingRef.current) && onMediaError !== undefined,
    pageId,
  );
  const previousSourceRef = useRef(audioSrc);
  if (previousSourceRef.current !== audioSrc) {
    const audio = audioRef.current;
    if (audio && !failedRef.current) {
      positionRef.current = audio.currentTime;
      preferencesRef.current = { volume: audio.volume, muted: audio.muted };
    }
    restoringRef.current = true;
    previousSourceRef.current = audioSrc;
  }
  const stallRecovery = useMediaStallRecovery(
    (media) => {
      if (!onMediaError) return;
      positionRef.current = media.currentTime;
      preferencesRef.current = { volume: media.volume, muted: media.muted };
      failedRef.current = true;
      adoptLatest();
      if (audioSrc) onMediaError(audioSrc);
    },
    pageId + ':' + (audioSrc ?? ''),
  );
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [position, setPosition] = useState({ currentTime: 0, duration: 0 });
  const audioAvailable = audioSrc !== undefined && audioSrc.trim().length > 0 && !playbackFailed;
  // 当前这段播放是否由学习者开始：只有学习者开始的播放，自然结束才记一次暂停意图。
  const learnerStartedRef = useRef(false);
  const autoPlayedPageIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const audio = audioRef.current;
    desiredPlayingRef.current = false;
    positionRef.current = 0;
    learnerStartedRef.current = false;
    setPlaying(false);
    setPosition({ currentTime: 0, duration: 0 });
    return () => {
      audio?.pause();
      if (audio) audio.currentTime = 0;
      onMediaPlayingChange?.(false);
    };
  }, [pageId]);

  useEffect(() => {
    const audio = audioRef.current;
    setPlaybackFailed(false);
    // 每次进入页面只自动开始一次；音频地址晚到（签名地址异步解析）时在它就绪后开始。
    let cancelled = false;
    let autoPlayPending = false;
    if (
      autoPlay &&
      audio !== null &&
      audioSrc !== undefined &&
      audioSrc.trim().length > 0 &&
      autoPlayedPageIdRef.current !== pageId
    ) {
      autoPlayedPageIdRef.current = pageId;
      autoPlayPending = true;
      // 部分环境（如 jsdom）的 play() 不返回 Promise，统一包一层。
      startAudio(audio).then(
        () => {
          autoPlayPending = false;
          if (!cancelled) {
            desiredPlayingRef.current = true;
            setPlaying(true);
            onMediaPlayingChange?.(true);
          }
        },
        (error: unknown) => {
          autoPlayPending = false;
          if (cancelled) return;
          setPlaying(false);
          // 浏览器拒绝无手势播放时保持可播放，学习者点播放即可；其他失败按音频不可用处理。
          if (!isPlaybackRefusal(error)) setPlaybackFailed(true);
        },
      );
    }
    return () => {
      cancelled = true;
      // 自动播放还没落定就被清理（开发态 StrictMode 的二次挂载）：允许下一次挂载重新开始。
      if (autoPlayPending) autoPlayedPageIdRef.current = undefined;
    };
  }, [audioSrc, pageId]);

  const retriedRef = useRef(0);
  useEffect(() => {
    if (!onMediaError || retryRevision === retriedRef.current) return;
    retriedRef.current = retryRevision;
    const audio = audioRef.current;
    if (!audio || !failedRef.current || restoringRef.current) return;
    if (!navigator.userAgent.toLowerCase().includes('jsdom')) {
      restoringRef.current = true;
      audio.load();
    }
  }, [audioSrc, retryRevision]);

  // 换页时 audio 元素按 key 重建，倍速要重新套上。
  useEffect(() => {
    const audio = audioRef.current;
    if (audio !== null) audio.playbackRate = playbackRate;
  }, [audioSrc, pageId, playbackRate]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null || volume === undefined) return;
    audio.volume = Math.max(0, Math.min(1, volume.volume));
    audio.muted = volume.muted;
  }, [audioSrc, pageId, volume]);

  const syncPosition = (audio: HTMLAudioElement) => {
    if (restoringRef.current || (onMediaError !== undefined && audio.readyState === 0)) return;
    positionRef.current = audio.currentTime;
    setPosition({
      currentTime: audio.currentTime,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    });
  };

  // GenUI 讲稿不计入学习进度，进度条与快进快退都可自由使用，也不记跳转意图。
  const seekTo = (time: number) => {
    const audio = audioRef.current;
    if (audio === null) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.currentTime = Math.max(0, Math.min(duration, time));
    syncPosition(audio);
  };

  const startPlayback = async (restart: boolean) => {
    const audio = audioRef.current;
    if (!audioAvailable || audio === null) return;
    if (restart && playing) {
      audio.pause();
      setPlaying(false);
      onPause?.(audio.currentTime);
    }
    if (restart || (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration)) {
      audio.currentTime = 0;
    }
    try {
      await audio.play();
      learnerStartedRef.current = true;
      desiredPlayingRef.current = true;
      onMediaPlayingChange?.(true);
      setPlaying(true);
      onPlay?.(audio.currentTime);
    } catch (error) {
      setPlaying(false);
      if (!isPlaybackRefusal(error)) {
        setPlaybackFailed(true);
        if (audioSrc) {
          adoptLatest();
          onMediaError?.(audioSrc);
        }
      }
    }
  };

  const pausePlayback = () => {
    const audio = audioRef.current;
    if (audio === null) return;
    positionRef.current = audio.currentTime;
    audio.pause();
    desiredPlayingRef.current = false;
    onMediaPlayingChange?.(false);
    setPlaying(false);
    onPause?.(audio.currentTime);
  };

  const changeRate = (nextRate: number) => {
    if (!isPlaybackRate(nextRate) || nextRate === playbackRate) return;
    const previousRate = playbackRate;
    setPlaybackRate(nextRate);
    onRateChange?.(previousRate, nextRate, audioRef.current?.currentTime ?? 0);
  };

  const rateSelect = (
    <PlaybackRateSelect
      className="reach-deck-player__rate"
      disabled={!audioAvailable}
      onChange={changeRate}
      touchTarget={touchTarget}
      translate={translate}
      value={playbackRate}
    />
  );

  const audioElement = (
    <audio
      data-interactive-narration-audio
      key={pageId}
      onDurationChange={(event) => syncPosition(event.currentTarget)}
      onEnded={(event) => {
        stallRecovery.cancel(event.currentTarget);
        const audio = audioRef.current;
        const endedAt = audio?.currentTime ?? 0;
        if (audio !== null) audio.currentTime = 0;
        setPlaying(false);
        desiredPlayingRef.current = false;
        positionRef.current = 0;
        onMediaPlayingChange?.(false);
        if (learnerStartedRef.current) onPause?.(endedAt);
        learnerStartedRef.current = false;
      }}
      onError={(event) => {
        if (!restoringRef.current) {
          positionRef.current = event.currentTarget.currentTime;
          preferencesRef.current = {
            volume: event.currentTarget.volume,
            muted: event.currentTarget.muted,
          };
        }
        failedRef.current = true;
        stallRecovery.cancel(event.currentTarget);
        setPlaying(false);
        setPlaybackFailed(true);
        adoptLatest();
        if (audioSrc) onMediaError?.(audioSrc);
      }}
      onStalled={(event) => stallRecovery.arm(event.currentTarget)}
      onWaiting={(event) => stallRecovery.arm(event.currentTarget)}
      onPlaying={(event) => {
        stallRecovery.cancel(event.currentTarget);
        if (!restoringRef.current) {
          failedRef.current = false;
          setPlaybackFailed(false);
          if (audioSrc) markHealthy(audioSrc);
        }
      }}
      onPause={(event) => stallRecovery.cancel(event.currentTarget)}
      onLoadedMetadata={(event) => {
        const audio = event.currentTarget;
        audio.currentTime = positionRef.current;
        audio.playbackRate = playbackRate;
        if (preferencesRef.current) {
          audio.volume = preferencesRef.current.volume;
          audio.muted = preferencesRef.current.muted;
        }
        restoringRef.current = false;
        setPlaybackFailed(false);
        syncPosition(audio);
        if (desiredPlayingRef.current)
          void startAudio(audio).then(
            () => setPlaying(true),
            () => undefined,
          );
      }}
      onCanPlay={(event) => {
        stallRecovery.cancel(event.currentTarget);
        if (audioSrc) {
          failedRef.current = false;
          markHealthy(audioSrc);
          onMediaLoaded?.(audioSrc);
        }
      }}
      onTimeUpdate={(event) => syncPosition(event.currentTarget)}
      preload="metadata"
      ref={audioRef}
      src={audioSrc}
    />
  );

  if (layout === 'dock') {
    return (
      <div
        aria-label={text('reachDeck.player.interactiveNarration.label', '互动讲稿')}
        className="reach-deck-player__interactive-dock"
        data-audio-state={audioAvailable ? (playing ? 'playing' : 'ready') : 'unavailable'}
        role="group"
      >
        <LearnerNarrationDock
          avatar={avatar}
          caption={
            <>
              <p
                aria-label={
                  overflowing
                    ? text('reachDeck.player.interactiveNarration.label', '互动讲稿')
                    : undefined
                }
                ref={narrationRef}
                role={overflowing ? 'region' : undefined}
                tabIndex={overflowing ? 0 : undefined}
              >
                {narrationText}
              </p>
              {!audioAvailable ? (
                <span
                  className="reach-deck-player__interactive-narration-unavailable"
                  role="status"
                >
                  {text('reachDeck.player.interactiveNarration.unavailable', '音频暂不可用')}
                </span>
              ) : null}
            </>
          }
          controls={
            <>
              <div className="reach-deck-player__transport-group">
                <NarrationSkipButton
                  direction="backward"
                  disabled={!audioAvailable || position.currentTime <= 0}
                  onClick={() => seekTo(position.currentTime - NARRATION_SKIP_SECONDS)}
                  translate={translate}
                />
                <NarrationSkipButton
                  direction="forward"
                  disabled={
                    !audioAvailable ||
                    position.duration <= 0 ||
                    position.currentTime >= position.duration
                  }
                  onClick={() => seekTo(position.currentTime + NARRATION_SKIP_SECONDS)}
                  translate={translate}
                />
                {volume === undefined || onVolumeChange === undefined ? null : (
                  <NarrationVolumeControl
                    disabled={!audioAvailable}
                    onChange={onVolumeChange}
                    translate={translate}
                    value={volume}
                  />
                )}
                <NarrationRateControl
                  disabled={!audioAvailable}
                  onChange={changeRate}
                  translate={translate}
                  value={playbackRate}
                />
              </div>
              {navigation}
            </>
          }
          onTogglePlay={() => (playing ? pausePlayback() : void startPlayback(false))}
          pageId={pageId}
          pageNumber={pageNumber}
          playDisabled={!audioAvailable}
          playLabels={{
            pause: text('reachDeck.player.interactiveNarration.pause', '暂停互动讲稿'),
            play: text('reachDeck.player.interactiveNarration.play', '播放互动讲稿'),
          }}
          playing={playing}
          progressLabel={text('reachDeck.player.interactiveNarration.progress', '讲稿进度')}
          progress={
            !audioAvailable || position.duration <= 0
              ? undefined
              : {
                  currentTime: position.currentTime,
                  duration: position.duration,
                  onSeek: seekTo,
                  onSeekCancel: () => undefined,
                  onSeekCommit: seekTo,
                  onSeekStart: () => undefined,
                }
          }
          timelineKind="interactive"
          translate={translate}
        />
        {audioElement}
      </div>
    );
  }

  return (
    <div
      aria-label={text('reachDeck.player.interactiveNarration.label', '互动讲稿')}
      className="reach-deck-player__interactive-narration"
      data-audio-state={audioAvailable ? (playing ? 'playing' : 'ready') : 'unavailable'}
      role="group"
    >
      <div aria-hidden className="reach-deck-player__interactive-narration-icon">
        {/* 与幻灯片字幕条同一个讲稿图标；音频不可用由下方文字说明。 */}
        <MessageSquareText size={16} />
      </div>
      <p
        aria-label={
          overflowing ? text('reachDeck.player.interactiveNarration.label', '互动讲稿') : undefined
        }
        ref={narrationRef}
        role={overflowing ? 'region' : undefined}
        tabIndex={overflowing ? 0 : undefined}
      >
        {narrationText}
      </p>
      <div className="reach-deck-player__interactive-narration-actions">
        <button
          aria-label={
            playing
              ? text('reachDeck.player.interactiveNarration.pause', '暂停互动讲稿')
              : text('reachDeck.player.interactiveNarration.play', '播放互动讲稿')
          }
          data-reach-deck-primary-control
          disabled={!audioAvailable}
          onClick={() => (playing ? pausePlayback() : void startPlayback(false))}
          title={
            playing
              ? text('reachDeck.player.interactiveNarration.pause', '暂停互动讲稿')
              : text('reachDeck.player.interactiveNarration.play', '播放互动讲稿')
          }
          type="button"
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          aria-label={text('reachDeck.player.interactiveNarration.replay', '重新播放互动讲稿')}
          disabled={!audioAvailable}
          onClick={() => void startPlayback(true)}
          title={text('reachDeck.player.interactiveNarration.replay', '重新播放互动讲稿')}
          type="button"
        >
          <RotateCcw size={16} />
        </button>
        {rateSelect}
      </div>
      {!audioAvailable ? (
        <span className="reach-deck-player__interactive-narration-unavailable" role="status">
          {text('reachDeck.player.interactiveNarration.unavailable', '音频暂不可用')}
        </span>
      ) : null}
      {audioElement}
    </div>
  );
}

function startAudio(audio: HTMLAudioElement): Promise<void> {
  try {
    return Promise.resolve(audio.play());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** 浏览器自动播放策略拒绝（无用户手势）或播放被后续暂停打断，都不是音频本身不可用。 */
function isPlaybackRefusal(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}
