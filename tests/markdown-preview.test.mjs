import { spawnProxy, stopProxy } from './proxy-launch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function typstString'), source.indexOf("if (!tinymistArgs.includes"));
const { normalizeMarkdownMathPadding, markdownTypst, editFraction, markdownHeader, typstCompletionRegion, completionProjection, markdownCompletions, completionRangeInside, positionAtOffset, positionOffset, markdownMathCheck, markdownMathDiagnostics } = vm.runInNewContext(helpers + ';({normalizeMarkdownMathPadding, markdownTypst, editFraction, markdownHeader, typstCompletionRegion, completionProjection, markdownCompletions, completionRangeInside, positionAtOffset, positionOffset, markdownMathCheck, markdownMathDiagnostics})', { URL });

test('wrapper preserves Markdown escapes and selects native Typst math', () => {
  const text = '# Heading\n$frac(1, 2)$ and \\u1234 "quoted" 😀\r\n\t\0';
  const wrapper = markdownTypst(text);
  assert.ok(wrapper.includes('raw-typst: false'));
  assert.ok(wrapper.includes('math.equation(block: block, eval(source, mode: "math"))'));
  assert.ok(wrapper.includes('\\\\u1234'));
  assert.ok(wrapper.includes('\\u{a}'));
  assert.ok(wrapper.includes('\\u{0}'));
});

test('rendering accepts padded inline math without rewriting code, headers, or display math', () => {
  const input = '😀 $ H(t) $ and $H(t)$; $ H(t)$; $H(t) $; $\tH(t)\t$.';
  const normalized = '😀 $H(t)$ and $H(t)$; $H(t)$; $H(t)$; $H(t)$.';
  assert.equal(normalizeMarkdownMathPadding(input), normalized);
  assert.ok(markdownTypst(input).includes('😀 $H(t)$ and $H(t)$'));
  const protectedText = '\\$ H(t) $\n`$ H(t) $`\n```typst\n$ H(t) $\n```\n' +
    '~~~\n$ H(t) $\n~~~\n> ```\n> $ H(t) $\n> ```\n    $ H(t) $\n$$ H(t) $$\n$  $\n$ H(t)';
  assert.equal(normalizeMarkdownMathPadding(protectedText), protectedText);
  const header = '"""\n#let literal = "$ H(t) $"\n"""\n';
  assert.equal(normalizeMarkdownMathPadding(header + '$ H(t) $'), header + '$H(t)$');
  const crlf = 'Before $ H(t) $\r\nAfter $ H(t) $';
  assert.equal(normalizeMarkdownMathPadding(crlf), 'Before $H(t)$\r\nAfter $H(t)$');
});

test('padded math completion positions stay in the original source', () => {
  const text = '😀 before $ H(t) $ after';
  const cursor = text.indexOf('H(t)') + 1;
  const region = typstCompletionRegion(text, cursor);
  assert.equal(region.kind, 'math');
  const projection = completionProjection(text, region);
  assert.equal(projection.length, text.length);
  assert.equal(projection.slice(region.start, region.end), ' H(t) ');
  assert.equal(positionOffset(projection, positionAtOffset(text, cursor)), cursor);
  assert.ok(markdownTypst(text).includes('$H(t)$'));
});

