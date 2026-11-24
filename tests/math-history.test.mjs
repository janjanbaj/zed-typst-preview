import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { indexMath, searchMath, typstMathRegions, MathHistory, mergeMathCompletions } from '../math-history.mjs';

const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function typstString'), source.indexOf("if (!tinymistArgs.includes"));
const { typstCompletionRegions } = vm.runInNewContext(helpers + ';({typstCompletionRegions})', { URL });
const markdownRegions = text => [...typstCompletionRegions(text)].filter(r => r.kind === 'math');
const index = (text, markdown = false) => indexMath(text, markdown ? markdownRegions(text) : typstMathRegions(text));

function at(marked) {
  const offset = marked.indexOf('│');
  assert.ok(offset >= 0);
  const text = marked.replace('│', '');
  const before = text.slice(0, offset);
  return { text, offset, position: { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 } };
}

for (const markdown of [false, true]) {
  const mode = markdown ? 'Markdown' : 'Typst';
  test(`${mode}: indexes contiguous calls, scripts, dotted variables, and Unicode`, () => {
    const found = index('$cal(H) + E_(n)^2 + alpha_i + alpha_i + arrow.r + Γ_n + f(x)(y)$', markdown);
    for (const term of ['cal(H)', 'E_(n)^2', 'alpha_i', 'arrow.r', 'Γ_n', 'f(x)', 'f(x)(y)']) assert.ok(found.has(term), term);
    assert.equal(found.get('alpha_i').count, 2);
    assert.ok(!found.has('H'));
    assert.ok(!index('$if x and y + f(a + b)$', markdown).has('f(a + b)'));
    assert.ok(!index('$' + 'x'.repeat(97) + '$', markdown).has('x'.repeat(97)));
  });

  test(`${mode}: respects math context and returns a UTF-16 source edit`, () => {
    const history = new MathHistory(markdownRegions);
    const fixture = at('$alpha_i + alpha_i$\r\n😀 $al│$');
    history.open('one', fixture.text, 1, markdown);
    const context = history.context('one', fixture.position, fixture.offset);
    const item = context.items.find(i => i.label === 'alpha_i');
    assert.ok(item);
    assert.equal(item.insertTextFormat, 1);
    assert.equal(item.detail, 'Math history · 2 uses');
    assert.deepEqual(item.textEdit.range, { start: { line: 1, character: 4 }, end: { line: 1, character: 6 } });
    const updated = fixture.text.slice(0, fixture.offset - 2) + item.textEdit.newText + fixture.text.slice(fixture.offset);
    assert.equal(updated, '$alpha_i + alpha_i$\r\n😀 $alpha_i$');
    history.open('two', '$al$', 1, markdown);
    assert.equal(history.context('two', { line: 0, character: 3 }, 3).items.length, 0);
    history.close('one'); history.close('two');
  });
}

test('padded Markdown math retains history source edits', () => {
  const history = new MathHistory(markdownRegions);
  const fixture = at('$ alpha_i $\n😀 $ al│ $');
  history.open('one', fixture.text, 1, true);
  const item = history.context('one', fixture.position, fixture.offset).items.find(i => i.label === 'alpha_i');
  assert.ok(item);
  assert.deepEqual(item.textEdit.range, { start: { line: 1, character: 5 }, end: { line: 1, character: 7 } });
  history.close('one');
});

test('search ranks prefix, frequency, recency, boundaries and fuzzy matches like the original source', () => {
  const found = index('$alpha_i + alpha_i + alpha_k + alpha_j + cal(H) + arrow.r$');
  assert.deepEqual(searchMath(found, 'al').slice(0, 3).map(m => m.term), ['alpha_i', 'alpha_j', 'alpha_k']);
  assert.ok(searchMath(found, 'r.r').some(m => m.term === 'arrow.r'));
  assert.ok(searchMath(found, 'aw.r').some(m => m.term === 'arrow.r'));
  assert.deepEqual(searchMath(found, 'a'), []);
  assert.ok(!searchMath(found, 'alpha_i').some(m => m.term === 'alpha_i'));
  assert.ok(searchMath(index('$' + Array.from({ length: 60 }, (_, i) => `alpha_${i}`).join(' + ') + '$'), 'al').length === 40);
});

test('Markdown excludes headers, prose, escaped dollars, inline and fenced/indented code', () => {
  const text = '"""\n#let prose = "$header_symbol$"\n"""\nprose_symbol\n\\$escaped_symbol\n' +
    '`$inline_symbol$`\n```typst\n$fenced_symbol$\n```\n    $indented_symbol$\n$valid_symbol$\n$$\ndisplay_symbol\n$$';
  assert.deepEqual([...index(text, true).keys()], ['valid_symbol', 'display_symbol']);
});

test('Typst supports multiline dollar math and excludes raw text, strings and nested comments', () => {
  const text = '#let s = "$string_symbol$"\n// $line_symbol$\n/* outer /* $nested_symbol$ */ $block_symbol$ */\n' +
    '```typst\n$raw_symbol$\n```\n\\$escaped_symbol\n$\nvalid_symbol + "quoted_symbol" /* hidden_symbol */\n$';
  assert.deepEqual([...index(text).keys()], ['valid_symbol']);
  const history = new MathHistory(markdownRegions);
  for (const marked of ['$alpha_i$ prose al│', '$alpha_i + "al│"$', '$alpha_i // al│\n$', '$alpha_i /* al│ */$']) {
    const fixture = at(marked);
    history.open('one', fixture.text, 1, false);
    assert.equal(history.context('one', fixture.position, fixture.offset), null, marked);
  }
  history.close('one');
});

test('edits refresh after debounce and close/reopen invalidates pending contexts', async () => {
  const history = new MathHistory(markdownRegions);
  const before = at('$alpha_i$\n$al│$');
  history.open('one', before.text, 1, false);
  const context = history.context('one', before.position, before.offset);
  assert.ok(context.items.length);
  const after = at('$beta_i$\n$be│$');
  history.change('one', after.text, 2);
  assert.equal(history.current(context), false);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.ok(!history.get('one').index.has('alpha_i'));
  assert.ok(history.context('one', after.position, after.offset).items.some(i => i.label === 'beta_i'));
  history.close('one');
  assert.equal(history.get('one'), undefined);
  history.open('one', before.text, 1, false);
  assert.equal(history.current(context), false);
  history.close('one');
});

test('merging preserves Tinymist item defaults and snippets without duplicate history labels', () => {
  const history = [{ label: 'alpha_i', insertTextFormat: 1 }];
  const defaults = { insertTextFormat: 2 };
  const merged = mergeMathCompletions({ itemDefaults: defaults, items: [{ label: 'alpha_i' }, { label: 'frac', insertText: 'frac(${1:a}, ${2:b})' }] }, history);
  assert.deepEqual(merged.items.map(i => i.label), ['alpha_i', 'frac']);
  assert.equal(merged.itemDefaults, defaults);
  assert.equal(merged.items[1].insertText, 'frac(${1:a}, ${2:b})');
  assert.equal(merged.isIncomplete, true);
  assert.equal(mergeMathCompletions(null, history).items.length, 1);
});
