// Document-local Typst term history, adapted from the user's Neovim source.
// No disk history, external services, or dependencies.
const STOP = new Set('and because else exists false for forall if iff implies in let not or set show then true where with'.split(' '));
const CLOSE = { '(': ')', '[': ']', '{': '}' };
const START = /[\p{L}\p{Nl}]/u;
const CONTINUE = /[\p{L}\p{Nl}\p{M}\p{N}-]/u;
const bytes = text => Buffer.byteLength(text, 'utf8');

function nameEnd(text, start, allowNumber = false) {
  const char = String.fromCodePoint(text.codePointAt(start) || 0);
  if (!START.test(char) && !(allowNumber && /[0-9]/.test(char))) return null;
  let i = start + char.length;
  while (i < text.length) {
    const next = String.fromCodePoint(text.codePointAt(i));
    if (!CONTINUE.test(next)) break;
    i += next.length;
  }
  return i;
}

function quotedEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

function blockEnd(text, start) {
  let depth = 1, i = start + 2;
  while (i < text.length && depth) {
    if (text.startsWith('/*', i)) { depth++; i += 2; }
    else if (text.startsWith('*/', i)) { depth--; i += 2; }
    else i++;
  }
  return i;
}

function ignoredEnd(text, i) {
  if (text[i] === '"') return quotedEnd(text, i);
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith('/*', i)) return blockEnd(text, i);
  if (text[i] === '`') {
    let end = i + 1;
    while (text[end] === '`') end++;
    const closing = text.indexOf(text.slice(i, end), end);
    return closing < 0 ? text.length : closing + end - i;
  }
  return null;
}

export function* typstMathRegions(text) {
  let start = null;
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') { i += 2; continue; }
    const ignored = ignoredEnd(text, i);
    if (ignored !== null) { i = ignored; continue; }
    if (text[i] === '$') {
      if (start === null) start = i + 1;
      else { yield { kind: 'math', start, end: i, closed: true }; start = null; }
    }
    i++;
  }
  if (start !== null) yield { kind: 'math', start, end: text.length, closed: false };
}

function balancedEnd(text, start) {
  const stack = [CLOSE[text[start]]];
  for (let i = start + 1; i < text.length;) {
    if (text[i] === '\\') { i += 2; continue; }
    const ignored = ignoredEnd(text, i);
    if (ignored !== null) { i = ignored; continue; }
    if (CLOSE[text[i]]) stack.push(CLOSE[text[i]]);
    else if (text[i] === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i + 1;
    } else if (')]}'.includes(text[i])) return null;
    i++;
  }
  return null;
}

function suffixEnd(text, start) {
  return CLOSE[text[start]] ? balancedEnd(text, start) : nameEnd(text, start, true);
}

export function indexMath(text, regions) {
  const index = new Map();
  const add = (term, last) => {
    const size = bytes(term);
    if (size < 2 || size > 96 || STOP.has(term.toLowerCase())) return;
    const previous = index.get(term);
    if (previous) { previous.count++; previous.last = Math.max(previous.last, last); }
    else if (index.size < 2000) index.set(term, { term, count: 1, last });
  };
  const scan = (source, base, depth = 0) => {
    if (depth > 32) return;
    for (let i = 0; i < source.length;) {
      const ignored = ignoredEnd(source, i);
      if (ignored !== null) { i = ignored; continue; }
      if (source[i] === '\\') { i += 2; continue; }
      const start = i;
      let head = nameEnd(source, i);
      if (head === null) { i++; continue; }
      let composite = false;
      while (head < source.length) {
        const char = source[head];
        const end = char === '.' ? nameEnd(source, head + 1)
          : char === '_' || char === '^' ? suffixEnd(source, head + 1) : null;
        if (end === null) break;
        head = end; composite = true;
      }
      let end = head, simple = false;
      const groups = [], variants = [];
      while (CLOSE[source[end]]) {
        const next = balancedEnd(source, end);
        if (next === null) break;
        groups.push([end + 1, next - 1]);
        const group = source.slice(end, next);
        if (bytes(group) > 50 || /[\s=+*/|<>:]/u.test(group)) break;
        if (simple) variants.push(source.slice(start, end));
        simple = true; end = next;
        while (source[end] === '_' || source[end] === '^') {
          const suffix = suffixEnd(source, end + 1);
          if (suffix === null) break;
          end = suffix;
        }
      }
      add(source.slice(start, simple ? end : head), base + start);
      for (const variant of variants) add(variant, base + start);
      if (simple && composite) add(source.slice(start, head), base + start);
      for (const [first, last] of groups) scan(source.slice(first, last), base + first, depth + 1);
      i = Math.max(head, end);
    }
  };
  for (const region of regions) scan(text.slice(region.start, region.end), region.start);
  return index;
}

