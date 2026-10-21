// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import {
  LearnerEditor,
  type LearnerEditorProps,
  getClipboardImageFiles,
  prepareLearnerImage,
} from '../src/index';
vi.mock('@tiptap/react', () => ({
  EditorContent: () => createElement('div', { 'data-editor': '', contentEditable: true }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const pasteHTML = vi.fn();
const editor = { commands: { focus: vi.fn() }, view: { pasteHTML } } as unknown as Editor;
let props: LearnerEditorProps;
async function render(overrides: Partial<LearnerEditorProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(<LearnerEditor {...props} />));
}
async function click(label: string) {
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === label)
      ?.click();
  });
}
function paste(data: object) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  container.querySelector('[data-editor]')!.dispatchEvent(event);
  return event;
}
function imageData() {
  const file = new File(['photo'], 'test.png', { type: 'image/png' });
  return {
    items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
    files: [file],
    getData: () => '',
  };
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  props = {
    editor,
    translate: (key) => key,
    options: { formatting: 'basic', math: false, images: true, attachments: false },
    onImages: vi.fn(async () => {}),
  };
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pasteHTML.mockReset();
});
describe('image input contract', () => {
  it('uploads pasted image files exactly once while an upload is pending', async () => {
    let done!: () => void;
    const onImages = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    await render({ onImages });
    await act(async () => {
      expect(paste(imageData()).defaultPrevented).toBe(true);
      paste(imageData());
    });
    expect(onImages).toHaveBeenCalledTimes(1);
    await act(async () => done());
  });
  it.each([
    { disabled: true },
    { busy: true },
    { options: { formatting: 'none', math: false, images: false, attachments: false } },
  ])('blocks binary paste while disabled by %j', async (override) => {
    await render(override as Partial<LearnerEditorProps>);
    await act(async () => {
      expect(paste(imageData()).defaultPrevented).toBe(true);
    });
    expect(props.onImages).not.toHaveBeenCalled();
  });
  it('preserves ordinary Office/text paste and strips unowned HTML images', async () => {
    await render();
    await act(async () => {
      expect(
        paste({ items: [], files: [], getData: () => '<p><b>Office text</b></p>' })
          .defaultPrevented,
      ).toBe(false);
      expect(
        paste({
          items: [],
          files: [],
          getData: () => '<p>hello<img src="data:image/png;base64,123" /></p>',
        }).defaultPrevented,
      ).toBe(true);
    });
    expect(pasteHTML).toHaveBeenCalledWith('<p>hello</p>', expect.any(Event));
  });
  it('falls back to clipboard files when item access yields no file', () => {
    const data = imageData();
    expect(getClipboardImageFiles({ ...data, items: [] } as unknown as DataTransfer)).toEqual(
      data.files,
    );
  });
});
describe('media safety', () => {
  it('uploads image drops through the same owned route', async () => {
    await render();
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: imageData() });
    await act(async () => {
      container.querySelector('[data-editor]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(props.onImages).toHaveBeenCalledTimes(1);
  });
  it('does not upload if the editor is destroyed before normalization finishes', async () => {
    const localEditor = { ...editor, isDestroyed: false } as Editor;
    await render({ editor: localEditor });
    await act(async () => {
      paste(imageData());
      Object.defineProperty(localEditor, 'isDestroyed', { value: true });
    });
    expect(props.onImages).not.toHaveBeenCalled();
  });
  it('holds busy during decoding and cancels when an answer changes on the same editor', async () => {
    let decoded!: () => void;
    const decode = new Promise<void>((resolve) => {
      decoded = resolve;
    });
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 1;
        naturalHeight = 1;
        decode() {
          return decode;
        }
      },
    );
    const OriginalURL = URL;
    vi.stubGlobal(
      'URL',
      class extends OriginalURL {
        static createObjectURL() {
          return 'blob:test';
        }
        static revokeObjectURL() {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect() {},
      drawImage() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['converted'], { type: 'image/jpeg' })),
    );
    const onImages = vi.fn(async () => {});
    const nextImages = vi.fn(async () => {});
    const onBusyChange = vi.fn();
    await render({ contextKey: 'old-answer', onImages, onBusyChange });
    const file = new File(['heic'], 'photo.heic', { type: 'image/heic' });
    await act(async () => {
      paste({
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        files: [],
        getData: () => '',
      });
    });
    expect(onBusyChange).toHaveBeenCalledWith(true);
    await render({ contextKey: 'new-answer', onImages: nextImages });
    await act(async () => decoded());
    expect(onImages).not.toHaveBeenCalled();
    expect(nextImages).not.toHaveBeenCalled();
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('rejects oversized input before attempting decode', async () => {
    const file = new File([''], 'large.heic', { type: 'image/heic' });
    Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });
    await expect(prepareLearnerImage(file)).rejects.toThrow('imageError');
  });
});
describe('camera lifetime', () => {
  function mockPhotoPreview() {
    const OriginalURL = URL;
    vi.stubGlobal(
      'URL',
      class extends OriginalURL {
        static createObjectURL() {
          return 'blob:photo';
        }
        static revokeObjectURL() {}
      },
    );
  }
  async function chooseNativePhoto(file: File) {
    const input = container.querySelector('dialog input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  }
  it('has only upload and photo toolbar actions and offers native capture inside an unavailable camera', async () => {
    await render();
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'uploadImage',
      'takePhoto',
    ]);
    expect(container.querySelector('input[capture]')).toBeNull();
    await click('takePhoto');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('cameraUnavailable');
    expect(container.querySelector('dialog input[capture]')?.getAttribute('capture')).toBe(
      'environment',
    );
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click');
    expect(picker).not.toHaveBeenCalled();
    await click('systemCamera');
    expect(picker).toHaveBeenCalledTimes(1);
    expect(props.onImages).not.toHaveBeenCalled();
  });
  it('previews, retakes and confirms a native photo through the same upload route', async () => {
    mockPhotoPreview();
    await render();
    await click('takePhoto');
    await click('systemCamera');
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.png', { type: 'image/png' });
    await chooseNativePhoto(first);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('photoPreview');
    expect(props.onImages).not.toHaveBeenCalled();
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click');
    await click('retake');
    expect(picker).toHaveBeenCalledTimes(1);
    // Cancelling a retake leaves the native picker available without a false camera spinner.
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'systemCamera',
      ),
    ).toBe(true);
    await chooseNativePhoto(second);
    await click('usePhoto');
    expect(props.onImages).toHaveBeenCalledExactlyOnceWith([second]);
    expect(container.querySelector('dialog')).toBeNull();
  });
  it('captures and retakes a browser photo before confirmation', async () => {
    mockPhotoPreview();
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['photo'], { type: 'image/jpeg' })),
    );
    await render();
    await click('takePhoto');
    async function capture() {
      const video = container.querySelector('video')!;
      Object.defineProperties(video, {
        videoWidth: { value: 640 },
        videoHeight: { value: 480 },
      });
      await act(async () => video.dispatchEvent(new Event('loadeddata', { bubbles: true })));
      await click('capture');
    }
    await capture();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(props.onImages).not.toHaveBeenCalled();
    await click('retake');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await capture();
    await click('usePhoto');
    expect(props.onImages).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ type: 'image/jpeg' }),
    ]);
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it('releases a failed browser preview before opening native capture', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
    });
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error('Cannot play'));
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });
    await render();
    await click('takePhoto');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('cameraError');
    await click('systemCamera');
    expect(picker).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('closes the dialog and releases the old stream when the answer scope changes', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    await render({ contextKey: 'old-answer' });
    await click('takePhoto');
    await render({ contextKey: 'new-answer' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector('dialog')).toBeNull();
    await click('takePhoto');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
  it('cannot use native capture while the editor becomes busy', async () => {
    await render();
    await click('takePhoto');
    await render({ busy: true });
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('input[capture]')).toBeNull();
    expect(props.onImages).not.toHaveBeenCalled();
  });
  it('stops a camera grant resolving after the dialog is closed', async () => {
    let grant!: (media: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    await render();
    await click('takePhoto');
    await click('close');
    const stop = vi.fn();
    await act(async () => grant({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('stops an active stream when disabled, and never requests audio', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    await render();
    await click('takePhoto');
    await render({ disabled: true });
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector('dialog')).toBeNull();
  });
  it('shows a localized permission denial and keeps close available', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        }),
      },
    });
    await render();
    await click('takePhoto');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('cameraDenied');
    await click('close');
    expect(container.querySelector('dialog')).toBeNull();
  });
  it('does not request the camera on an insecure origin', async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    await render();
    await click('takePhoto');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('cameraInsecure');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
