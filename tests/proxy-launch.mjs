import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const native = Boolean(process.env.PROXY_TEST_BINARY);

export function spawnProxy(tinymist, markdown = false) {
  const flags = markdown ? ['--markdown'] : [];
  return native
    ? spawn(process.env.PROXY_TEST_BINARY, ['--tinymist', tinymist, ...flags])
    : spawn(process.execPath, [fileURLToPath(new URL('../proxy.mjs', import.meta.url)), tinymist, ...flags]);
}

export function stopProxy(child) {
  child.stdin.end();
  if (!native) { child.kill(); return; }
  const timer = setTimeout(() => child.kill(), 3000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}
