export interface PressHoldPreviewControllerOptions {
  element: HTMLElement;
  canPreview: () => boolean;
  onPreviewStart: () => void;
  onPreviewEnd: () => void;
}

/**
 * Installs the product's press-and-hold interaction without importing React.
 * The controller deliberately treats preview as a transient gesture: it never
 * dispatches click, submit, or application callbacks.
 */
export function installPressHoldPreview({
  element,
  canPreview,
  onPreviewStart,
  onPreviewEnd,
}: PressHoldPreviewControllerOptions): () => void {
  let active = false;
  let pointerId: number | undefined;

  const end = () => {
    if (!active) return;
    active = false;
    pointerId = undefined;
    element.removeAttribute('data-preview-active');
    onPreviewEnd();
  };

  const start = () => {
    if (active || !canPreview()) return;
    active = true;
    element.setAttribute('data-preview-active', 'true');
    onPreviewStart();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    pointerId = event.pointerId;
    if (event.pointerType !== 'mouse' && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Browsers may reject capture when the control is being removed.
      }
    }
    start();
    event.preventDefault();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (pointerId === event.pointerId) end();
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (pointerId === event.pointerId) end();
  };
  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') end();
  };
  const onLostPointerCapture = (event: PointerEvent) => {
    if (pointerId === event.pointerId) end();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    start();
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      end();
      event.preventDefault();
    }
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);
  element.addEventListener('pointerleave', onPointerLeave);
  element.addEventListener('lostpointercapture', onLostPointerCapture);
  element.addEventListener('keydown', onKeyDown);
  element.addEventListener('keyup', onKeyUp);
  element.addEventListener('blur', end);
  window.addEventListener('blur', end);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);

  return () => {
    end();
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerCancel);
    element.removeEventListener('pointerleave', onPointerLeave);
    element.removeEventListener('lostpointercapture', onLostPointerCapture);
    element.removeEventListener('keydown', onKeyDown);
    element.removeEventListener('keyup', onKeyUp);
    element.removeEventListener('blur', end);
    window.removeEventListener('blur', end);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  };
}
