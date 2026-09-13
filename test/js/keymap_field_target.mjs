// Asserts `_isField` from keymap.js — whether a keystroke belongs to a control or to the notebook.
//
// Command mode puts whole commands on BARE letters: `w` converts a cell to a web cell, `d d` deletes
// it, `m` and `y` change its kind. So this predicate is the only thing standing between typing into a
// widget and silently restructuring the document. It answered with a tag-name test at first, which was
// wrong the moment a widget was not an `<input>`: MultiSelect renders a focusable `div[role=listbox]`,
// and typing `w` in one converted the cell.
//
// The other half matters just as much and pulls the opposite way. An interactive chart is given
// `tabindex="-1"` and focused on click (settings.js `pointerdown`), so a predicate written as "is this
// focusable" would swallow every command-mode key for the rest of the session after one click on a
// plot. What is asked instead is whether the target sits inside a CONTROL REGION.
//
//   node test/js/keymap_field_target.mjs      # exit 0 = pass, 1 = mismatch, 2 = extraction failure
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'src', 'assets', 'js', 'keymap.js'), 'utf8');

function sliceFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) { console.error('keymap_field_target: could not locate ' + name); process.exit(2); }
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  console.error('keymap_field_target: unbalanced braces in ' + name); process.exit(2);
}
// `_isField` reads two consts declared beside it; take them from the source too rather than restating
// them here, so the test cannot drift from the list the app actually uses.
const grabConst = name => {
  const m = new RegExp('const ' + name + ' = ([^;]+);').exec(src);
  if (!m) { console.error('keymap_field_target: could not read ' + name); process.exit(2); }
  return `const ${name} = ${m[1]};`;
};

const isField = new Function(`
  ${grabConst('_FIELD_TAGS')}
  ${grabConst('_CONTROL_REGION')}
  ${sliceFn('_isField')}
  return _isField;
`)();

// Enough of a DOM for the predicate: a tag, a class, a parent chain, and a `closest` that understands
// the comma-separated class list the region selector is written as.
function el(tag, cls, parent) {
  const node = {
    tagName: tag, className: cls || '', isContentEditable: false, parentElement: parent || null,
    closest(sel) {
      const want = sel.split(',').map(s => s.trim().replace(/^\./, ''));
      for (let n = node; n; n = n.parentElement) {
        const classes = (n.className || '').split(/\s+/).filter(Boolean);
        if (want.some(w => classes.includes(w))) return n;
      }
      return null;
    },
  };
  return node;
}

const fails = [];
const is = (what, got, want) => { if (got !== want) fails.push(`${what}: ${got} (expected ${want})`); };

// ── Controls own their keys ───────────────────────────────────────────────────
is('a text input', isField(el('INPUT', '')), true);
is('a textarea', isField(el('TEXTAREA', '')), true);
is('a select', isField(el('SELECT', '')), true);
is('a button', isField(el('BUTTON', 'actionbtn')), true);
const ce = el('DIV', ''); ce.isContentEditable = true;
is('a contenteditable', isField(ce), true);

// The reported bug: MultiSelect is a focusable div, and it lives in a bind row.
const binds = el('DIV', 'binds', el('DIV', 'cell'));
is('a MultiSelect listbox', isField(el('DIV', 'mslist', el('DIV', 'widget', binds))), true);
// Anything else a widget might render, including something a package contributed.
is('a tableselect grid', isField(el('DIV', 'tablesel slatetable', el('DIV', 'widget', binds))), true);
is('an extension custom widget', isField(el('CANVAS', '', el('SPAN', 'customwidget', binds))), true);
is('a bare span inside a bind row', isField(el('SPAN', 'optlbl', el('DIV', 'widget', binds))), true);
// A control surfaced into a cell's strip is the same widget in a different place.
const strip = el('DIV', 'controls', el('DIV', 'cell'));
is('a control in a surfaced strip', isField(el('DIV', 'mslist', el('DIV', 'control', strip))), true);
// The cell editor.
is('the code editor', isField(el('DIV', 'cm-content', el('DIV', 'cm-editor', el('DIV', 'cell')))), true);

// ── The notebook owns everything else ─────────────────────────────────────────
// A false positive here is worse than the bug it guards: it silently disables command mode.
is('the page background', isField(el('BODY', '')), false);
is('a cell body', isField(el('DIV', 'cell', el('DIV', 'page'))), false);
is('cell output', isField(el('DIV', 'output', el('DIV', 'cell'))), false);
// An interactive chart is FOCUSABLE (tabindex=-1, focused on click) and must still leave the keys to
// command mode. This is why the predicate does not ask about focusability.
is('a focused chart', isField(el('DIV', 'echart', el('DIV', 'output', el('DIV', 'cell')))), false);
is('an inline chart in markdown', isField(el('CANVAS', '', el('DIV', 'ichart', el('DIV', 'md')))), false);
is('a cell header', isField(el('DIV', 'cellhead', el('DIV', 'cell'))), false);
is('rendered markdown', isField(el('P', '', el('DIV', 'md', el('DIV', 'cell')))), false);
// Non-elements reach it too (a text node, null) and must not throw or match.
is('null', isField(null), false);
is('a text node', isField({ nodeType: 3 }), false);

if (fails.length) { console.error('keymap_field_target FAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('keymap_field_target: ok');
