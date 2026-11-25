#!/usr/bin/env node
import cp from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MathHistory, mergeMathCompletions } from './math-history.mjs';

// Parse arguments
const tinymistBin = process.argv[2] || 'tinymist';
const markdownMode = process.argv.includes("--markdown");
const tinymistArgs = process.argv.slice(3).filter(arg => arg !== "--markdown");
const markdownDocuments = new Map();
const markdownVersions = new Map();
const completionDocuments = new Map();
const completionRequests = new Map();
const mathHistory = new MathHistory(text => [...typstCompletionRegions(text)].filter(r => r.kind === 'math'));
const markdownChecks = new Map();
const checkOwners = new Map();
const staleChecks = [];
let checkSequence = 0;

function typstString(text) {
  return '"' + text.replace(/["\\\x00-\x1f]/g, char => {
    if (char === '"' || char === '\\') return '\\' + char;
    return '\\u{' + char.charCodeAt(0).toString(16) + '}';
  }) + '"';
}

function markdownHeader(text) {
  // Only a complete triple-quoted header at the start is executable Typst.
  const opening = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*"""[ \t]*\r?\n/.exec(text);
  if (!opening) return { preamble: '', markdown: text };
  const closing = /^"""[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(text);
  if (!end) return { preamble: '', markdown: text };
  return {
    preamble: text.slice(opening[0].length, end.index),
    markdown: text.slice(end.index + end[0].length)
  };
}

function normalizeMarkdownMathPadding(text) {
  // cmark rejects whitespace beside inline dollars; change only the render copy.
  const parts = [];
  let cursor = 0;
  for (const region of typstCompletionRegions(text)) {
    if (region.kind !== 'math' || region.delimiter !== 1 || !region.closed) continue;
    const source = text.slice(region.start, region.end);
    const trimmed = source.trim();
    if (!trimmed || source === trimmed) continue;
    parts.push(text.slice(cursor, region.start), trimmed);
    cursor = region.end;
  }
  return parts.length ? parts.join('') + text.slice(cursor) : text;
}

function markdownTypst(text, version = 0, checkFile = null) {
  const { preamble, markdown } = markdownHeader(normalizeMarkdownMathPadding(text));
  return `#import "@preview/cmarker:0.1.8"
#set page(margin: 24pt, height: auto)
${checkFile ? '#let _zed_math_check = include ' + typstString(checkFile) : ''}
${preamble}
#cmarker.render(
  ${typstString(markdown)},
  raw-typst: false,
  math: (source, block: false) => math.equation(block: block, eval(source, mode: "math")),
  scope: (image: (source, ..args) => image(source, ..args)),
)
#context {
  let pos = here().position()
  [#metadata((version: ${version}, page: pos.page, x: 0, y: pos.y.pt())) <zed-preview-bottom>]
}
`;
}

function editFraction(before, after) {
  if (before === after) return null;
  let suffix = 0;
  while (suffix < before.length && suffix < after.length &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return after.length ? (after.length - suffix) / after.length : 0;
}

function shadowUri(uri, suffix = ".zed-preview.typ") {
  const url = new URL(uri);
  url.pathname += suffix;
  return url.href;
}

function positionOffset(text, position) {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const end = text.indexOf("\n", offset);
    if (end === -1) return text.length;
    offset = end + 1;
  }
  return offset + position.character;
}

function positionAtOffset(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 };
}

