import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const binary = process.env.PROXY_TEST_BINARY;
const tinymist = process.env.TINYMIST_TEST_BINARY;
if (!binary || !tinymist || process.platform !== 'darwin') {
  throw new Error('Use macOS and set PROXY_TEST_BINARY and TINYMIST_TEST_BINARY to absolute paths.');
}

const nodeProxy = fileURLToPath(new URL('../proxy.mjs', import.meta.url));
const sample = '# Proxy benchmark\n\n' + 'Public fixture. The quick brown fox jumps over the lazy dog. '.repeat(1650);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const rss = pid => Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());

async function run(mode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'proxy-rss-'));
  const uri = pathToFileURL(path.join(dir, 'sample.md')).href;
  const child = mode === 'rust'
    ? spawn(binary, ['--tinymist', tinymist, '--markdown'])
    : spawn(process.execPath, [nodeProxy, tinymist, '--markdown']);
  const exited = once(child, 'exit');
  let buffer = Buffer.alloc(0), stderr = '', sequence = 0;
  const pending = new Map();
  function write(msg) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  child.stderr.on('data', bytes => stderr = (stderr + bytes).slice(-4000));
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (true) {
      const i = buffer.indexOf('\r\n\r\n');
      if (i < 0) return;
      const n = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, i).toString())[1]);
      if (buffer.length < i + 4 + n) return;
      const m = JSON.parse(buffer.subarray(i + 4, i + 4 + n));
      buffer = buffer.subarray(i + 4 + n);
      if (m.method && m.id !== undefined) {
        write({ id: m.id, result: m.method === 'workspace/configuration' ? m.params.items.map(() => ({})) : null });
      } else if (!m.method) {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      }
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: ${stderr}`)); }, 8000);
      pending.set(id, m => { clearTimeout(timer); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); });
      write({ method, params, id });
    });
  }
  try {
    await request('initialize', {
      rootUri: pathToFileURL(dir).href, capabilities: { general: { positionEncodings: ['utf-16'] } },
      initializationOptions: { previewProxy: { openBrowser: false } },
    });
    write({ method: 'initialized', params: {} });
    write({ method: 'textDocument/didOpen', params: { textDocument: { uri, version: 1, languageId: 'markdown', text: '$frac(1, 2)$\n\n' + sample } } });
    const start = performance.now();
    let listener;
    const pid = Number(execFileSync('/usr/bin/pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n')[0]);
    while (!listener && performance.now() - start < 8000) {
      await sleep(100);
      const listeners = (() => {
        try { return execFileSync('/usr/sbin/lsof', ['-anP', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }); }
        catch (err) { if (err.status !== 1) throw err; return ''; }
      })();
      const port = /^n127\.0\.0\.1:(\d+)$/m.exec(listeners)?.[1];
      if (port) {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
        if (response?.ok && response.headers.get('content-type')?.includes('text/html')) listener = port;
        await response?.body?.cancel();
      }
    }
    if (!listener) throw new Error(`Preview HTTP endpoint unavailable: ${stderr}`);
    const previewMs = performance.now() - start;
    await sleep(1000);
    const idle = { proxy: rss(child.pid), tinymist: rss(pid) };
    const latency = [];
    const active = { proxy: 0, tinymist: 0 };
    for (let i = 0; i < 30; i++) {
      write({ method: 'textDocument/didChange', params: { textDocument: { uri, version: i + 2 },
        contentChanges: [{ text: `$fr$\n\n${sample}\n\nRevision ${i}\n` }] } });
      await sleep(25);
      const at = performance.now();
      const completion = await request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 3 } });
      if (!completion?.items?.some(item => item.label === 'frac')) throw new Error(`Expected frac completion in ${mode} at revision ${i + 2}: ${JSON.stringify(completion).slice(0, 350)}\n${stderr}`);
      latency.push(performance.now() - at);
      if (i % 5 === 4) {
        active.proxy = Math.max(active.proxy, rss(child.pid));
        active.tinymist = Math.max(active.tinymist, rss(pid));
      }
    }
    write({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    await sleep(500);
    return { mode, idle, active, afterClose: { proxy: rss(child.pid), tinymist: rss(pid) },
      previewMs, medianMs: percentile(latency, 0.5), p95Ms: percentile(latency, 0.95) };
  } finally {
    child.stdin.end();
    if (mode === 'node') child.kill();
    const deadline = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(deadline);
    await rm(dir, { recursive: true, force: true });
  }
}

for (let pair = 0; pair < 5; pair++) {
  for (const mode of pair % 2 ? ['rust', 'node'] : ['node', 'rust']) {
    console.log(JSON.stringify({ pair: pair + 1, ...await run(mode) }));
  }
}