test('real cmarker reaches the math callback for padded and unpadded formulas', {
  skip: !process.env.TINYMIST_TEST_BINARY && 'Set TINYMIST_TEST_BINARY for the real rendering check'
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'markdown-padding-render-'));
  try {
    const markdown = '$H(t)$\n\n$ H(t) $\n\n$ H(t)$\n\n$H(t) $\n\n$\tH(t)\t$\n\n$$ H(t) $$\n\n' +
      '`$ H(t) $`\n\n```typst\n$ H(t) $\n```';
    const wrapper = markdownTypst(markdown).replace(
      '=> math.equation(block: block, eval(source, mode: "math"))',
      '=> [#metadata((block: block)) <padding-math>#math.equation(block: block, eval(source, mode: "math"))]'
    ) + '\n#context {\n' +
      '  assert(query(<padding-math>).len() == 6, message: "missing math callback")\n' +
      '  assert(query(<padding-math>).filter(it => it.value.block).len() == 1, message: "wrong display mode")\n}';
    const input = path.join(dir, 'probe.typ');
    writeFileSync(input, wrapper);
    const compiled = spawnSync(process.env.TINYMIST_TEST_BINARY, ['compile', '--root', dir, input, path.join(dir, 'probe.pdf')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('math checking masks prose/code and preserves original UTF-16 diagnostic positions', () => {
  const source = '😀 prose $ not-a-symbol $\r\n`$bad$`\n$$\nH(t)\n$$';
  const check = markdownMathCheck(source);
  assert.equal(check.text.length, source.length);
  assert.equal(check.regions.length, 2);
  assert.equal(check.text.slice(0, 9), '         ');
  assert.ok(!check.text.includes('prose'));
  assert.ok(!check.text.includes('bad'));
  const range = { start: { line: 0, character: 11 }, end: { line: 0, character: 23 } };
  const mapped = markdownMathDiagnostics([
    { range, message: 'unknown variable', severity: 1, relatedInformation: [{ location: { uri: 'generated' } }], data: { generated: true } },
    { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, message: 'code should not map' },
    { range: { start: { line: 40, character: 0 }, end: { line: 40, character: 1 } }, message: 'invalid range' }
  ], { source, regions: check.regions });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].message, 'unknown variable');
  assert.equal(mapped[0].source, 'Typst math');
  assert.equal(mapped[0].data, undefined);
  assert.equal(mapped[0].relatedInformation, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(mapped[0].range)), range);
  const wrapper = markdownTypst(source, 1, 'notes.md.zed-math-1.typ');
  assert.ok(wrapper.includes('#let _zed_math_check = include "notes.md.zed-math-1.typ"'));
});

test('a leading triple-quoted header styles the document and preserves code blocks', () => {
  const preamble = '#let body-size = 15pt\n#set text(size: body-size)\n#set par(leading: 0.8em)\n';
  const body = '# Heading\n\nA fraction: $frac(1, 2)$.\n\n```typst\n#set text(size: 30pt)\n```\n';
  const text = '"""\n' + preamble + '"""\n' + body;
  const header = markdownHeader(text);
  assert.equal(header.preamble, preamble);
  assert.equal(header.markdown, body);
  const wrapper = markdownTypst(text, 7);
  assert.ok(wrapper.indexOf(preamble) < wrapper.indexOf('#cmarker.render('));
  assert.ok(!wrapper.includes('"""'));
  assert.ok(wrapper.includes('```typst'));
  assert.ok(wrapper.includes('version: 7'));
});

test('header parsing handles CRLF, a BOM, empty headers, and ordinary code fences', () => {
  const windows = '\uFEFF\r\n"""\r\n#set text(size: 14pt)\r\n"""\r\nBody';
  assert.equal(markdownHeader(windows).preamble, '#set text(size: 14pt)\r\n');
  assert.equal(markdownHeader(windows).markdown, 'Body');
  assert.equal(markdownHeader('"""\n"""').markdown, '');
  for (const text of [
    '"""\n#set text(size: 14pt)',
    '```typst\n#set text(size: 14pt)\n```',
    '```typst-config\n#set text(size: 14pt)\n```',
    '# Heading\n\n"""\n#set text(size: 14pt)\n"""',
    '"""extra\n#set text(size: 14pt)\n"""',
    '"""Q\n#set text(size: 14pt)\n"""Q'
  ]) {
    assert.equal(markdownHeader(text).preamble, '');
    assert.equal(markdownHeader(text).markdown, text);
  }
});

test('edit location follows the last change, including deletions and Unicode', () => {
  assert.equal(editFraction('abcdefghij', 'abXdefghij'), 0.3);
  assert.equal(editFraction('abcde', 'abde'), 0.5);
  assert.equal(editFraction('abc', ''), 0);
  assert.equal(editFraction('same', 'same'), null);
  assert.equal(editFraction('😀a tail', '😀b tail'), 3 / 8);
});