function* typstCompletionRegions(text) {
  const opening = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*"""[ \t]*\r?\n/.exec(text);
  let bodyStart = 0;
  if (opening) {
    const closing = /^"""[ \t]*(?:\r?\n|$)/gm;
    closing.lastIndex = opening[0].length;
    const end = closing.exec(text);
    const start = opening[0].length;
    const stop = end?.index ?? text.length;
    yield { kind: 'header', start, end: stop, closed: !!end };
    if (!end) return;
    bodyStart = end.index + end[0].length;
  }
  let fence = null, ticks = 0, math = null, quoted = false;
  for (let i = bodyStart; i < text.length;) {
    if (!math && !ticks && (i === bodyStart || text[i - 1] === '\n')) {
      const end = text.indexOf('\n', i);
      const line = text.slice(i, end < 0 ? text.length : end);
      const match = /^[ \t]{0,3}(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)/.exec(line);
      if (fence || match || /^(?: {4}|\t)/.test(line)) {
        if (fence) {
          if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
        } else if (match) fence = { char: match[1][0], length: match[1].length };
        i = end < 0 ? text.length : end + 1;
        continue;
      }
    }
    if (text[i] === '\\' && !ticks) { i += 2; continue; }
    if (math) {
      if (text[i] === '\n' && math.delimiter === 1) {
        const region = { ...math, end: i, closed: false };
        yield region;
        math = null; quoted = false;
      } else if (text[i] === '"') quoted = !quoted;
      else if (!quoted && text.startsWith('$'.repeat(math.delimiter), i) &&
          (math.delimiter === 2 || !/\d/.test(text[i + 1] || ''))) {
        const region = { ...math, end: i, closed: true };
        yield region;
        i += math.delimiter; math = null;
        continue;
      }
      i++; continue;
    }
    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))[0].length;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      i += run; continue;
    }
    if (!ticks && text[i] === '$') {
      const delimiter = text[i + 1] === '$' ? 2 : 1;
      if (delimiter === 1) {
        const lineEnd = text.indexOf('\n', i);
        const rest = text.slice(i + 1, lineEnd < 0 ? text.length : lineEnd);
        // Currency without a closing math delimiter should not activate suggestions.
        if (/^\d/.test(rest) && !/[-+*/^_=()[\]{}]/.test(rest) &&
            !/(?:^|[^\\])\$(?!\d)/.test(rest)) { i++; continue; }
      }
      math = { kind: 'math', start: i + delimiter, delimiter };
      quoted = false; i += delimiter; continue;
    }
    i++;
  }
  const region = math && { ...math, end: text.length, closed: false };
  if (region) yield region;
}

function typstCompletionRegion(text, offset) {
  for (const region of typstCompletionRegions(text)) {
    if (offset >= region.start && offset <= region.end &&
        (region.kind !== 'header' || offset < region.end || !region.closed)) return region;
  }
  return null;
}

function changedText(text, changes) {
  for (const change of changes) {
    text = change.range
      ? text.slice(0, positionOffset(text, change.range.start)) + change.text + text.slice(positionOffset(text, change.range.end))
      : change.text;
  }
  return text;
}

function observeMathDocument(msg) {
  const doc = msg.params?.textDocument;
  if (!doc?.uri) return;
  if (msg.method === 'textDocument/didOpen' && doc.uri.startsWith('file://') &&
      (markdownMode || doc.languageId === 'typst' || /\.(typ|typst)$/.test(doc.uri))) {
    mathHistory.open(doc.uri, doc.text, doc.version, markdownMode);
  } else if (msg.method === 'textDocument/didChange') {
    const previous = mathHistory.get(doc.uri);
    if (previous) mathHistory.change(doc.uri, changedText(previous.text, msg.params.contentChanges), doc.version);
  } else if (msg.method === 'textDocument/didClose') mathHistory.close(doc.uri);
}

function completionProjection(text, region) {
  // Mask by UTF-16 code unit, preserving emoji widths, CRLF, and every source position.
  const masked = text.replace(/[^\r\n]/g, ' ').split('');
  for (let i = region.start; i < region.end; i++) masked[i] = text[i];
  if (region.kind === 'math') {
    masked[region.start - region.delimiter] = '$';
    if (region.closed) masked[region.end + region.delimiter - 1] = '$';
  }
  return masked.join('') + (region.kind === 'math' && !region.closed ? '\n$' : '');
}

function markdownMathCheck(text) {
  const regions = [...typstCompletionRegions(text)].filter(r => r.kind === 'math');
  const masked = text.replace(/[^\r\n]/g, ' ').split('');
  for (const region of regions) {
    for (let i = region.start; i < region.end; i++) masked[i] = text[i];
    masked[region.start - region.delimiter] = '$';
    if (region.closed) masked[region.end + region.delimiter - 1] = '$';
  }
  return { text: masked.join(''), regions };
}

