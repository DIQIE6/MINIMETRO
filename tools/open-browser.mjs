/**
 * Open a URL in the default browser, on whichever OS this is.
 *
 * Used by the host servers so that double-clicking a launcher is the entire
 * setup: a web page can never start a local server, so the server starts the
 * browser instead.
 */
import { exec } from 'node:child_process';

/** @param {string} url */
export function openUrl(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'win32') {
    // `start` is a cmd builtin, and the empty "" is the window title.
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  return new Promise((resolve) => {
    try {
      exec(cmd, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}