test('completion regions include unfinished headers and math, excluding prose and code', () => {
  const region = marked => {
    const offset = marked.indexOf('|');
    const text = marked.replace('|', '');
    return typstCompletionRegion(text, offset);
  };
  for (const text of ['"""\n#set te|\n"""\nBody', '"""\n#let si|', '\uFEFF\r\n"""\r\n#set te|']) {
    assert.equal(region(text)?.kind, 'header');
  }
  for (const text of ['$|', '$$|', '$2 + fr|', '$fr|$', '$sq|', '$$\nma|\n$$', '$$\nfr|', '$text("cost $5") + sq|$']) {
    assert.equal(region(text)?.kind, 'math');
  }
  for (const text of [
    'Plain fr|', '\\$fr|', 'Cost $5 and $10|', '`$fr|$`',
    '```typst\n$fr|$\n```', '~~~\n$fr|$\n~~~',
    '> ```\n> $fr|$\n> ```', '- ```\n  $fr|$\n  ```',
    '    $fr|$', '$x$ prose|', '$x$\nprose|',
    '"""|\n#set text(size: 12pt)\n"""', '"""\n#set text(size: 12pt)\n"""|'
  ]) assert.equal(region(text), null, text);
});

test('completion projections preserve UTF-16 positions and normalize display delimiters', () => {
  const text = '😀 prose\r\n$$\r\nfrac(1, 2)\r\n$$';
  const offset = text.indexOf('frac') + 2;
  const region = typstCompletionRegion(text, offset);
  const projected = completionProjection(text, region);
  assert.equal(projected.length, text.length);
  assert.equal(projected.slice(0, 8), '        ');
  assert.equal(projected.slice(region.start, region.end), text.slice(region.start, region.end));
  assert.equal(projected.slice(region.start - 2, region.start), '$ ');
  assert.equal(projected.slice(region.end, region.end + 2), ' $');
  assert.equal(positionOffset(projected, positionAtOffset(text, offset)), offset);
  const incomplete = '$fr';
  assert.equal(completionProjection(incomplete, typstCompletionRegion(incomplete, 3)), '$fr\n$');
});

test('completion edits stay inside the Typst region and strip generated-file actions', () => {
  const text = 'Prose $fr$ tail';
  const region = typstCompletionRegion(text, 9);
  const context = { text, region };
  const range = { start: { line: 0, character: 7 }, end: { line: 0, character: 9 } };
  const outside = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const result = markdownCompletions({
    itemDefaults: { editRange: range, insertTextFormat: 2 },
    items: [
      { label: 'frac', textEditText: 'frac(${1:a}, ${2:b})', data: { file: 'generated' }, command: { command: 'unsafe' } },
      { label: 'wrong', textEdit: { range: outside, newText: 'bad' } },
      { label: 'import', additionalTextEdits: [{ range: outside, newText: '#import' }] },
      { label: 'replace', textEdit: { insert: range, replace: range, newText: 'frac' } }
    ]
  }, context);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].insertTextFormat, 2);
  assert.equal(result.items[0].textEdit.newText, 'frac(${1:a}, ${2:b})');
  assert.equal(result.items[0].data, undefined);
  assert.equal(result.items[0].command, undefined);
  assert.ok(completionRangeInside(result.items[1].textEdit.replace, context));
});