function markdownMathDiagnostics(diagnostics, context) {
  return diagnostics.flatMap(diagnostic => {
    if (!completionRangeInside(diagnostic.range, { text: context.source, region: { start: 0, end: context.source.length } })) return [];
    const first = positionOffset(context.source, diagnostic.range.start);
    const last = positionOffset(context.source, diagnostic.range.end);
    const region = context.regions.find(r => first <= r.end && last >= r.start) ||
      context.regions.findLast(r => !r.closed && first >= r.end);
    if (!region) return [];
    const { relatedInformation, data, ...copy } = diagnostic;
    return [{ ...copy, source: 'Typst math', range: {
      start: positionAtOffset(context.source, Math.max(region.start, Math.min(region.end, first))),
      end: positionAtOffset(context.source, Math.max(region.start, Math.min(region.end, last)))
    } }];
  });
}

function prepareMathCheck(uri, source, version) {
  const previous = markdownChecks.get(uri);
  if (previous) { checkOwners.delete(previous.uri); staleChecks.push(previous.uri); }
  const check = { ...markdownMathCheck(source), source, original: uri, version,
    uri: shadowUri(uri, `.zed-math-${++checkSequence}.typ`) };
  markdownChecks.set(uri, check);
  checkOwners.set(check.uri, check);
  // Each revision has its own URI: even unversioned late compiler diagnostics are rejected.
  sendMsg(process.stdout, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [] } });
  sendMsg(child.stdin, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
    textDocument: { uri: check.uri, languageId: 'typst', version: 1, text: check.text }
  } });
  return decodeURIComponent(new URL(check.uri).pathname.split('/').at(-1));
}

function completionRangeInside(range, context) {
  if (!range?.start || !range?.end) return false;
  const lines = context.lines || context.text.split('\n');
  const valid = pos => Number.isInteger(pos.line) && Number.isInteger(pos.character) &&
    pos.line >= 0 && pos.line < lines.length && pos.character >= 0 &&
    pos.character <= lines[pos.line].replace(/\r$/, '').length;
  if (!valid(range.start) || !valid(range.end)) return false;
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  const start = context.regionStart || positionAtOffset(context.text, context.region.start);
  const end = context.regionEnd || positionAtOffset(context.text, context.region.end);
  return compare(start, range.start) <= 0 && compare(range.start, range.end) <= 0 && compare(range.end, end) <= 0;
}

function completionStringRange(context) {
  if (context.region.kind !== 'header' || !context.position) return null;
  const cursor = positionOffset(context.text, context.position);
  let start = null, lineComment = false, blockDepth = 0;
  for (let i = context.region.start; i < cursor; i++) {
    const pair = context.text.slice(i, i + 2), char = context.text[i];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockDepth) {
      if (pair === '/*') { blockDepth++; i++; }
      else if (pair === '*/') { blockDepth--; i++; }
      continue;
    }
    if (start !== null) {
      if (char === '\\') i++;
      else if (char === '"') start = null;
    } else if (pair === '//') { lineComment = true; i++; }
    else if (pair === '/*') { blockDepth++; i++; }
    else if (char === '"') start = i;
  }
  if (start === null || lineComment || blockDepth) return null;
  let end = cursor;
  for (let i = cursor; i < context.region.end && !/[\r\n]/.test(context.text[i]); i++) {
    if (context.text[i] === '\\') i++;
    else if (context.text[i] === '"') { end = i + 1; break; }
  }
  return { start: positionAtOffset(context.text, start), end: positionAtOffset(context.text, end) };
}

function markdownCompletions(result, context) {
  context = { ...context, lines: context.text.split('\n'),
    regionStart: positionAtOffset(context.text, context.region.start),
    regionEnd: positionAtOffset(context.text, context.region.end) };
  const defaults = result?.itemDefaults || {};
  const stringRange = completionStringRange(context);
  const items = Array.isArray(result) ? result : result?.items || [];
  const mapped = items.flatMap(item => {
    const copy = { ...item };
    if (stringRange && /^"(?:[^"\\]|\\.)*"$/s.test(copy.label)) {
      // Tinymist 0.14 can return insertion-only font edits inside a partial string.
      copy.textEdit = { range: stringRange, newText: copy.label };
      copy.insertTextFormat = 1;
    }
    if (!copy.textEdit && defaults.editRange) {
      const edit = defaults.editRange;
      copy.textEdit = { ...(edit.insert ? edit : { range: edit }), newText: copy.textEditText ?? copy.insertText ?? copy.label };
    }
    if (copy.textEdit) {
      const edit = copy.textEdit;
      const ranges = edit.range ? [edit.range] : [edit.insert, edit.replace];
      if (!ranges.every(range => completionRangeInside(range, context))) return [];
    }
    if (copy.additionalTextEdits?.some(edit => !completionRangeInside(edit.range, context))) return [];
    for (const key of ['insertTextFormat', 'insertTextMode', 'commitCharacters']) {
      if (copy[key] === undefined && defaults[key] !== undefined) copy[key] = defaults[key];
    }
    // No lazy resolve or commands: they could introduce edits to generated files.
    delete copy.data; delete copy.command;
    return [copy];
  });
  return { isIncomplete: !!result?.isIncomplete, items: mapped };
}

