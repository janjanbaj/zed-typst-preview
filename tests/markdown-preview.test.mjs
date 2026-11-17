import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function typstString'), source.indexOf("if (!tinymistArgs.includes"));
const { markdownTypst, editFraction } = vm.runInNewContext(helpers + ';({markdownTypst, editFraction})', { URL });

test('wrapper preserves Markdown escapes and selects native Typst math', () => {
  const text = '# Heading\n$frac(1, 2)$ and \\u1234 "quoted" 😀\r\n\t\0';
  const wrapper = markdownTypst(text);
  assert.ok(wrapper.includes('raw-typst: false'));
  assert.ok(wrapper.includes('math.equation(block: block, eval(source, mode: "math"))'));
  assert.ok(wrapper.includes('\\\\u1234'));
  assert.ok(wrapper.includes('\\u{a}'));
  assert.ok(wrapper.includes('\\u{0}'));
});

test('edit location follows the last change, including deletions and Unicode', () => {
  assert.equal(editFraction('abcdefghij', 'abXdefghij'), 0.3);
  assert.equal(editFraction('abcde', 'abde'), 0.5);
  assert.equal(editFraction('abc', ''), 0);
  assert.equal(editFraction('same', 'same'), null);
  assert.equal(editFraction('😀a tail', '😀b tail'), 3 / 8);
});

