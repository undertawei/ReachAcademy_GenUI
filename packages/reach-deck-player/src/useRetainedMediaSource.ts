import { useEffect, useRef, useState } from 'react';

/** Keep healthy playback on its ticket; failed playback follows every later replacement ticket. */
export function useRetainedMediaSource(
  src: string | undefined,
  playing: boolean,
  identity: string,
) {
  const [held, setHeld] = useState({ identity, src, released: false, retryRevision: 0 });
  const displayed = useRef(src);
  const source = held.identity === identity && !held.released && src !== undefined ? held.src : src;
  displayed.current = source;
  useEffect(() => {
    if (!playing || held.identity !== identity || source === undefined || src === undefined)
      setHeld((current) =>
        current.identity === identity && current.src === src
          ? current
          : { ...current, identity, src },
      );
  }, [held.identity, identity, playing, source, src]);
  const adoptLatest = () =>
    setHeld((current) =>
      current.identity === identity && current.released
        ? current
        : { ...current, identity, released: true, retryRevision: current.retryRevision + 1 },
    );
  const markHealthy = (loadedSrc: string) => {
    if (displayed.current !== loadedSrc) return;
    setHeld((current) =>
      current.identity === identity && current.src === loadedSrc && !current.released
        ? current
        : { ...current, identity, src: loadedSrc, released: false },
    );
  };
  return { source, adoptLatest, markHealthy, retryRevision: held.retryRevision };
}