if (!tinymistArgs.includes('lsp')) {
  tinymistArgs.unshift('lsp');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Allocate ephemeral port before starting message readers so all handlers remain synchronous
const previewPort = await getFreePort();
const previewUrl = `http://127.0.0.1:${previewPort}`;

// State
let browserScheduled = false;
let browserOpened = false;
let openBrowserOnStart = true;
let followCursor = !markdownMode;
let previewMode = 'document';
let lastLine = -1;
let lastPos = null;
let suppressUntil = 0;
let synthSeq = 0;
let activeMarkdownPreviewUri = null;
let pendingMarkdownScroll = null;
let markdownScrollTimer = null;
const markdownScrollQueries = new Map();
const codeActionReqs = new Set();
const configReqs = new Set();

function injectPreviewConfig(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.previewProxy && typeof obj.previewProxy === 'object') {
    if (obj.previewProxy.openBrowser !== undefined) openBrowserOnStart = obj.previewProxy.openBrowser;
    if (obj.previewProxy.followCursor !== undefined) followCursor = obj.previewProxy.followCursor;
    if (obj.previewProxy.mode) previewMode = obj.previewProxy.mode;
    delete obj.previewProxy;
  }
  if (markdownMode) {
    followCursor = false;
    // Never export PDFs beside a synthetic document.
    obj.exportPdf = "never";
  }
  obj.customizedShowDocument = true;
  obj.preview = obj.preview || {};
  obj.preview.background = {
    enabled: true,
    args: [
      `--data-plane-host=127.0.0.1:${previewPort}`,
      '--invert-colors=never',
      `--preview-mode=${previewMode}`
    ]
  };
}

function findZedCli() {
  if (process.env.ZED_CLI_PATH && fs.existsSync(process.env.ZED_CLI_PATH)) {
    return process.env.ZED_CLI_PATH;
  }
  const candidates = ['/usr/local/bin/zed', '/Applications/Zed.app/Contents/MacOS/cli', 'zed', 'zeditor'];
  for (const c of candidates) {
    if (c.startsWith('/') && fs.existsSync(c)) return c;
  }
  return 'zed';
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd /c start' : 'xdg-open';
  cp.exec(`${cmd} "${url}"`, () => {});
}

function jumpZed(filepath, line, col) {
  const zedBin = findZedCli();
  try {
    cp.spawn(zedBin, [`${filepath}:${line}:${col}`], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.error('[proxy] jump error:', err);
  }
}

// Message framing
class MessageReader {
  constructor(stream, onMessage) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
    stream.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const totalLength = bodyStart + contentLength;
      if (this.buffer.length < totalLength) break;

      const bodyBuf = this.buffer.subarray(bodyStart, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const msg = JSON.parse(bodyBuf.toString('utf8'));
        this.onMessage(msg);
      } catch (err) {
        console.error('[proxy] JSON parse error:', err);
      }
    }
  }
}

function sendMsg(stream, msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  stream.write(Buffer.concat([header, body]));
}

function syncScroll(filepath, line, col) {
  const id1 = `tpp-${++synthSeq}`;
  const id2 = `tpp-${++synthSeq}`;
  sendMsg(child.stdin, {
    jsonrpc: '2.0',
    id: id1,
    method: 'workspace/executeCommand',
    params: {
      command: 'tinymist.scrollPreview',
      arguments: ['default_preview', { event: 'panelScrollTo', filepath, line, character: col }]
    }
  });
  sendMsg(child.stdin, {
    jsonrpc: '2.0',
    id: id2,
    method: 'workspace/executeCommand',
    params: {
      command: 'tinymist.scrollPreview',
      arguments: ['default_preview', { event: 'changeCursorPosition', filepath, line, character: col }]
    }
  });
}

