import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { native, spawnProxy, stopProxy } from './proxy-launch.mjs';

const options = { timeout: 8000, skip: !native || process.platform === 'win32' };

async function fixture(t, source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'native-transport-'));
  const fake = path.join(dir, 'fake child.mjs');
  const pidFile = path.join(dir, 'pid');
  await writeFile(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
${source}
`, { mode: 0o755 });
  const child = spawnProxy(fake);
  const exited = once(child, 'exit');
  let output = '', stderr = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.on('error', () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { stopProxy(child); await exited; }
    await rm(dir, { recursive: true, force: true });
  });
  let pid;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (!pid) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(pid, stderr);
  return { child, exited, pid, output: () => output, stderr: () => stderr };
}

test('native shutdown reaps a Tinymist process that keeps running after stdin EOF', options, async t => {
  const s = await fixture(t, 'setInterval(() => {}, 1000);');
  s.child.stdin.end();
  assert.deepEqual(await s.exited, [0, null]);
  assert.throws(() => process.kill(s.pid, 0), { code: 'ESRCH' });
});

test('native proxy returns a framed parse error and reaps the child', options, async t => {
  const s = await fixture(t, 'process.stdin.resume();');
  s.child.stdin.write('Content-Length: 1\r\n\r\n{');
  assert.deepEqual(await s.exited, [1, null]);
  const [header, body] = s.output().split('\r\n\r\n');
  assert.equal(header, `Content-Length: ${Buffer.byteLength(body)}`);
  assert.equal(JSON.parse(body).error.code, -32700);
  assert.throws(() => process.kill(s.pid, 0), { code: 'ESRCH' });
});

test('native proxy terminates under output backpressure with a child that never reads', options, async t => {
  const s = await fixture(t, 'setInterval(() => {}, 1000);');
  const payload = JSON.stringify({ jsonrpc: '2.0', method: 'large', params: 'x'.repeat(1024 * 1024) });
  const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
  for (let i = 0; i < 75 && s.child.exitCode === null; i++) {
    const written = await new Promise(resolve => s.child.stdin.write(frame, error => resolve(!error)));
    if (!written) break;
  }
  assert.deepEqual(await s.exited, [1, null]);
  assert.match(s.stderr(), /backlogged|backpressure/);
  assert.throws(() => process.kill(s.pid, 0), { code: 'ESRCH' });
});

test('native proxy terminates under output backpressure with an editor that never reads', options, async t => {
  const s = await fixture(t, `
process.stdin.once('data', async () => {
  const body = JSON.stringify({jsonrpc:'2.0',method:'large',params:'x'.repeat(1024 * 1024)});
  const frame = 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body;
  for (let i = 0; i < 80; i++) {
    await new Promise(resolve => process.stdout.write(frame, resolve));
  }
});
`);
  s.child.stdout.pause();
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'nop' });
  s.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.deepEqual(await s.exited, [1, null]);
  assert.match(s.stderr(), /backlogged|backpressure/);
  assert.throws(() => process.kill(s.pid, 0), { code: 'ESRCH' });
});
