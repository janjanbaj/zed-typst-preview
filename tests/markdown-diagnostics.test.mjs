import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function session(t, real = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'markdown-diagnostics-'));
  const fake = path.join(dir, 'fake.mjs');
  if (!real) writeFileSync(fake, `#!/usr/bin/env node
let buffer=Buffer.alloc(0);
const send=m=>{const b=Buffer.from(JSON.stringify(m));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]));};
process.stdin.on('end',()=>process.exit(0));process.stdout.on('error',()=>process.exit(0));
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){
 const at=buffer.indexOf('\\r\\n\\r\\n');if(at<0)break;
 const n=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,at).toString())[1]);if(buffer.length<at+4+n)break;
 const m=JSON.parse(buffer.subarray(at+4,at+4+n));buffer=buffer.subarray(at+4+n);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{capabilities:{}}});
 else if(m.method==='textDocument/didOpen'){
  const d=m.params.textDocument;
  if(/\\.zed-math-\\d+\\.typ$/.test(d.uri)){
   const start=d.text.indexOf('nosuchsymbol');const end=start+12;
   const before=d.text.slice(0,start);const line=before.split('\\n').length-1;const character=start-before.lastIndexOf('\\n')-1;
   const diagnostics=start<0?[]:[{message:'unknown variable: nosuchsymbol',severity:1,range:{start:{line,character},end:{line,character:character+end-start}},relatedInformation:[{message:'generated',location:{uri:d.uri,range:{start:{line:0,character:0},end:{line:0,character:1}}}}]}];
   setTimeout(()=>send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,diagnostics}}),100);
  }else send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,diagnostics:[{message:'unmapped preview error',range:{start:{line:0,character:0},end:{line:0,character:2}}}]}});
 }
}});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../proxy.mjs', import.meta.url)), real ? process.env.TINYMIST_TEST_BINARY : fake, '--markdown']);
  const exited = once(child, 'exit');
  let buffer = Buffer.alloc(0), stderr = '';
  const messages = [];
  const send = message => {
    const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]));
  };
  child.stderr.on('data', b => stderr = (stderr + b).slice(-3000));
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const at = buffer.indexOf('\r\n\r\n'); if (at < 0) break;
      const n = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, at).toString())[1]);
      if (buffer.length < at + 4 + n) break;
      const message = JSON.parse(buffer.subarray(at + 4, at + 4 + n));
      buffer = buffer.subarray(at + 4 + n);
      messages.push(message);
      if (message.method && message.id !== undefined) send({ id: message.id,
        result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null });
    }
  });
  t.after(async () => { child.stdin.end(); child.kill(); await exited; rmSync(dir, { recursive: true, force: true }); });
  const until = async predicate => {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out: ' + stderr);
  };
  send({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(dir).href,
    capabilities: { general: { positionEncodings: ['utf-16'] } },
    initializationOptions: { previewProxy: { openBrowser: false } } } });
  await until(() => messages.some(m => m.id === 1));
  send({ method: 'initialized', params: {} });
  const uri = pathToFileURL(path.join(dir, 'notes space.md')).href;
  const open = text => send({ method: 'textDocument/didOpen', params: { textDocument: { uri, text, languageId: 'markdown', version: 1 } } });
  const change = (text, version) => send({ method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
  const close = () => send({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
  const reports = () => messages.filter(m => m.method === 'textDocument/publishDiagnostics').map(m => m.params);
  return { uri, open, change, close, reports, until };
}

test('Markdown diagnostics map to source, clear on edits, and reject unversioned obsolete reports', { timeout: 12000 }, async t => {
  const s = await session(t);
  const bad = '😀 before $ H(nosuchsymbol) $ after';
  s.open(bad);
  await s.until(() => s.reports().some(r => r.diagnostics.length));
  const report = s.reports().find(r => r.diagnostics.length);
  assert.equal(report.uri, s.uri);
  assert.equal(report.version, 1);
  const diagnostic = report.diagnostics[0];
  assert.equal(diagnostic.source, 'Typst math');
  assert.equal(diagnostic.relatedInformation, undefined);
  assert.deepEqual(diagnostic.range, { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } });
  const before = s.reports().length;
  s.change(bad, 2); // Its delayed report must be dropped after the next edit.
  s.change('😀 before $ H(t) $ after', 3);
  await s.until(() => s.reports().slice(before).some(r => r.version === 3));
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(s.reports().slice(before).every(r => !r.diagnostics.length));
  const reopened = s.reports().length;
  s.change(bad, 4); s.close(); s.open('😀 before $ H(t) $ after');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(s.reports().slice(reopened).every(r => !r.diagnostics.length));
  assert.ok(s.reports().every(r => r.uri === s.uri));
  s.close();
});

test('real Tinymist underlines bad padded math in Markdown and clears it when corrected', {
  timeout: 15000, skip: !process.env.TINYMIST_TEST_BINARY && 'Set TINYMIST_TEST_BINARY for real diagnostics'
}, async t => {
  const s = await session(t, true);
  s.open('😀 before $ H(nosuchsymbol) $ after');
  await s.until(() => s.reports().some(r => r.diagnostics.some(d => d.message.includes('nosuchsymbol'))));
  const error = s.reports().flatMap(r => r.diagnostics).find(d => d.message.includes('nosuchsymbol'));
  assert.deepEqual(error.range, { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } });
  s.change('😀 before $ frac( $ after', 2);
  await s.until(() => s.reports().some(r => r.version === 2 && r.diagnostics.length));
  s.change('😀 before $ H(t) $ after', 3);
  await s.until(() => s.reports().some(r => r.version === 3 && !r.diagnostics.length));
  s.close();
});