test('Markdown lifecycle is virtual, live, and preview-only', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'markdown-preview-'));
  const log = path.join(dir, 'messages.jsonl');
  const fake = path.join(dir, 'fake-tinymist.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let buffer = Buffer.alloc(0);
const documents = new Map();
const send = msg => { const b = Buffer.from(JSON.stringify(msg)); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'), b])); };
process.stdin.on('data', chunk => {
 buffer = Buffer.concat([buffer, chunk]);
 while (true) {
  const i = buffer.indexOf('\\r\\n\\r\\n'); if (i < 0) break;
  const n = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,i).toString())[1]);
  if (buffer.length < i+4+n) break;
  const m = JSON.parse(buffer.subarray(i+4,i+4+n)); buffer=buffer.subarray(i+4+n);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m)+'\\n');
  if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{capabilities:{documentFormattingProvider:true,definitionProvider:true}}});
  if (m.method === 'textDocument/didOpen') documents.set(m.params.textDocument.uri, m.params.textDocument.text);
  if (m.method === 'textDocument/didChange') documents.set(m.params.textDocument.uri, m.params.contentChanges[0].text);
  if (m.params?.command === 'tinymist.exportQuery') {
   const text=documents.get(new URL('file://'+m.params.arguments[0]).href);
   const version=Number(/version: (\\d+)/.exec(text)[1]);
   const data=Buffer.from(JSON.stringify([{version,page:1,x:0,y:1000}])).toString('base64');
   setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{data}}),60);
  }
  if (m.method === 'textDocument/didOpen') {
   send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:m.params.textDocument.uri,diagnostics:[{message:'generated position'}]}});
   send({jsonrpc:'2.0',id:'jump',method:'window/showDocument',params:{uri:m.params.textDocument.uri}});
   send({jsonrpc:'2.0',method:'tinymist/preview/scrollSource',params:{filepath:'/not-a-real-file',start:[0,0]}});
   send({jsonrpc:'2.0',id:'edit',method:'workspace/applyEdit',params:{edit:{changes:{}}}});
  }
 }
});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [new URL('../proxy.mjs', import.meta.url).pathname, fake, '--markdown']);
  let output = Buffer.alloc(0), stderr = '';
  const messages = [];
  child.stderr.on('data', c => stderr += c);
  child.stdout.on('data', chunk => {
    output = Buffer.concat([output, chunk]);
    while (true) {
      const i = output.indexOf('\r\n\r\n'); if (i < 0) break;
      const n = Number(/Content-Length: (\d+)/i.exec(output.subarray(0,i).toString())[1]);
      if (output.length < i+4+n) break;
      messages.push(JSON.parse(output.subarray(i+4,i+4+n))); output = output.subarray(i+4+n);
    }
  });
  t.after(() => { child.stdin.end(); child.kill(); rmSync(dir, { recursive: true, force: true }); });
  const send = msg => { const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...msg})); child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`),b])); };
  const until = async predicate => {
    for (let i=0;i<200;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,20)); }
    assert.fail('Timed out: '+stderr);
  };
  const recorded = () => { try { return readFileSync(log,'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  send({id:1,method:'initialize',params:{initializationOptions:{previewProxy:{openBrowser:false,followCursor:true}}}});
  await until(()=>messages.some(m=>m.id===1));
  const caps=messages.find(m=>m.id===1).result.capabilities;
  assert.equal(caps.textDocumentSync.change,1);
  assert.equal(caps.definitionProvider,undefined);
  assert.equal(caps.documentFormattingProvider,undefined);
  assert.equal(caps.documentHighlightProvider,true);
  assert.deepEqual(caps.executeCommandProvider.commands,['typst-preview.open']);
  const uri='file:///tmp/notes%20space.md';
  send({method:'textDocument/didOpen',params:{textDocument:{uri,languageId:'markdown',version:1,text:'😀 $x$\r\nnext'}}});
  send({method:'textDocument/didChange',params:{textDocument:{uri,version:2},contentChanges:[{range:{start:{line:0,character:3},end:{line:0,character:6}},text:'$y^2$'}]}});
  send({method:'textDocument/didChange',params:{textDocument:{uri,version:3},contentChanges:[{text:'# Changed\n$$frac(1, 2)$$'}]}});
  send({id:2,method:'textDocument/formatting',params:{textDocument:{uri}}});
  send({id:3,method:'textDocument/codeAction',params:{textDocument:{uri}}});
  send({id:4,method:'workspace/executeCommand',params:{command:'typst-preview.syncCursor'}});
  const otherUri='file:///tmp/other.md';
  send({method:'textDocument/didOpen',params:{textDocument:{uri:otherUri,languageId:'markdown',version:1,text:'# Other'}}});
  send({id:5,method:'textDocument/documentHighlight',params:{textDocument:{uri},position:{line:0,character:0}}});
  send({id:6,method:'textDocument/documentHighlight',params:{textDocument:{uri},position:{line:0,character:1}}});
  send({id:7,method:'textDocument/documentHighlight',params:{textDocument:{uri:otherUri},position:{line:0,character:0}}});
  send({id:8,method:'textDocument/documentHighlight',params:{textDocument:{uri:'file:///tmp/unknown.md'},position:{line:0,character:0}}});
  send({method:'textDocument/didClose',params:{textDocument:{uri}}});
  await until(()=>recorded().some(m=>m.method==='textDocument/didClose') && messages.some(m=>m.id===8) && recorded().some(m=>m.id==='edit'));
  const records=recorded();
  const open=records.find(m=>m.method==='textDocument/didOpen').params.textDocument;
  assert.equal(open.uri,uri+'.zed-preview.typ');
  assert.equal(open.languageId,'typst');
  assert.ok(open.text.includes('@preview/cmarker:0.1.8'));
  const changes=records.filter(m=>m.method==='textDocument/didChange');
  assert.equal(changes[0].params.contentChanges[0].text,markdownTypst('😀 $y^2$\r\nnext',2));
  assert.equal(changes[1].params.contentChanges[0].text,markdownTypst('# Changed\n$$frac(1, 2)$$',3));
  assert.equal(records.find(m=>m.id==='jump').result.success,false);
  assert.equal(records.find(m=>m.id==='edit').result.applied,false);
  assert.equal(messages.find(m=>m.id===2).result,null);
  assert.equal(messages.find(m=>m.id===3).result.length,1);
  const focus=records.filter(m=>m.params?.command==='tinymist.focusMain');
  assert.deepEqual(focus.map(m=>m.params.arguments[0]),[
    '/tmp/notes space.md.zed-preview.typ', '/tmp/other.md.zed-preview.typ',
    '/tmp/notes space.md.zed-preview.typ', '/tmp/other.md.zed-preview.typ'
  ]);
  assert.ok(records.indexOf(focus[0]) > records.findIndex(m=>m.method==='textDocument/didOpen'));
  assert.deepEqual(messages.find(m=>m.id===5).result,[]);
  assert.deepEqual(messages.find(m=>m.id===8).result,[]);
  assert.ok(!records.some(m=>m.method==='textDocument/documentHighlight'));
  assert.ok(!records.some(m=>m.params?.command==='tinymist.scrollPreview'));
  assert.ok(!messages.some(m=>m.method==='textDocument/publishDiagnostics'));
  // An edit near the beginning should scroll proportionally after rendering,
  // with rapid changes coalesced and the latest revision selected.
  const before='# Other\n\n'+'body '.repeat(100);
  send({method:'textDocument/didChange',params:{textDocument:{uri:otherUri,version:2},contentChanges:[{text:before}]}});
  const after=before.replace('Other','Changed');
  send({method:'textDocument/didChange',params:{textDocument:{uri:otherUri,version:3},contentChanges:[{text:after}]}});
  await until(()=>recorded().some(m=>m.params?.command==='tinymist.scrollPreview'));
  const queries=recorded().filter(m=>m.params?.command==='tinymist.exportQuery');
  assert.equal(queries.length,1);
  assert.equal(queries[0].params.arguments[2].write,false);
  const scroll=recorded().find(m=>m.params?.command==='tinymist.scrollPreview');
  assert.equal(scroll.params.arguments[1].event,'panelScrollByPosition');
  assert.equal(scroll.params.arguments[1].position.y,24+editFraction(before,after)*976);
  assert.ok(!messages.some(m=>m.id===queries[0].id));

  // Ignore a completed query if another document became active meanwhile.
  send({method:'textDocument/didChange',params:{textDocument:{uri:otherUri,version:4},contentChanges:[{text:after+'new'}]}});
  await until(()=>recorded().filter(m=>m.params?.command==='tinymist.exportQuery').length===2);
  send({method:'textDocument/didOpen',params:{textDocument:{uri,languageId:'markdown',version:5,text:'# Returned'}}});
  await new Promise(r=>setTimeout(r,150));
  assert.equal(recorded().filter(m=>m.params?.command==='tinymist.scrollPreview').length,1);

});