function focusMarkdownPreview(uri) {
  if (uri === activeMarkdownPreviewUri) return;
  if (pendingMarkdownScroll?.uri !== uri) {
    pendingMarkdownScroll = null;
    clearTimeout(markdownScrollTimer);
  }
  activeMarkdownPreviewUri = uri;
  sendMsg(child.stdin, {
    jsonrpc: '2.0', id: `tpp-${++synthSeq}`,
    method: 'workspace/executeCommand',
    params: { command: 'tinymist.focusMain', arguments: [fileURLToPath(uri)] }
  });
}

function queryMarkdownScroll() {
  const target = pendingMarkdownScroll;
  if (!target || target.uri !== activeMarkdownPreviewUri) return;
  const id = `tpp-${++synthSeq}`;
  markdownScrollQueries.set(id, target);
  sendMsg(child.stdin, {
    jsonrpc: '2.0', id, method: 'workspace/executeCommand',
    params: { command: 'tinymist.exportQuery', arguments: [
      fileURLToPath(target.uri),
      { selector: '<zed-preview-bottom>', field: 'value', format: 'json' },
      { write: false }
    ] }
  });
}

function handleMarkdownScrollResult(msg, target) {
  if (target !== pendingMarkdownScroll || target.uri !== activeMarkdownPreviewUri) return;
  let position;
  try {
    const data = msg.result?.data;
    position = data ? JSON.parse(Buffer.from(data, 'base64').toString('utf8'))[0] : null;
  } catch { /* An invalid document may not have queryable output yet. */ }
  if (position?.version !== target.version || !Number.isFinite(position.y)) {
    // The compiler may still be rendering an earlier version. Retry briefly.
    if (++target.attempts < 4) markdownScrollTimer = setTimeout(queryMarkdownScroll, 200);
    else pendingMarkdownScroll = null;
    return;
  }
  pendingMarkdownScroll = null;
  sendMsg(child.stdin, {
    jsonrpc: '2.0', id: `tpp-${++synthSeq}`, method: 'workspace/executeCommand',
    params: { command: 'tinymist.scrollPreview', arguments: ['default_preview', {
      event: 'panelScrollByPosition',
      position: { page_no: position.page, x: 0, y: 24 + target.fraction * Math.max(0, position.y - 24) }
    }] }
  });
}

