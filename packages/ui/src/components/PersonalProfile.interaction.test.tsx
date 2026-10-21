// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalProfileEditor, usePersonalProfile, type PersonalProfile } from './PersonalProfile';
import { prepareProfileImage } from '../profile-image';

vi.mock('../profile-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../profile-image')>()),
  prepareProfileImage: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original: PersonalProfile = {
  username: 'learner',
  displayName: 'Original',
  avatarRevision: 'a'.repeat(64),
  lockVersion: '1',
};
const t = (key: string) => key;
const fetcher = vi.fn<typeof fetch>();
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
function nickname() {
  return document.querySelector<HTMLInputElement>(
    'input:not([readonly]):not([type=file]):not([type=range])',
  )!;
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      nickname(),
      value,
    );
    nickname().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('personal profile editor', () => {
  let root: Root;
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onProfile = vi.fn();
  function render(latest: PersonalProfile = original) {
    root.render(
      <PersonalProfileEditor
        latest={latest}
        loadError={false}
        onReload={async () => latest}
        onProfile={onProfile}
        onMutation={() => {}}
        onClose={onClose}
        onSaved={onSaved}
        returnFocusTarget={{ current: trigger }}
        t={t}
      />,
    );
  }
  beforeEach(() => {
    vi.clearAllMocks();
    fetcher.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    trigger.remove();
    document.querySelector('[data-rx-portal-root]')?.replaceChildren();
    vi.unstubAllGlobals();
  });
  it('shows read-only username and closes an unchanged dialog directly', async () => {
    await act(async () => render());
    expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('learner');
    expect(document.activeElement).toBe(nickname());
    await click('profile.cancel');
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates changed nickname, trims edge ASCII spaces and preserves the server username', async () => {
    await act(async () => render());
    await type('Name🙂');
    await click('profile.save');
    expect(document.body.textContent).toContain('profile.nameInvalid');
    expect(fetcher).not.toHaveBeenCalled();
    await type('  新 名-2  ');
    fetcher.mockResolvedValueOnce(
      Response.json({ data: { ...original, displayName: '新 名-2', lockVersion: '2' } }),
    );
    await click('profile.save');
    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('displayName')).toBe('新 名-2');
    expect(body.get('username')).toBeNull();
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it('asks before discarding, retains a draft when declined and restores focus to the persistent trigger', async () => {
    await act(async () => render());
    await type('Draft');
    await click('profile.cancel');
    expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await click('profile.keepEditing');
    expect(nickname().value).toBe('Draft');
    await act(async () => {
      nickname().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    await click('profile.discard');
    expect(onClose).toHaveBeenCalledOnce();
    act(() => root.render(null));
    expect(document.activeElement).toBe(trigger);
  });
  it('keeps restore-default pending until explicit Save and supports a legacy nickname', async () => {
    const legacy = { ...original, displayName: 'Legacy🙂' + 'x'.repeat(120) };
    await act(async () => render(legacy));
    await click('profile.restoreDefault');
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector('.rx-profile-preview img')).toBeNull();
    fetcher.mockResolvedValueOnce(
      Response.json({ data: { ...legacy, avatarRevision: null, lockVersion: '2' } }),
    );
    await click('profile.save');
    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('displayName')).toBeNull();
    expect(body.get('avatarAction')).toBe('default');
  });
  async function selectImage() {
    const file = new File(['original bytes'], 'photo.png', { type: 'image/png' });
    vi.mocked(prepareProfileImage).mockResolvedValueOnce({
      file,
      width: 800,
      height: 600,
      url: 'blob:preview',
    });
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    return file;
  }
  it('previews a square crop and submits the original file only on Save', async () => {
    await act(async () => render());
    const file = await selectImage();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelectorAll('input[type=range]')).toHaveLength(3);
    fetcher.mockResolvedValueOnce(Response.json({ data: { ...original, lockVersion: '2' } }));
    await click('profile.save');
    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('image')).toBe(file);
    expect(body.get('displayName')).toBeNull();
    expect(JSON.parse(String(body.get('crop')))).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    act(() => root.render(null));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
  it('preserves the avatar draft on conflict and adopts a concurrently changed untouched nickname after review', async () => {
    await act(async () => render());
    const file = await selectImage();
    const latest = { ...original, displayName: 'Other device', lockVersion: '2' };
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'profile_conflict', data: latest }, { status: 409 }),
    );
    await click('profile.save');
    expect(nickname().value).toBe('Original');
    expect(button('profile.save').disabled).toBe(true);
    expect(document.body.textContent).toContain('Other device');
    await click('profile.reviewed');
    expect(nickname().value).toBe('Other device');
    fetcher.mockResolvedValueOnce(Response.json({ data: { ...latest, lockVersion: '3' } }));
    await click('profile.save');
    const body = fetcher.mock.calls[1]?.[1]?.body as FormData;
    expect(body.get('image')).toBe(file);
    expect(body.get('displayName')).toBeNull();
    expect(body.get('expectedLockVersion')).toBe('2');
  });
  it('does not overwrite dirty input or advance its version on background refresh', async () => {
    await act(async () => render());
    await type('My edit');
    await act(async () => render({ ...original, displayName: 'New remote', lockVersion: '2' }));
    expect(nickname().value).toBe('My edit');
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'display_name_invalid' }, { status: 400 }),
    );
    await click('profile.save');
    expect((fetcher.mock.calls[0]?.[1]?.body as FormData).get('expectedLockVersion')).toBe('1');
    expect(nickname().value).toBe('My edit');
    expect(onSaved).not.toHaveBeenCalled();
  });
  it('preserves an explicitly changed nickname when reviewing a conflict', async () => {
    await act(async () => render());
    await type('My edit');
    fetcher.mockResolvedValueOnce(
      Response.json(
        { data: { ...original, displayName: 'Remote', lockVersion: '2' } },
        { status: 409 },
      ),
    );
    await click('profile.save');
    await click('profile.reviewed');
    expect(nickname().value).toBe('My edit');
  });
  it('reconciles an uncertain save and requires explicit review before another PUT', async () => {
    await act(async () => render());
    await type('My edit');
    fetcher.mockRejectedValueOnce(new Error('connection lost'));
    fetcher.mockResolvedValueOnce(
      Response.json({ data: { ...original, displayName: 'My edit', lockVersion: '2' } }),
    );
    await click('profile.save');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBeUndefined();
    expect(onSaved).not.toHaveBeenCalled();
    expect(button('profile.save').disabled).toBe(true);
    await click('profile.reviewed');
    expect(nickname().value).toBe('My edit');
  });
  it('keeps a definite avatar storage failure in the editor instead of treating it as uncertain', async () => {
    await act(async () => render());
    await type('My edit');
    fetcher.mockResolvedValueOnce(Response.json({ error: 'profile_unavailable' }, { status: 503 }));
    await click('profile.save');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('profile.saveFailed');
    expect(document.body.textContent).not.toContain('profile.saveUncertain');
    expect(button('profile.save').disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });
  it('single-flights recovery clicks and ignores a delayed response after closing', async () => {
    await act(async () => render());
    await type('My edit');
    fetcher.mockRejectedValueOnce(new Error('save disconnected'));
    fetcher.mockRejectedValueOnce(new Error('read disconnected'));
    await click('profile.save');
    // The shared Button keeps an initially visible spinner for its minimum duration.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    let resolveRead!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const retry = button('profile.checkLatest');
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const signal = fetcher.mock.calls[2]?.[1]?.signal;
    act(() => root.render(null));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveRead(Response.json({ data: { ...original, lockVersion: '2' } })));
    expect(onProfile).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it('refreshes on foreground/path re-entry, deduplicates reads and ignores older versions', async () => {
    let resolveRead!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    function Shell({ route }: { route: string }) {
      const profile = usePersonalProfile({ refreshKey: route, t });
      return (
        <>
          <button ref={profile.triggerRef} onClick={profile.openEditor}>
            Open
          </button>
          <strong>{profile.profile?.displayName}</strong>
          {profile.editor}
        </>
      );
    }
    await act(async () => root.render(<Shell route="one" />));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => resolveRead(Response.json({ data: original })));
    fetcher.mockResolvedValueOnce(
      Response.json({ data: { ...original, displayName: 'Foreground', lockVersion: '2' } }),
    );
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('Foreground');
    fetcher.mockResolvedValueOnce(Response.json({ data: original }));
    await act(async () => root.render(<Shell route="two" />));
    expect(container.textContent).toContain('Foreground');
  });
});
