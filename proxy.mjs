#!/usr/bin/env node
import cp from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Parse arguments
const tinymistBin = process.argv[2] || 'tinymist';
const markdownMode = process.argv.includes("--markdown");
const tinymistArgs = process.argv.slice(3).filter(arg => arg !== "--markdown");
const markdownDocuments = new Map();

function typstString(text) {
  return '"' + text.replace(/["\\\x00-\x1f]/g, char => {
    if (char === '"' || char === '\\') return '\\' + char;
    return '\\u{' + char.charCodeAt(0).toString(16) + '}';
  }) + '"';
}

function markdownTypst(text, version = 0) {
  return `#import "@preview/cmarker:0.1.8"
#set page(margin: 24pt, height: auto)
#cmarker.render(
  ${typstString(text)},
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

function shadowUri(uri) {
  const url = new URL(uri);
  url.pathname += ".zed-preview.typ";
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

// The Markdown connection is preview-only. Zed owns Markdown; Tinymist sees
// a sibling virtual .typ file, preserving relative asset paths without disk writes.
function handleMarkdownMessage(msg) {
  const method = msg.method || '';
  if (!method.startsWith('textDocument/')) return false;
  const doc = msg.params?.textDocument;
  if (method === 'textDocument/didOpen') {
    if (!doc?.uri?.startsWith('file://')) return true;
    markdownDocuments.set(doc.uri, doc.text);
    msg.params.textDocument = {
      uri: shadowUri(doc.uri), languageId: 'typst', version: doc.version,
      text: markdownTypst(doc.text, doc.version)
    };
    return false;
  }
  if (method === 'textDocument/didChange') {
    let text = markdownDocuments.get(doc?.uri);
    if (text === undefined) return true;
    const before = text;
    for (const change of msg.params.contentChanges) {
      text = change.range
        ? text.slice(0, positionOffset(text, change.range.start)) + change.text
          + text.slice(positionOffset(text, change.range.end))
        : change.text;
    }
    markdownDocuments.set(doc.uri, text);
    const fraction = editFraction(before, text);
    if (fraction !== null) {
      clearTimeout(markdownScrollTimer);
      pendingMarkdownScroll = { uri: shadowUri(doc.uri), version: doc.version, fraction, attempts: 0 };
    }
    msg.params = {
      textDocument: { uri: shadowUri(doc.uri), version: doc.version },
      contentChanges: [{ text: markdownTypst(text, doc.version) }]
    };
    return false;
  }
  if (method === 'textDocument/didClose') {
    if (!markdownDocuments.delete(doc?.uri)) return true;
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
    if (msg.method === 'textDocument/didChange' && pendingMarkdownScroll) {
      clearTimeout(markdownScrollTimer);
      markdownScrollTimer = setTimeout(queryMarkdownScroll, 200);
    }
  }
});

// Tinymist -> Zed
new MessageReader(child.stdout, (msg) => {
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
      msg.result.capabilities = {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: 1 },
        codeActionProvider: true,
        documentHighlightProvider: true,
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