test('quoted font suggestions replace the header string without duplicating quotes', () => {
  for (const tail of ['" )\n"""', '']) {
    const text = '"""\n#set text(font: "New Co' + tail;
    const position = { line: 1, character: 23 };
    const context = { text, position, region: typstCompletionRegion(text, positionOffset(text, position)) };
    const result = markdownCompletions([{ label: '"New Computer Modern"',
      textEdit: { range: { start: position, end: position }, newText: '"New Computer Modern' }
    }], context);
    const edit = result.items[0].textEdit;
    const updated = text.slice(0, positionOffset(text, edit.range.start)) + edit.newText + text.slice(positionOffset(text, edit.range.end));
    assert.ok(updated.includes('font: "New Computer Modern"'));
    assert.ok(!updated.includes('New Co"New'));
  }
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
  if (m.params?.command === 'tinymist.focusMain' || m.params?.command === 'tinymist.scrollPreview') send({jsonrpc:'2.0', id:m.id,result:null});
  if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{capabilities:{documentFormattingProvider:true,definitionProvider:true}}});
  if (m.method === 'textDocument/didOpen') documents.set(m.params.textDocument.uri, m.params.textDocument.text);
  if (m.method === 'textDocument/didChange') documents.set(m.params.textDocument.uri, m.params.contentChanges[0].text);
  if (m.params?.command === 'tinymist.exportQuery') {
   const text=documents.get(new URL('file://'+m.params.arguments[0]).href);
   const version=Number(/version: (\\d+)/.exec(text)[1]);
   const data=Buffer.from(JSON.stringify([{version,page:1,x:0,y:1000}])).toString('base64');
   setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{data}}),60);
  }
  if (m.method === 'textDocument/completion') {
   const pos=m.params.position;
   const range={start:{line:pos.line,character:pos.character-2},end:pos};
   setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{items:[
    {label:'frac',textEdit:{range,newText:'frac'},data:{generated:true},command:{command:'bad'}},
    {label:'unsafe',textEdit:{range:{start:{line:0,character:0},end:{line:0,character:1}},newText:'bad'}}
   ]}}),60);
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
  const child = spawnProxy(fake, true);
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
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) { stopProxy(child); await exited; }
    rmSync(dir, { recursive: true, force: true });
  });
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
  assert.equal(caps.completionProvider.resolveProvider,false);
  assert.ok(caps.completionProvider.triggerCharacters.includes('#'));
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
  const open=records.find(m=>m.method==='textDocument/didOpen' && m.params.textDocument.uri.endsWith('.zed-preview.typ')).params.textDocument;
  assert.equal(open.uri,uri+'.zed-preview.typ');
  assert.equal(open.languageId,'typst');
  assert.ok(open.text.includes('@preview/cmarker:0.1.8'));
  const changes=records.filter(m=>m.method==='textDocument/didChange');
  const checkName = index => decodeURIComponent(records.filter(m=>m.method==='textDocument/didOpen' && /\.zed-math-\d+\.typ$/.test(m.params.textDocument.uri))[index].params.textDocument.uri.split('/').at(-1));
  assert.equal(changes[0].params.contentChanges[0].text,markdownTypst('😀 $y^2$\r\nnext',2,checkName(1)));
  assert.equal(changes[1].params.contentChanges[0].text,markdownTypst('# Changed\n$$frac(1, 2)$$',3,checkName(2)));
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
  assert.ok(messages.filter(m=>m.method==='textDocument/publishDiagnostics').every(m=>m.params.diagnostics.length===0 && !m.params.uri.endsWith('.typ')));
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
  // Completion documents are separate from preview documents and edits map back unchanged.
  send({method:'textDocument/didChange',params:{textDocument:{uri,version:6},contentChanges:[{text:'Some $fr$ text'}]}});
  send({id:20,method:'textDocument/completion',params:{textDocument:{uri},position:{line:0,character:8}}});
  await until(()=>messages.some(m=>m.id===20));
  const answer=messages.find(m=>m.id===20).result;
  assert.equal(answer.items.length,1);
  assert.equal(answer.items[0].label,'frac');
  assert.equal(answer.items[0].textEdit.range.start.character,6);
  assert.equal(answer.items[0].data,undefined);
  const completionRequest=recorded().find(m=>m.method==='textDocument/completion');
  assert.equal(completionRequest.params.textDocument.uri,uri+'.zed-completion.typ');
  const completionOpen=recorded().find(m=>m.method==='textDocument/didOpen' && m.params.textDocument.uri.endsWith('.zed-completion.typ'));
  assert.equal(completionOpen.params.textDocument.text,'     $fr$     ');
  send({id:21,method:'textDocument/completion',params:{textDocument:{uri},position:{line:0,character:2}}});
  await until(()=>messages.some(m=>m.id===21));
  assert.equal(messages.find(m=>m.id===21).result,null);
  assert.ok(recorded().filter(m=>m.method==='textDocument/completion').length===1);

  send({id:22,method:'textDocument/completion',params:{textDocument:{uri},position:{line:0,character:8}}});
  await until(()=>recorded().filter(m=>m.method==='textDocument/completion').length===2);
  send({method:'textDocument/didChange',params:{textDocument:{uri,version:7},contentChanges:[{text:'Updated $sq$'}]}});
  await until(()=>messages.some(m=>m.id===22));
  assert.equal(messages.find(m=>m.id===22).result,null);
  send({method:'textDocument/didClose',params:{textDocument:{uri}}});
  await until(()=>recorded().some(m=>m.method==='textDocument/didClose' && m.params.textDocument.uri.endsWith('.zed-completion.typ')));


});
