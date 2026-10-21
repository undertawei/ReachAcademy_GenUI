import { useEffect, useRef } from 'react';

/** A short buffering gap or seek must not rotate a healthy signed media source. */
export function useMediaStallRecovery(
  recover: (media: HTMLMediaElement) => void,
  identity: string,
) {
  const recoverRef = useRef(recover);
  recoverRef.current = recover;
  const timers = useRef(new Map<HTMLMediaElement, ReturnType<typeof setTimeout>>());
  const cancel = (media: HTMLMediaElement) => {
    const timer = timers.current.get(media);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(media);
  };
  const cancelAll = () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  };
  useEffect(() => {
    cancelAll();
    return cancelAll;
  }, [identity]);
  const arm = (media: HTMLMediaElement) => {
    if (timers.current.has(media) || media.paused || media.ended) return;
    const position = media.currentTime;
    const source = media.getAttribute('src');
    timers.current.set(
      media,
      setTimeout(() => {
        timers.current.delete(media);
        if (
          media.paused ||
          media.ended ||
          media.getAttribute('src') !== source ||
          media.currentTime > position + 0.05
        )
          return;
        recoverRef.current(media);
      }, 8_000),
    );
  };
  return { arm, cancel };
}
