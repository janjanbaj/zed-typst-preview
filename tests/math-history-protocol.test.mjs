import { spawnProxy, stopProxy } from './proxy-launch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const markdown of [false, true]) {
  test(`${markdown ? 'Markdown' : 'Typst'} history travels through real proxy stdio`, { timeout: 12000 }, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'typst-history-'));
    const log = path.join(dir, 'input.jsonl');
    const fake = path.join(dir, 'fake.mjs');
    writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let buffer=Buffer.alloc(0), completionCount=0;
const send=m=>{const body=Buffer.from(JSON.stringify(m));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body]));};
process.stdin.on('end',()=>process.exit(0));
process.stdout.on('error',()=>process.exit(0));
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]);
 while(true){
  const start=buffer.indexOf('\\r\\n\\r\\n');if(start<0)break;
  const length=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,start).toString())[1]);
  if(buffer.length<start+4+length)break;
  const m=JSON.parse(buffer.subarray(start+4,start+4+length));buffer=buffer.subarray(start+4+length);
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
  if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{capabilities:{textDocumentSync:2,completionProvider:{resolveProvider:true}}}});
  else if(m.method==='textDocument/completion'){const fail=++completionCount===2;setTimeout(()=>send({jsonrpc:'2.0',id:m.id,...(fail?{error:{code:-32603,message:'compile error'}}:{result:{items:[{label:'frac',insertText:'frac(1, 2)'}]}})}),60);}
  else if(m.method==='completionItem/resolve')send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'history should not resolve here'}});
  else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:null});
 }
});
`, { mode: 0o755 });
    const child = spawnProxy(fake, markdown);
    let output = Buffer.alloc(0), stderr = '';
    const messages = [];
    const exited = once(child, 'exit');
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdout.on('data', chunk => {
      output = Buffer.concat([output, chunk]);
      while (true) {
        const start = output.indexOf('\r\n\r\n'); if (start < 0) break;
        const length = Number(/Content-Length: (\d+)/i.exec(output.subarray(0, start).toString())[1]);
        if (output.length < start + 4 + length) break;
        messages.push(JSON.parse(output.subarray(start + 4, start + 4 + length)));
        output = output.subarray(start + 4 + length);
      }
    });
    t.after(async () => { stopProxy(child); await exited; rmSync(dir, { recursive: true, force: true }); });
    const send = message => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
      child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    };
    const until = async predicate => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.fail('Timed out: ' + stderr);
    };
    const records = () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
    const answer = async id => { await until(() => messages.some(m => m.id === id)); return messages.find(m => m.id === id); };
    const uri = new URL(`file://${dir}/notes space.${markdown ? 'md' : 'typ'}`).href;
    const text = '$cal(H) + E_(n)^2 + alpha_i + alpha_i$\r\n😀 $al$';
    const request = id => send({ id, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 1, character: 6 } } });
    const open = (value, version = 1) => send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: markdown ? 'markdown' : 'typst', text: value, version } } });
    const close = () => send({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    send({ id: 1, method: 'initialize', params: { initializationOptions: { previewProxy: { openBrowser: false } } } });
    await answer(1);
    open(text);
    request(10);
    const result = (await answer(10)).result;
    const item = result.items.find(i => i.label === 'alpha_i');
    assert.ok(item);
    assert.equal(item.textEdit.newText, 'alpha_i');
    assert.deepEqual(item.textEdit.range, { start: { line: 1, character: 4 }, end: { line: 1, character: 6 } });
    assert.equal(item.detail, 'Math history · 2 uses');
    assert.ok(result.items.some(i => i.label === 'frac'));
    assert.equal(result.isIncomplete, true);
    send({ id: 12, method: 'completionItem/resolve', params: item });
    assert.deepEqual((await answer(12)).result, item);
    assert.ok(!records().some(m => m.method === 'completionItem/resolve'));
    request(11);
    assert.ok((await answer(11)).result.items.some(i => i.label === 'alpha_i'));
    // Incremental UTF-16 edit: al -> ca, with an emoji earlier on the same line.
    send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 6 } }, text: 'ca' }] } });
    request(13);
    assert.ok((await answer(13)).result.items.some(i => i.label === 'cal(H)'));
    // A late result cannot leak the previous document's history into a reopened version 1.
    request(14);
    await until(() => records().filter(m => m.method === 'textDocument/completion').length === 4);
    close(); open('No old symbols\r\n😀 $al$', 1);
    assert.equal((await answer(14)).result, null);
    request(15);
    assert.ok(!(await answer(15)).result.items.some(i => i.label === 'alpha_i'));
    send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'Plain al' }] } });
    send({ id: 16, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 8 } } });
    const outside = (await answer(16)).result;
    if (markdown) assert.equal(outside, null);
    else assert.deepEqual(outside.items.map(i => i.label), ['frac']);
    close();
  });
}