function completeMarkdown(msg) {
  const uri = msg.params?.textDocument?.uri;
  const text = markdownDocuments.get(uri);
  const position = msg.params?.position;
  const region = text !== undefined && position && typstCompletionRegion(text, positionOffset(text, position));
  if (!region) {
    sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  focusMarkdownPreview(shadowUri(uri));
  const projectedUri = shadowUri(uri, '.zed-completion.typ');
  const projectedText = completionProjection(text, region);
  const previous = completionDocuments.get(uri);
  if (!previous || previous.text !== projectedText) {
    const version = (previous?.version || 0) + 1;
    sendMsg(child.stdin, {
      jsonrpc: '2.0', method: previous ? 'textDocument/didChange' : 'textDocument/didOpen',
      params: previous
        ? { textDocument: { uri: projectedUri, version }, contentChanges: [{ text: projectedText }] }
        : { textDocument: { uri: projectedUri, languageId: 'typst', version, text: projectedText } }
    });
    completionDocuments.set(uri, { text: projectedText, version });
  }
  completionRequests.set(msg.id, { uri, version: markdownVersions.get(uri), text, region, position,
    document: mathHistory.get(uri), history: mathHistory.context(uri, position, positionOffset(text, position)), markdown: true });
  sendMsg(child.stdin, { ...msg, params: { ...msg.params, textDocument: { uri: projectedUri } } });
}

// Zed owns Markdown; Tinymist sees
// a sibling virtual .typ file, preserving relative asset paths without disk writes.
function handleMarkdownMessage(msg) {
  const method = msg.method || '';
  if (!method.startsWith('textDocument/')) return false;
  const doc = msg.params?.textDocument;
  if (method === 'textDocument/completion') {
    completeMarkdown(msg);
    return true;
  }
  if (method === 'textDocument/didOpen') {
    if (!doc?.uri?.startsWith('file://')) return true;
    markdownDocuments.set(doc.uri, doc.text);
    markdownVersions.set(doc.uri, doc.version);
    msg.params.textDocument = {
      uri: shadowUri(doc.uri), languageId: 'typst', version: doc.version,
      text: markdownTypst(doc.text, doc.version, prepareMathCheck(doc.uri, doc.text, doc.version))
    };
    return false;
  }
  if (method === 'textDocument/didChange') {
    let text = markdownDocuments.get(doc?.uri);
    if (text === undefined) return true;
    const before = text;
    text = mathHistory.get(doc.uri)?.text ?? changedText(text, msg.params.contentChanges);
    markdownDocuments.set(doc.uri, text);
    markdownVersions.set(doc.uri, doc.version);
    const fraction = editFraction(before, text);
    if (fraction !== null) {
      clearTimeout(markdownScrollTimer);
      pendingMarkdownScroll = { uri: shadowUri(doc.uri), version: doc.version, fraction, attempts: 0 };
    }
    msg.params = {
      textDocument: { uri: shadowUri(doc.uri), version: doc.version },
      contentChanges: [{ text: markdownTypst(text, doc.version, prepareMathCheck(doc.uri, text, doc.version)) }]
    };
    return false;
  }
  if (method === 'textDocument/didClose') {
    if (!markdownDocuments.delete(doc?.uri)) return true;
    markdownVersions.delete(doc.uri);
    const check = markdownChecks.get(doc.uri);
    if (check) {
      markdownChecks.delete(doc.uri); checkOwners.delete(check.uri);
      sendMsg(child.stdin, { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: check.uri } } });
    }
    sendMsg(process.stdout, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: [] } });
    if (completionDocuments.delete(doc.uri)) {
      sendMsg(child.stdin, { jsonrpc: '2.0', method: 'textDocument/didClose',
        params: { textDocument: { uri: shadowUri(doc.uri, '.zed-completion.typ') } } });
    }
    const uri = shadowUri(doc.uri);
    if (activeMarkdownPreviewUri === uri) activeMarkdownPreviewUri = null;
    if (pendingMarkdownScroll?.uri === uri) {
      pendingMarkdownScroll = null;
      clearTimeout(markdownScrollTimer);
    }
    msg.params.textDocument = { uri };
    return false;
  }
  if (markdownDocuments.has(doc?.uri) &&
      ['textDocument/documentHighlight', 'textDocument/codeAction'].includes(method)) {
    // Use document activity only to choose the preview; return no generated ranges.
    focusMarkdownPreview(shadowUri(doc.uri));
  }
  if (msg.id !== undefined) {
    const result = method === 'textDocument/codeAction' ? [{
      title: 'Markdown Typst Preview: Open in Browser', kind: 'quickfix',
      command: { title: 'Open in Browser', command: 'typst-preview.open' }
    }] : method === 'textDocument/documentHighlight' ? [] : null;
    sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result });
  }
  return true;
}

// Spawn Tinymist LSP
const child = cp.spawn(tinymistBin, tinymistArgs, {
  stdio: ['pipe', 'pipe', 'inherit']
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[proxy] tinymist spawn error:', err);
  process.exit(1);
});

