import { spawn, type ChildProcess } from 'node:child_process';

import type { Browser } from 'playwright-core';

const GRACEFUL_CLOSE_MS = 750;
const TASKKILL_TIMEOUT_MS = 2_000;

/**
 * Playwright's Windows BrowserServer.kill uses synchronous taskkill, which can
 * block the worker's event loop indefinitely. Only close this capture's child.
 * The promise remains pending until that child exits, so a stuck browser keeps
 * its capture slot instead of allowing unbounded replacement browsers.
 */
export function closeOwnedWindowsChromium(
  child: ChildProcess,
  browser?: Pick<Browser, 'newBrowserCDPSession'>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (!child.pid) return Promise.reject(new Error('GenUI browser process has no owned PID.'));
  const pid = child.pid;
  return new Promise<void>((resolve) => {
    let finished = false;
    let browserExited = false;
    let treeClosed = false;
    let warned = false;
    let helper: ChildProcess | undefined;
    let helperTimer: ReturnType<typeof setTimeout> | undefined;
    const warnRetained = (reason: 'spawn_failed' | 'nonzero_exit' | 'timeout') => {
      if (warned) return;
      warned = true;
      console.warn(
        JSON.stringify({
          event: 'reach_deck_genui_browser_cleanup_incomplete',
          reason,
          ownedPid: pid,
          captureSlotRetained: true,
        }),
      );
    };
    const stopHelper = () => {
      if (helperTimer) clearTimeout(helperTimer);
      if (helper && helper.exitCode === null && helper.signalCode === null) {
        helper.kill('SIGKILL');
      }
    };
    const finish = () => {
      if (finished) return;
      browserExited = true;
      // Let taskkill finish the whole tree before releasing capacity. Stopping
      // it at the root's exit can interrupt renderer cleanup.
      if (helper && !treeClosed) return;
      finished = true;
      clearTimeout(gracefulTimer);
      stopHelper();
      child.removeListener('exit', finish);
      resolve();
    };
    const forceClose = () => {
      if (finished) return;
      // Never discover processes by name or reuse a caller-supplied PID.
      try {
        helper = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        // A failed tree cleanup keeps the capture slot reserved. Killing only
        // the root here could orphan renderers and then admit more browsers.
        helper.once('error', () => warnRetained('spawn_failed'));
        helper.once('exit', (code) => {
          if (helperTimer) clearTimeout(helperTimer);
          treeClosed = code === 0;
          if (!treeClosed) warnRetained('nonzero_exit');
          if (treeClosed && browserExited) finish();
        });
        helperTimer = setTimeout(() => {
          warnRetained('timeout');
          stopHelper();
        }, TASKKILL_TIMEOUT_MS);
      } catch {
        // Keep waiting for this owned browser's exit; never kill unrelated PIDs.
        warnRetained('spawn_failed');
      }
    };
    const gracefulTimer = setTimeout(forceClose, browser ? GRACEFUL_CLOSE_MS : 0);
    child.once('exit', finish);
    // browser.close() on a connected browser only disconnects. CDP Browser.close
    // asks the actual Chromium process to shut down, including its children.
    if (browser) {
      void browser
        .newBrowserCDPSession()
        .then((session) => (finished ? undefined : session.send('Browser.close')))
        .catch(() => undefined);
    }
  });
}
