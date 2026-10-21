import type { ReachDeckNativeSlideV2, ReachDeckSpeechMarkV1 } from '@reachany/reach-deck-dsl';
import {
  NarrationEditor,
  type NarrationSpeechPreviewResult,
  type NarrationSpeechPreviewTrack,
} from '@reachany/reach-deck-editor';
import type { ComponentProps } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LoaderCircle, ScanText } from 'lucide-react';
import { alignAsrChunk, alignSeedChunk } from './clone-speech-fuzzy-alignment.js';
import type {
  CloneSpeechHarnessAsrResult,
  CloneSpeechHarnessChunk,
  CloneSpeechHarnessPreviewTrack,
  CloneSpeechHarnessWord,
} from './clone-speech-harness.js';

const EMPTY_WORDS: readonly CloneSpeechHarnessWord[] = [];

interface AlignedPreviewWord extends CloneSpeechHarnessWord {
  source: 'asr' | 'seed';
  block: boolean;
}

const ALLOWED_SPEECH_MARK_TYPES = [
  'break',
  'sub',
  'say-as',
  'phoneme',
] as const satisfies readonly ReachDeckSpeechMarkV1['type'][];

const LAB_SLIDE: ReachDeckNativeSlideV2 = {
  schemaVersion: 'reach-deck-slide/v2',
  id: 'clone-speech-harness',
  title: '音色 SSML 对比实验台',
  background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
  elements: [],
  animations: [],
  narration: {
    markdown: '课程将在 2026 年 9 月 11 日开始。请将 API 读作 A-P-I，在这一段之后稍作停顿。',
  },
};

class CloneSpeechHarnessApiError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super('Clone speech preview failed');
    this.name = 'CloneSpeechHarnessApiError';
  }
}

