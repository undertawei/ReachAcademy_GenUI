import { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
}));

import { closeOwnedWindowsChromium } from '../../lib/reach-deck/genui-browser-cleanup.js';

function processStub(pid = 4321) {
  return Object.assign(new ChildProcess(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
}

describe('owned Windows Chromium cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes the real browser through CDP and waits for its process exit', async () => {
    const child = processStub();
    const send = vi.fn(async () => undefined);
    const browser = { newBrowserCDPSession: vi.fn(async () => ({ send })) };
    let closed = false;
    const operation = closeOwnedWindowsChromium(child as ChildProcess, browser as any).then(
      () => (closed = true),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledWith('Browser.close');
    expect(closed).toBe(false);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await operation;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses asynchronous tree cleanup for exactly its owned PID when CDP does not respond', async () => {
    const child = processStub();
    const helper = processStub(9999);
    spawn.mockReturnValue(helper);
    const browser = { newBrowserCDPSession: () => new Promise(() => {}) };
    const operation = closeOwnedWindowsChromium(child as ChildProcess, browser as any);
    await vi.advanceTimersByTimeAsync(751);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('taskkill.exe', ['/pid', '4321', '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(helper.kill).not.toHaveBeenCalled();
    helper.exitCode = 0;
    helper.emit('exit', 0, null);
    await operation;
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it('bounds a stuck taskkill helper without releasing an unclosed browser', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = processStub();
    const helper = processStub(9999);
    spawn.mockReturnValue(helper);
    let closed = false;
    const operation = closeOwnedWindowsChromium(child as ChildProcess).then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(closed).toBe(false);
    // Killing only the root could orphan its renderers; reserve capacity instead.
    expect(child.kill).not.toHaveBeenCalled();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    helper.signalCode = 'SIGKILL';
    helper.emit('exit', null, 'SIGKILL');
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warning.mock.calls[0]![0])).toEqual({
      event: 'reach_deck_genui_browser_cleanup_incomplete',
      reason: 'timeout',
      ownedPid: 4321,
      captureSlotRetained: true,
    });
    void operation;
  });

  it('handles a missing taskkill without treating an active browser as closed', async () => {
    const child = processStub();
    const helper = processStub(9999);
    spawn.mockReturnValue(helper);
    let closed = false;
    const operation = closeOwnedWindowsChromium(child as ChildProcess).then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(1);
    helper.emit('error', new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(closed).toBe(false);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(closed).toBe(false);
    void operation;
  });

  it('does not target a PID again after the owned process has exited', async () => {
    const child = processStub();
    child.exitCode = 0;
    await closeOwnedWindowsChromium(child as ChildProcess);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(spawn).not.toHaveBeenCalled();
  });
});