function rank(term, query) {
  if (term.startsWith(query)) return 0;
  const folded = term.toLowerCase(), q = query.toLowerCase();
  if (folded.startsWith(q)) return 1;
  let from = 0, at;
  while ((at = folded.indexOf(q, from)) !== -1) {
    if (at === 0 || /[._()[\]{}^\-]/.test(folded[at - 1])) return 2;
    from = at + 1;
  }
  if (bytes(q) >= 2 && folded.includes(q)) return 3;
  if (bytes(q) >= 3) {
    let cursor = 0;
    for (const char of q) {
      const found = folded.indexOf(char, cursor);
      if (found < 0) return null;
      cursor = found + char.length;
    }
    return 4;
  }
  return null;
}

export function searchMath(index, query) {
  if (bytes(query) < 2) return [];
  return [...index.values()].flatMap(item => {
    const value = item.term === query ? null : rank(item.term, query);
    return value === null ? [] : [{ ...item, rank: value }];
  }).sort((a, b) => a.rank - b.rank || b.count - a.count || b.last - a.last ||
    bytes(a.term) - bytes(b.term) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)).slice(0, 40);
}

export function mergeMathCompletions(result, history) {
  const list = Array.isArray(result) ? { items: result } : result || { items: [] };
  const seen = new Set(history.map(item => item.label));
  return { ...list, isIncomplete: true,
    items: [...history, ...(list.items || []).filter(item => !seen.has(item.label))] };
}

export class MathHistory {
  constructor(markdownRegions) {
    this.documents = new Map();
    this.markdownRegions = markdownRegions;
  }
  get(uri) { return this.documents.get(uri); }
  open(uri, text, version, markdown) {
    this.close(uri);
    this.documents.set(uri, { text, version, markdown, index: null, regions: null, timer: null });
  }
  change(uri, text, version) {
    const doc = this.get(uri);
    if (!doc) return;
    doc.text = text; doc.version = version; doc.regions = null;
    clearTimeout(doc.timer);
    doc.timer = setTimeout(() => this.refresh(doc), 180);
    doc.timer.unref();
  }
  close(uri) {
    clearTimeout(this.get(uri)?.timer);
    this.documents.delete(uri);
  }
  regions(doc) {
    return doc.regions ||= [...(doc.markdown ? this.markdownRegions(doc.text) : typstMathRegions(doc.text))];
  }
  refresh(doc) { doc.index = indexMath(doc.text, this.regions(doc)); }
  context(uri, position, offset) {
    const doc = this.get(uri);
    if (!doc || !Number.isInteger(offset) || offset < 0 || offset > doc.text.length) return null;
    const region = this.regions(doc).find(r => offset >= r.start && offset <= r.end);
    if (!region) return null;
    // Being inside dollar math is insufficient when the caret is in a string/comment.
    for (let i = region.start; i < offset;) {
      const end = ignoredEnd(doc.text, i);
      if (end !== null) {
        if (offset < end || (offset === end && (end === doc.text.length || doc.text.startsWith('//', i)))) return null;
        i = end;
      } else i += doc.text[i] === '\\' ? 2 : 1;
    }
    if (!doc.index) this.refresh(doc);
    const prefix = doc.text.slice(region.start, offset).match(/[\p{L}\p{Nl}\p{M}\p{N}_.^\-]+$/u)?.[0] || '';
    const start = { line: position.line, character: position.character - prefix.length };
    if (start.character < 0) return null;
    const items = searchMath(doc.index, prefix).map((match, i) => ({
      label: match.term, kind: 6, filterText: prefix, sortText: String(i).padStart(4, '0'),
      detail: match.count === 1 ? 'Math history' : `Math history · ${match.count} uses`,
      insertTextFormat: 1, textEdit: { range: { start, end: position }, newText: match.term },
      data: { typstPreviewMathHistory: true }
    }));
    return { uri, doc, version: doc.version, text: doc.text, items };
  }
  current(context) {
    return this.get(context.uri) === context.doc && context.doc.version === context.version && context.doc.text === context.text;
  }
}