// Zed -> Tinymist
new MessageReader(process.stdin, (msg) => {
  if (msg.method === 'initialize') {
    const opts = (msg.params = msg.params || {}).initializationOptions = msg.params.initializationOptions || {};
    injectPreviewConfig(opts);
  }

  if (configReqs.has(msg.id)) {
    configReqs.delete(msg.id);
    if (Array.isArray(msg.result)) {
      msg.result = msg.result.map((item) => {
        const obj = item && typeof item === 'object' ? item : {};
        if (obj.tinymist && typeof obj.tinymist === 'object') {
          injectPreviewConfig(obj.tinymist);
        }
        injectPreviewConfig(obj);
        return obj;
      });
    } else {
      const obj = msg.result && typeof msg.result === 'object' ? msg.result : {};
      injectPreviewConfig(obj);
      msg.result = [obj];
    }
  }

  if (msg.method === 'workspace/didChangeConfiguration') {
    const settings = (msg.params = msg.params || {}).settings = msg.params.settings || {};
    if (settings.tinymist && typeof settings.tinymist === 'object') {
      injectPreviewConfig(settings.tinymist);
    }
    injectPreviewConfig(settings);
  }

  observeMathDocument(msg);
  if (msg.method === 'completionItem/resolve' && msg.params?.data?.typstPreviewMathHistory === true) {
    sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result: msg.params });
    return;
  }
  if (!markdownMode && msg.method === 'textDocument/completion') {
    const uri = msg.params?.textDocument?.uri, position = msg.params?.position;
    const doc = mathHistory.get(uri);
    const history = doc && position && mathHistory.context(uri, position, positionOffset(doc.text, position));
    if (history) completionRequests.set(msg.id, { uri, version: doc.version, text: doc.text, document: doc, history, markdown: false });
  }
  if (markdownMode && handleMarkdownMessage(msg)) return;

  if (msg.method === 'textDocument/didOpen') {
    const uri = msg.params?.textDocument?.uri || '';
    if (!browserScheduled && uri.endsWith('.typ') && previewUrl) {
      browserScheduled = true;
      setTimeout(() => {
        browserOpened = true;
        if (openBrowserOnStart) openBrowser(previewUrl);
      }, 800);
    }
  }

  if (msg.method === 'textDocument/codeAction') {
    codeActionReqs.add(msg.id);
  }

  if (msg.method === 'workspace/executeCommand') {
    const cmd = msg.params?.command;
    if (cmd === 'typst-preview.open') {
      if (previewUrl) openBrowser(previewUrl);
      sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (markdownMode) {
      sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (cmd === 'typst-preview.toggleFollow') {
      followCursor = !followCursor;
      sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (cmd === 'typst-preview.syncCursor') {
      if (lastPos) syncScroll(lastPos.filepath, lastPos.line, lastPos.character);
      sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
  }

  if (msg.method === 'textDocument/documentHighlight') {
    const pos = msg.params?.position;
    const uri = msg.params?.textDocument?.uri || '';
    if (uri.startsWith('file://') && pos && typeof pos.line === 'number') {
      const filepath = fileURLToPath(uri);
      lastPos = { filepath, line: pos.line, character: pos.character || 0 };
      if (browserOpened && followCursor && Date.now() >= suppressUntil && pos.line !== lastLine) {
        lastLine = pos.line;
        syncScroll(filepath, pos.line, pos.character || 0);
      }
    }
  }

  sendMsg(child.stdin, msg);
  // Open/change must reach Tinymist before its compiler is focused on the virtual file.
  if (markdownMode && ['textDocument/didOpen', 'textDocument/didChange'].includes(msg.method)) {
    focusMarkdownPreview(msg.params.textDocument.uri);
    for (const uri of staleChecks.splice(0)) {
      sendMsg(child.stdin, { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
    }
    if (msg.method === 'textDocument/didChange' && pendingMarkdownScroll) {
      clearTimeout(markdownScrollTimer);
      markdownScrollTimer = setTimeout(queryMarkdownScroll, 200);
    }
  }
});

// Tinymist -> Zed
new MessageReader(child.stdout, (msg) => {
  if (markdownMode && msg.method === 'textDocument/publishDiagnostics') {
    const check = checkOwners.get(msg.params?.uri);
    if (check) sendMsg(process.stdout, { ...msg, params: {
      uri: check.original, version: check.version,
      diagnostics: markdownMathDiagnostics(msg.params.diagnostics || [], check)
    } });
    return;
  }
  if (!msg.method && completionRequests.has(msg.id)) {
    const context = completionRequests.get(msg.id);
    completionRequests.delete(msg.id);
    const doc = mathHistory.get(context.uri);
    const current = doc === context.document && doc?.version === context.version && doc?.text === context.text;
    if (current && msg.error && !context.history?.items.length) {
      sendMsg(process.stdout, context.markdown ? { jsonrpc: '2.0', id: msg.id, result: null } : msg);
      return;
    }
    let result = null;
    if (current) {
      const upstream = msg.error ? null : context.markdown ? markdownCompletions(msg.result, context) : msg.result;
      result = context.history ? mergeMathCompletions(upstream, context.history.items) : upstream;
    }
    sendMsg(process.stdout, { jsonrpc: '2.0', id: msg.id, result });
    return;
  }
  if (markdownScrollQueries.has(msg.id)) {
    const target = markdownScrollQueries.get(msg.id);
    markdownScrollQueries.delete(msg.id);
    handleMarkdownScrollResult(msg, target);
    return;
  }
  if (typeof msg.id === 'string' && msg.id.startsWith('tpp-')) {
    return; // Swallow synthetic responses
  }

  if (msg.method === 'workspace/configuration' && msg.id !== undefined) {
    configReqs.add(msg.id);
  }

  if (msg.method === 'tinymist/preview/scrollSource') {
    if (markdownMode) return;
    const params = msg.params || {};
    const filepath = params.filepath;
    const start = params.start || [0, 0];
    if (filepath) {
      suppressUntil = Date.now() + 350;
      jumpZed(filepath, (start[0] || 0) + 1, (start[1] || 0) + 1);
    }
    return;
  }

  if (markdownMode && ['window/showDocument', 'workspace/applyEdit', 'client/registerCapability'].includes(msg.method)) {
    if (msg.id !== undefined) {
      const result = msg.method === 'workspace/applyEdit' ? { applied: false }
        : msg.method === 'window/showDocument' ? { success: false } : null;
      sendMsg(child.stdin, { jsonrpc: '2.0', id: msg.id, result });
    }
    return;
  }
  if (markdownMode && ['textDocument/publishDiagnostics', 'tinymist/compileStatus'].includes(msg.method)) return;

  if (msg.method === 'window/showDocument') {
    const uri = msg.params?.uri || '';
    if (uri.startsWith('file://')) {
      const filepath = fileURLToPath(uri);
      const sel = msg.params?.selection?.start || { line: 0, character: 0 };
      suppressUntil = Date.now() + 350;
      jumpZed(filepath, (sel.line || 0) + 1, (sel.character || 0) + 1);
      if (msg.id !== undefined) {
        sendMsg(child.stdin, { jsonrpc: '2.0', id: msg.id, result: { success: true } });
      }
      return;
    }
  }

  if (msg.result?.capabilities) {
    if (markdownMode) {
      // Generated Typst positions cannot be used for Markdown editing or navigation.
      const completionProvider = msg.result.capabilities.completionProvider || { triggerCharacters: ["#", ".", "(", ",", ":", "\"", "/", "$"] };
      msg.result.capabilities = {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: 1 },
        codeActionProvider: true,
        documentHighlightProvider: true,
        completionProvider: {
          ...completionProvider,
          triggerCharacters: [...new Set([...(completionProvider.triggerCharacters || []), '$'])],
          resolveProvider: false
        },
        executeCommandProvider: { commands: ['typst-preview.open'] }
      };
      sendMsg(process.stdout, msg);
      return;
    }
    const caps = msg.result.capabilities;
    caps.executeCommandProvider = caps.executeCommandProvider || { commands: [] };
    const cmds = caps.executeCommandProvider.commands = caps.executeCommandProvider.commands || [];
    for (const c of ['typst-preview.open', 'typst-preview.toggleFollow', 'typst-preview.syncCursor']) {
      if (!cmds.includes(c)) cmds.push(c);
    }
  }

  if (codeActionReqs.has(msg.id)) {
    codeActionReqs.delete(msg.id);
    if (!Array.isArray(msg.result)) {
      msg.result = [];
    }
    msg.result.push(
      {
        title: 'Typst Preview: Open in Browser',
        kind: 'quickfix',
        command: { title: 'Open in Browser', command: 'typst-preview.open' }
      },
      {
        title: `Typst Preview: Toggle Cursor Follow (${followCursor ? 'Enabled' : 'Disabled'})`,
        kind: 'quickfix',
        command: { title: 'Toggle Follow', command: 'typst-preview.toggleFollow' }
      },
      {
        title: 'Typst Preview: Sync Cursor to Preview',
        kind: 'quickfix',
        command: { title: 'Sync Cursor', command: 'typst-preview.syncCursor' }
      }
    );
  }

  sendMsg(process.stdout, msg);
});