function CloneSpeechHarnessApp() {
  const [inputMode, setInputMode] = useState<'ssml_text_type' | 'ssml_field' | 'plain_text'>(
    'ssml_text_type',
  );
  const [enableSubtitle, setEnableSubtitle] = useState(true);
  const [enableTimestamp, setEnableTimestamp] = useState(false);
  const previewSpeech: NonNullable<ComponentProps<typeof NarrationEditor>['onPreviewSpeech']> = (
    input,
    signal,
  ) => previewCloneSpeech({ ...input, inputMode, enableSubtitle, enableTimestamp }, signal);
  return (
    <div className="clone-speech-harness">
      <header className="clone-speech-harness__masthead">
        <div className="clone-speech-harness__masthead-inner">
          <div className="clone-speech-harness__identity">
            <span aria-hidden="true" className="clone-speech-harness__mark">
              RD
            </span>
            <div className="clone-speech-harness__titles">
              <p>Reach Deck · Local development</p>
              <h1>音色 SSML 对比实验台</h1>
            </div>
          </div>
          <span className="clone-speech-harness__status">本地实验</span>
        </div>
      </header>
      <main className="clone-speech-harness__main">
        <div className="clone-speech-harness__section-header">
          <h2>讲稿编辑器</h2>
          <span>默认音色 vs 克隆音色 · MP3</span>
        </div>
        <div className="clone-speech-harness__controls">
          <fieldset className="clone-speech-harness__mode">
            <legend>输入位置</legend>
            {(
              [
                ['ssml_text_type', 'text + text_type=ssml'],
                ['ssml_field', 'ssml 字段'],
                ['plain_text', '纯文本'],
              ] as const
            ).map(([value, label]) => (
              <label className={inputMode === value ? 'is-active' : ''} key={value}>
                <input
                  checked={inputMode === value}
                  name="input-mode"
                  onChange={() => setInputMode(value)}
                  type="radio"
                  value={value}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="clone-speech-harness__switches">
            <label>
              <input
                checked={enableSubtitle}
                onChange={(event) => setEnableSubtitle(event.currentTarget.checked)}
                type="checkbox"
              />{' '}
              audio_params.enable_subtitle
            </label>
            <label>
              <input
                checked={enableTimestamp}
                onChange={(event) => setEnableTimestamp(event.currentTarget.checked)}
                type="checkbox"
              />{' '}
              additions.enable_timestamp
            </label>
          </div>
        </div>
        <section
          aria-label="音色对比讲稿编辑器"
          className="clone-speech-harness__editor reach-deck-editor"
        >
          <NarrationEditor
            allowedSpeechMarkTypes={ALLOWED_SPEECH_MARK_TYPES}
            allowSpeechDocumentSettings
            onPreviewSpeech={previewSpeech}
            previewSettingsKey={`${inputMode}:${enableSubtitle}:${enableTimestamp}`}
            renderPreviewTrack={(track, index) => (
              <SubtitlePreviewTrack
                autoPlay={index === 0}
                track={track as CloneSpeechHarnessPreviewTrack}
              />
            )}
            speechTagsInitiallyVisible
            slide={LAB_SLIDE}
          />
        </section>
      </main>
    </div>
  );
}

async function previewCloneSpeech(
  input: Parameters<NonNullable<ComponentProps<typeof NarrationEditor>['onPreviewSpeech']>>[0] & {
    inputMode: 'ssml_text_type' | 'ssml_field' | 'plain_text';
    enableSubtitle: boolean;
    enableTimestamp: boolean;
  },
  signal: AbortSignal,
): Promise<NarrationSpeechPreviewResult> {
  const response = await fetch('/preview', {
    body: JSON.stringify(input),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    method: 'POST',
    signal,
  });
  const value = await readJsonRecord(response);
  if (!response.ok) {
    throw new CloneSpeechHarnessApiError(
      typeof value.code === 'string' ? value.code : undefined,
      readRetryAfterSeconds(response.headers.get('retry-after')),
    );
  }
  const tracks = readComparisonTracks(value.tracks);
  if (tracks === undefined) {
    throw new CloneSpeechHarnessApiError('SPEECH_TOOL_ADMISSION_UNAVAILABLE', undefined);
  }
  return { tracks };
}

function readComparisonTracks(value: unknown): readonly NarrationSpeechPreviewTrack[] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const expected = [
    { id: 'default', label: '默认音色' },
    { id: 'clone', label: '克隆音色' },
  ] as const;
  const tracks = value.map((track, index) => {
    const identity = expected[index];
    if (
      identity === undefined ||
      typeof track !== 'object' ||
      track === null ||
      Array.isArray(track)
    ) {
      return undefined;
    }
    const input = track as Record<string, unknown>;
    if (
      input.id !== identity.id ||
      input.label !== identity.label ||
      input.contentType !== 'audio/mpeg' ||
      !isBase64(input.dataBase64)
    ) {
      return undefined;
    }
    if (
      typeof input.durationSeconds !== 'number' ||
      !Number.isFinite(input.durationSeconds) ||
      typeof input.sourceText !== 'string' ||
      typeof input.spokenText !== 'string' ||
      !Array.isArray(input.ssml) ||
      !input.ssml.every((part) => typeof part === 'string') ||
      !['ssml_text_type', 'ssml_field', 'plain_text'].includes(input.inputMode as string) ||
      !Array.isArray(input.words) ||
      !input.words.every(isPreviewWord) ||
      !Array.isArray(input.chunks) ||
      input.chunks.length === 0 ||
      input.chunks.length > 100 ||
      !input.chunks.every(isPreviewChunk)
    )
      return undefined;
    return {
      ...identity,
      contentType: 'audio/mpeg',
      dataBase64: input.dataBase64,
      durationSeconds: input.durationSeconds,
      sourceText: input.sourceText,
      spokenText: input.spokenText,
      ssml: input.ssml as string[],
      inputMode: input.inputMode as CloneSpeechHarnessPreviewTrack['inputMode'],
      words: input.words as CloneSpeechHarnessWord[],
      chunks: input.chunks as CloneSpeechHarnessChunk[],
    };
  });
  return tracks.every((track) => track !== undefined)
    ? (tracks as readonly NarrationSpeechPreviewTrack[])
    : undefined;
}

function isPreviewChunk(value: unknown): value is CloneSpeechHarnessChunk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const chunk = value as Record<string, unknown>;
  return (
    isBase64(chunk.dataBase64) &&
    typeof chunk.durationSeconds === 'number' &&
    Number.isFinite(chunk.durationSeconds) &&
    chunk.durationSeconds > 0 &&
    chunk.durationSeconds <= 600 &&
    typeof chunk.offsetSeconds === 'number' &&
    Number.isFinite(chunk.offsetSeconds) &&
    chunk.offsetSeconds >= 0 &&
    typeof chunk.alignmentTranscript === 'string' &&
    chunk.alignmentTranscript.length > 0 &&
    chunk.alignmentTranscript.length <= 600 &&
    Array.isArray(chunk.sourceUnits) &&
    chunk.sourceUnits.length > 0 &&
    chunk.sourceUnits.length <= 600 &&
    chunk.sourceUnits.every(
      (unit: unknown) =>
        typeof unit === 'object' &&
        unit !== null &&
        !Array.isArray(unit) &&
        typeof (unit as Record<string, unknown>).text === 'string' &&
        typeof (unit as Record<string, unknown>).spoken === 'string' &&
        typeof (unit as Record<string, unknown>).atomic === 'boolean',
    )
  );
}

function isPreviewWord(value: unknown): value is CloneSpeechHarnessWord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const word = value as Record<string, unknown>;
  return (
    typeof word.word === 'string' &&
    word.word.length > 0 &&
    typeof word.startTime === 'number' &&
    Number.isFinite(word.startTime) &&
    typeof word.endTime === 'number' &&
    Number.isFinite(word.endTime) &&
    word.startTime >= 0 &&
    word.endTime >= word.startTime
  );
}

