'use client';

import { Pause, Play, RotateCcw, Save, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  PlaybackRateSelect,
  translateReachDeck,
  type ReachDeckTranslate,
} from '@reachany/reach-deck-player';

import type { InteractiveNarrationViewModel } from './interactiveNarration.js';

export interface InteractiveNarrationStatusTrackProps {
  disabled?: boolean;
  model: InteractiveNarrationViewModel;
  onSaveAndGenerate?: () => Promise<void> | void;
  /** 试听倍速；缺省不渲染倍速选择。 */
  onPlaybackRateChange?: (playbackRate: number) => void;
  pageId: string;
  playbackRate?: number;
  /** 另一项操作（如 Decksmith）占用课件时禁用保存/重试，并以此为按钮提示；播放不受影响。 */
  saveBlockedReason?: string;
  saving?: boolean;
  translate?: ReachDeckTranslate;
}

export function InteractiveNarrationStatusTrack({
  disabled = false,
  model,
  onSaveAndGenerate,
  onPlaybackRateChange,
  pageId,
  playbackRate = 1,
  saveBlockedReason,
  saving = false,
  translate,
}: InteractiveNarrationStatusTrackProps) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const audioAvailable = model.audioSrc !== undefined && !playbackFailed;

  useEffect(() => {
    const audio = audioRef.current;
    if (audio !== null) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlaying(false);
    setPlaybackFailed(false);
    return () => {
      if (audio === null) return;
      audio.pause();
      audio.currentTime = 0;
    };
  }, [model.audioSrc, pageId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    // 换源会把 playbackRate 重置为 defaultPlaybackRate，两者一起设。
    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;
  }, [model.audioSrc, pageId, playbackRate]);

  if (model.state === 'empty') return null;

  const playLabel = playing
    ? text('reachDeck.player.interactiveNarration.pause', '暂停互动讲稿')
    : text('reachDeck.player.interactiveNarration.play', '播放互动讲稿');
  const replayLabel = text('reachDeck.player.interactiveNarration.replay', '重新播放互动讲稿');
  const statusLabel = saving
    ? text('reachDeck.editor.interactiveNarration.saving', '正在保存并生成…')
    : model.state === 'dirty'
      ? text('reachDeck.editor.interactiveNarration.pending', '待生成音频')
      : model.state === 'queued'
        ? text('reachDeck.editor.interactiveNarration.queued', '音频排队中')
        : model.state === 'generating'
          ? text('reachDeck.editor.interactiveNarration.generating', '正在生成音频')
          : model.state === 'ready'
            ? audioAvailable
              ? text('reachDeck.editor.interactiveNarration.ready', '互动讲稿音频已就绪')
              : text('reachDeck.player.interactiveNarration.unavailable', '音频暂不可用')
            : text('reachDeck.editor.interactiveNarration.failed', '互动讲稿音频生成失败');
  const saveLabel =
    model.state === 'failed'
      ? text('reachDeck.editor.interactiveNarration.retry', '重试生成音频')
      : text('reachDeck.editor.interactiveNarration.saveAndGenerate', '保存并生成音频');
  const startPlayback = async (restart: boolean) => {
    const audio = audioRef.current;
    if (!audioAvailable || audio === null) return;
    if (restart || (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration)) {
      audio.currentTime = 0;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
      setPlaybackFailed(true);
    }
  };

  return (
    <section
      aria-label={text('reachDeck.editor.interactiveNarration.trackLabel', '互动讲稿音频状态')}
      className="reach-deck-editor__interactive-narration-track"
      data-state={model.state}
    >
      <span aria-hidden className="reach-deck-editor__interactive-narration-track-icon">
        {model.state === 'queued' || model.state === 'generating' || saving ? (
          <span className="reach-deck-timeline__generation-spinner" />
        ) : audioAvailable && model.state === 'ready' ? (
          <Volume2 size={18} />
        ) : (
          <VolumeX size={18} />
        )}
      </span>
      <span aria-live="polite" className="reach-deck-editor__interactive-narration-track-status">
        {statusLabel}
      </span>
      <div className="reach-deck-editor__interactive-narration-track-actions">
        {(model.state === 'dirty' || model.state === 'failed') &&
        onSaveAndGenerate !== undefined ? (
          <button
            aria-label={saveLabel}
            disabled={
              disabled ||
              saving ||
              saveBlockedReason !== undefined ||
              model.canonicalText === undefined
            }
            onClick={() => void onSaveAndGenerate()}
            title={saveBlockedReason ?? saveLabel}
            type="button"
          >
            <Save size={15} />
            <span>{saveLabel}</span>
          </button>
        ) : null}
        {model.state === 'ready' ? (
          <>
            <button
              aria-label={playLabel}
              disabled={disabled || !audioAvailable}
              onClick={() => {
                if (playing) {
                  audioRef.current?.pause();
                  setPlaying(false);
                } else {
                  void startPlayback(false);
                }
              }}
              title={playLabel}
              type="button"
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              aria-label={replayLabel}
              disabled={disabled || !audioAvailable}
              onClick={() => void startPlayback(true)}
              title={replayLabel}
              type="button"
            >
              <RotateCcw size={16} />
            </button>
            {onPlaybackRateChange === undefined ? null : (
              <PlaybackRateSelect
                className="reach-deck-editor__interactive-narration-track-rate"
                disabled={disabled || !audioAvailable}
                onChange={onPlaybackRateChange}
                translate={translate}
                value={playbackRate}
              />
            )}
          </>
        ) : null}
      </div>
      <audio
        data-interactive-narration-track-audio
        key={`${pageId}:${model.audioSrc ?? ''}`}
        onEnded={() => {
          const audio = audioRef.current;
          if (audio !== null) audio.currentTime = 0;
          setPlaying(false);
        }}
        onError={() => {
          setPlaying(false);
          setPlaybackFailed(true);
        }}
        preload="metadata"
        ref={audioRef}
        src={model.audioSrc}
      />
    </section>
  );
}