function SubtitlePreviewTrack({
  track,
  autoPlay,
}: {
  track: CloneSpeechHarnessPreviewTrack;
  autoPlay: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const asrRequestRef = useRef<AbortController>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(track.durationSeconds ?? 0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(180);
  const [asr, setAsr] = useState<CloneSpeechHarnessAsrResult>();
  const [asrBusy, setAsrBusy] = useState(true);
  const [asrError, setAsrError] = useState(false);
  const [alignedWords, setAlignedWords] = useState<AlignedPreviewWord[]>([]);
  const [alignmentSummary, setAlignmentSummary] = useState<{
    blocks: number;
    fallbackChunks: number;
    failedChunks: number;
  }>();
  const words = track.words ?? EMPTY_WORDS;
  const asrWords = asr?.words ?? EMPTY_WORDS;
  const activeWord = words.findIndex((word) => time >= word.startTime && time < word.endTime);
  const activeAsrWord = asrWords.findIndex((word) => time >= word.startTime && time < word.endTime);
  const activeAlignedWord = alignedWords.findIndex(
    (word) => time >= word.startTime && time < word.endTime,
  );
  const previousWord = [...words].reverse().find((word) => word.endTime <= time);
  const nextWord = words.find((word) => word.startTime > time);
  const previousAsrWord = [...asrWords].reverse().find((word) => word.endTime <= time);
  const nextAsrWord = asrWords.find((word) => word.startTime > time);
  const timelineEnd = Math.max(
    duration,
    words.at(-1)?.endTime ?? 0,
    asrWords.at(-1)?.endTime ?? 0,
    alignedWords.at(-1)?.endTime ?? 0,
    1,
  );
  const timelineWidth = Math.ceil((timelineEnd + 0.5) * pixelsPerSecond);
  const cueLayout = useMemo(
    () => layoutSubtitleCues(words, pixelsPerSecond),
    [words, pixelsPerSecond],
  );
  const asrLayout = useMemo(
    () => layoutSubtitleCues(asrWords, pixelsPerSecond),
    [asrWords, pixelsPerSecond],
  );
  const alignedLayout = useMemo(
    () => layoutSubtitleCues(alignedWords, pixelsPerSecond),
    [alignedWords, pixelsPerSecond],
  );
  const nativeLaneHeight = cueLayout.laneCount * 32 + 8;
  const asrLaneHeight = asrLayout.laneCount * 32 + 8;
  const alignedLaneHeight = alignedLayout.laneCount * 32 + 8;

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (audioRef.current) setTime(audioRef.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    if (!playing || scrollerRef.current === null) return;
    const scroller = scrollerRef.current;
    const playheadX = time * pixelsPerSecond;
    const margin = Math.min(120, scroller.clientWidth * 0.2);
    if (playheadX > scroller.scrollLeft + scroller.clientWidth - margin) {
      scroller.scrollLeft = Math.max(0, playheadX - scroller.clientWidth + margin);
    } else if (playheadX < scroller.scrollLeft + margin) {
      scroller.scrollLeft = Math.max(0, playheadX - margin);
    }
  }, [time, pixelsPerSecond, playing]);

  const seek = (seconds: number) => {
    if (audioRef.current === null) return;
    audioRef.current.currentTime = Math.max(
      0,
      Math.min(seconds, audioRef.current.duration || timelineEnd),
    );
    setTime(audioRef.current.currentTime);
  };

  const runAsr = async () => {
    if (asrRequestRef.current !== null) return;
    const request = new AbortController();
    asrRequestRef.current = request;
    setAsrBusy(true);
    setAsrError(false);
    setAsr(undefined);
    setAlignedWords([]);
    setAlignmentSummary(undefined);
    let recognized: CloneSpeechHarnessAsrResult | undefined;
    try {
      const response = await fetch('/asr', {
        body: JSON.stringify({ dataBase64: track.dataBase64 }),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        method: 'POST',
        signal: request.signal,
      });
      const value = await readJsonRecord(response);
      if (
        !response.ok ||
        typeof value.text !== 'string' ||
        typeof value.elapsedMs !== 'number' ||
        !Array.isArray(value.words) ||
        !value.words.every(isPreviewWord)
      )
        throw new Error('ASR comparison failed');
      recognized = {
        text: value.text,
        elapsedMs: value.elapsedMs,
        words: value.words as CloneSpeechHarnessWord[],
      };
      if (!request.signal.aborted) setAsr(recognized);
    } catch {
      if (!request.signal.aborted) setAsrError(true);
    }
    try {
      const resolved: AlignedPreviewWord[] = [];
      let blocks = 0;
      let fallbackChunks = 0;
      let failedChunks = 0;
      for (const chunk of track.chunks ?? []) {
        request.signal.throwIfAborted();
        const chunkEnd = chunk.offsetSeconds + chunk.durationSeconds;
        const chunkAsrWords = (recognized?.words ?? [])
          .filter((word) => {
            const center = (word.startTime + word.endTime) / 2;
            return center >= chunk.offsetSeconds && center < chunkEnd;
          })
          .map((word) => ({
            word: word.word,
            startTime: Math.max(0, word.startTime - chunk.offsetSeconds),
            endTime: Math.min(chunk.durationSeconds, word.endTime - chunk.offsetSeconds),
          }));
        const candidate = alignAsrChunk(
          chunk.sourceUnits,
          chunkAsrWords,
          chunk.offsetSeconds,
          chunk.durationSeconds,
        );
        if (!candidate.fallback) {
          blocks += candidate.blockCount;
          resolved.push(...candidate.words);
          continue;
        }
        fallbackChunks += 1;
        try {
          const response = await fetch('/align', {
            body: JSON.stringify({
              dataBase64: chunk.dataBase64,
              transcript: chunk.alignmentTranscript,
            }),
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            method: 'POST',
            signal: request.signal,
          });
          const value = await readJsonRecord(response);
          if (!response.ok || !Array.isArray(value.words) || !value.words.every(isPreviewWord)) {
            throw new Error('Seed alignment failed');
          }
          const projected = alignSeedChunk(
            chunk.sourceUnits,
            value.words as CloneSpeechHarnessWord[],
            chunk.offsetSeconds,
            chunk.durationSeconds,
          );
          if (projected === undefined) throw new Error('Seed alignment mismatch');
          resolved.push(...projected);
        } catch (error) {
          if (request.signal.aborted) throw error;
          failedChunks += 1;
        }
      }
      if (!request.signal.aborted) {
        setAlignedWords(resolved);
        setAlignmentSummary({ blocks, fallbackChunks, failedChunks });
      }
    } catch {
      if (!request.signal.aborted)
        setAlignmentSummary({ blocks: 0, fallbackChunks: 0, failedChunks: 1 });
    } finally {
      if (asrRequestRef.current === request) {
        asrRequestRef.current = null;
        setAsrBusy(false);
      }
    }
  };

  useEffect(() => {
    asrRequestRef.current?.abort();
    asrRequestRef.current = null;
    void runAsr();
    return () => asrRequestRef.current?.abort();
  }, [track.dataBase64]);
  return (
    <div className="clone-speech-harness__track">
      <div className="clone-speech-harness__track-heading">
        <strong>{track.label}</strong>
        <span>
          {words.length} 个原生字幕片段 · {formatTime(time)} / {formatTime(duration)}
        </span>
      </div>
      <audio
        aria-label={`${track.label}试听`}
        autoPlay={autoPlay}
        controls
        onDurationChange={(event) =>
          setDuration(event.currentTarget.duration || track.durationSeconds || 0)
        }
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onSeeked={(event) => setTime(event.currentTarget.currentTime)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        ref={audioRef}
        src={`data:${track.contentType};base64,${track.dataBase64}`}
      />
      <div className="clone-speech-harness__asr-actions">
        <button disabled={asrBusy} onClick={() => void runAsr()} type="button">
          {asrBusy ? (
            <LoaderCircle aria-hidden="true" size={14} />
          ) : (
            <ScanText aria-hidden="true" size={14} />
          )}
          {asrBusy ? '自动对齐中…' : asr === undefined ? '重试自动对齐' : '重新对齐'}
        </button>
        {asr === undefined ? null : (
          <span>
            ASR Fast · {asr.words.length} 片段 · {asr.elapsedMs} ms
          </span>
        )}
        {asrError ? <span role="alert">ASR 识别失败，请重试。</span> : null}
        {alignmentSummary === undefined ? null : (
          <span>
            对齐结果 · ASR 块 {alignmentSummary.blocks} · Seed 回退{' '}
            {alignmentSummary.fallbackChunks} 片
            {alignmentSummary.failedChunks > 0
              ? ` · 未对齐 ${alignmentSummary.failedChunks} 片`
              : ''}
          </span>
        )}
      </div>
      <div className="clone-speech-harness__transcripts">
        <div>
          <h3>原稿</h3>
          <p>{track.sourceText}</p>
        </div>
        <div>
          <h3>原生字幕</h3>
          {words.length === 0 ? (
            <p className="clone-speech-harness__empty">供应商没有返回字幕</p>
          ) : (
            <p aria-label="原生字幕" className="clone-speech-harness__subtitle-text">
              {words.map((word) => word.word).join('')}
            </p>
          )}
        </div>
        {asr === undefined ? null : (
          <div>
            <h3>ASR Fast 识别稿</h3>
            <p>{asr.text || '未识别到语音'}</p>
          </div>
        )}
      </div>
      {asr === undefined || words.length === 0 || asrWords.length === 0 ? null : (
        <p className="clone-speech-harness__offsets">
          原生 − ASR：首字起点 {signedSeconds(words[0]!.startTime - asrWords[0]!.startTime)} ·
          末字终点 {signedSeconds(words.at(-1)!.endTime - asrWords.at(-1)!.endTime)}
        </p>
      )}
      {words.length === 0 && asrWords.length === 0 && alignedWords.length === 0 ? null : (
        <div className="clone-speech-harness__timeline">
          <div className="clone-speech-harness__timeline-header">
            <strong>字幕时间轴</strong>
            <span aria-live="off" className={activeWord < 0 ? 'is-gap' : ''}>
              原生 ·{' '}
              {words.length === 0
                ? '无字幕'
                : activeWord >= 0
                  ? `${words[activeWord]!.word} · ${formatTime(words[activeWord]!.startTime)}–${formatTime(words[activeWord]!.endTime)}`
                  : `字幕空档 · ${formatTime(previousWord?.endTime ?? 0)}–${formatTime(nextWord?.startTime ?? timelineEnd)}`}
            </span>
            {asr === undefined ? null : (
              <span aria-live="off" className={activeAsrWord < 0 ? 'is-gap' : ''}>
                ASR ·{' '}
                {asrWords.length === 0
                  ? '无识别词'
                  : activeAsrWord >= 0
                    ? `${asrWords[activeAsrWord]!.word} · ${formatTime(asrWords[activeAsrWord]!.startTime)}–${formatTime(asrWords[activeAsrWord]!.endTime)}`
                    : `字幕空档 · ${formatTime(previousAsrWord?.endTime ?? 0)}–${formatTime(nextAsrWord?.startTime ?? timelineEnd)}`}
              </span>
            )}
            {alignmentSummary === undefined ? null : (
              <span aria-live="off" className={activeAlignedWord < 0 ? 'is-gap' : ''}>
                对齐 ·{' '}
                {activeAlignedWord >= 0
                  ? `${alignedWords[activeAlignedWord]!.word} · ${formatTime(alignedWords[activeAlignedWord]!.startTime)}–${formatTime(alignedWords[activeAlignedWord]!.endTime)}`
                  : alignedWords.length === 0
                    ? '无可靠对齐'
                    : '字幕空档'}
              </span>
            )}
            <label>
              速度
              <select
                aria-label={`${track.label}播放速度`}
                onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
                value={playbackRate}
              >
                <option value={0.5}>0.5×</option>
                <option value={0.75}>0.75×</option>
                <option value={1}>1×</option>
              </select>
            </label>
            <label>
              缩放
              <select
                aria-label={`${track.label}时间轴缩放`}
                onChange={(event) => setPixelsPerSecond(Number(event.currentTarget.value))}
                value={pixelsPerSecond}
              >
                <option value={120}>小</option>
                <option value={180}>中</option>
                <option value={240}>大</option>
              </select>
            </label>
          </div>
          <div className="clone-speech-harness__timeline-body">
            <div className="clone-speech-harness__timeline-labels">
              <span>时间</span>
              <span style={{ height: nativeLaneHeight }}>原生</span>
              {asr === undefined ? null : <span style={{ height: asrLaneHeight }}>ASR Fast</span>}
              {alignmentSummary === undefined ? null : (
                <span style={{ height: alignedLaneHeight }}>对齐结果</span>
              )}
            </div>
            <div className="clone-speech-harness__timeline-scroller" ref={scrollerRef}>
              <div
                aria-label={`${track.label}字幕时间轴`}
                className="clone-speech-harness__timeline-canvas"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('button')) return;
                  seek(
                    (event.clientX - event.currentTarget.getBoundingClientRect().left) /
                      pixelsPerSecond,
                  );
                }}
                role="presentation"
                style={{
                  width: timelineWidth,
                  ['--timeline-second-width' as string]: `${pixelsPerSecond}px`,
                }}
              >
                <div className="clone-speech-harness__timeline-ruler">
                  {Array.from({ length: Math.ceil(timelineEnd) + 1 }, (_, second) => (
                    <span key={second} style={{ left: second * pixelsPerSecond }}>
                      {second}s
                    </span>
                  ))}
                </div>
                <div
                  className="clone-speech-harness__timeline-lanes"
                  style={{ height: nativeLaneHeight }}
                >
                  {cueLayout.cues.map(({ word, index, lane, width }) => (
                    <button
                      aria-label={`${word.word} ${formatTime(word.startTime)} 至 ${formatTime(word.endTime)}`}
                      aria-current={activeWord === index ? 'true' : undefined}
                      className={`clone-speech-harness__timeline-cue${activeWord === index ? ' is-current' : ''}`}
                      key={`${index}-${word.startTime}`}
                      onClick={() => seek(word.startTime)}
                      style={{
                        left: word.startTime * pixelsPerSecond,
                        top: lane * 32 + 4,
                        width,
                        ['--cue-duration' as string]: `${Math.max(2, (word.endTime - word.startTime) * pixelsPerSecond)}px`,
                      }}
                      title={`${word.word} · ${formatTime(word.startTime)}–${formatTime(word.endTime)}`}
                      type="button"
                    >
                      {word.word}
                    </button>
                  ))}
                </div>
                {asr === undefined ? null : (
                  <div
                    className="clone-speech-harness__timeline-lanes is-asr"
                    style={{ height: asrLaneHeight }}
                  >
                    {asrLayout.cues.map(({ word, index, lane, width }) => (
                      <button
                        aria-label={`ASR ${word.word} ${formatTime(word.startTime)} 至 ${formatTime(word.endTime)}`}
                        aria-current={activeAsrWord === index ? 'true' : undefined}
                        className={`clone-speech-harness__timeline-cue is-asr${activeAsrWord === index ? ' is-current' : ''}`}
                        key={`${index}-${word.startTime}`}
                        onClick={() => seek(word.startTime)}
                        style={{
                          left: word.startTime * pixelsPerSecond,
                          top: lane * 32 + 4,
                          width,
                          ['--cue-duration' as string]: `${Math.max(2, (word.endTime - word.startTime) * pixelsPerSecond)}px`,
                        }}
                        title={`ASR ${word.word} · ${formatTime(word.startTime)}–${formatTime(word.endTime)}`}
                        type="button"
                      >
                        {word.word}
                      </button>
                    ))}
                  </div>
                )}
                {alignmentSummary === undefined ? null : (
                  <div
                    className="clone-speech-harness__timeline-lanes is-aligned"
                    style={{ height: alignedLaneHeight }}
                  >
                    {alignedLayout.cues.map(({ word, index, lane, width }) => {
                      const aligned = word as AlignedPreviewWord;
                      return (
                        <button
                          aria-label={`对齐 ${aligned.word} ${formatTime(aligned.startTime)} 至 ${formatTime(aligned.endTime)} ${aligned.source === 'seed' ? 'Seed 回退' : aligned.block ? 'ASR 块' : 'ASR'}`}
                          aria-current={activeAlignedWord === index ? 'true' : undefined}
                          className={`clone-speech-harness__timeline-cue is-aligned is-${aligned.source}${aligned.block ? ' is-block' : ''}${activeAlignedWord === index ? ' is-current' : ''}`}
                          key={`${index}-${aligned.startTime}`}
                          onClick={() => seek(aligned.startTime)}
                          style={{
                            left: aligned.startTime * pixelsPerSecond,
                            top: lane * 32 + 4,
                            width,
                            ['--cue-duration' as string]: `${Math.max(2, (aligned.endTime - aligned.startTime) * pixelsPerSecond)}px`,
                          }}
                          title={`${aligned.source === 'seed' ? 'Seed 回退' : aligned.block ? 'ASR 块' : 'ASR'} · ${aligned.word} · ${formatTime(aligned.startTime)}–${formatTime(aligned.endTime)}`}
                          type="button"
                        >
                          {aligned.word}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div
                  aria-label={`播放头 ${formatTime(time)}`}
                  className="clone-speech-harness__timeline-playhead"
                  style={{ left: time * pixelsPerSecond }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      <details className="clone-speech-harness__request">
        <summary>{track.inputMode === 'plain_text' ? '发送文本' : 'SSML 与朗读参考'}</summary>
        {track.inputMode === 'plain_text' ? (
          <pre>
            <code>{track.spokenText}</code>
          </pre>
        ) : (
          <>
            <p>
              <strong>朗读参考</strong> {track.spokenText}
            </p>
            {(track.ssml ?? []).map((part, index) => (
              <pre key={index}>
                <code>{part}</code>
              </pre>
            ))}
          </>
        )}
      </details>
    </div>
  );
}

function layoutSubtitleCues(words: readonly CloneSpeechHarnessWord[], pixelsPerSecond: number) {
  const laneEnds: number[] = [];
  const cues = words.map((word, index) => {
    const left = word.startTime * pixelsPerSecond;
    const width = Math.max(
      28,
      Array.from(word.word).length * 14 + 12,
      (word.endTime - word.startTime) * pixelsPerSecond,
    );
    let lane = laneEnds.findIndex((end) => end + 3 <= left);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = left + width;
    return { word, index, lane, width };
  });
  return { cues, laneCount: Math.max(1, laneEnds.length) };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor((seconds % 1) * 10)}`;
}

function signedSeconds(seconds: number): string {
  return `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(2)}s`;
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function isBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Clone speech harness root is missing.');
createRoot(rootElement).render(<CloneSpeechHarnessApp />);
