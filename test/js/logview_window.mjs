// Asserts src/assets/js/logview.js — the addressing the log viewer is built on.
//
// The viewer never holds a file, only a window onto one, and every position in it is a BYTE offset
// because that is what `log_search` reports and what `log_slice` seeks to. An off-by-one here does
// not look like an off-by-one: it looks like the highlight landing on the neighbouring line, or a
// page that overlaps the one before it by a character. So the arithmetic is pinned directly.
//
//   node test/js/logview_window.mjs      # exit 0 = pass, 1 = mismatch, 2 = load failure
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'src', 'assets', 'js', 'logview.js'), 'utf8');

globalThis.window = globalThis;
globalThis.document = { createElement: () => ({ style: {} }), body: { appendChild() {} },
                        addEventListener() {} };
// The page's shared escaper (core.js). Stood in rather than re-implemented: `esc_html.mjs` exists
// to keep exactly one definition of it in the tree, and a second one here would be the thing it
// forbids, in the file that is meant to know better.
globalThis.slateEscHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let LV;
try { (0, eval)(src); LV = globalThis.slateLogs; } catch (e) {
  console.error('logview: could not evaluate logview.js —', e.message); process.exit(2);
}
if (!LV || !LV._test) { console.error('logview: logview.js exposed no test surface'); process.exit(2); }

const { S, cut, visible, sevOf, setSev } = LV._test;
const fails = [];
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) fails.push(`${what}: got ${a}, want ${b}`);
};

// The severity vocabulary is SERVED (Julia's `_LOG_BAD_SRC` and friends), so the viewer classifies
// nothing until it arrives — a second vocabulary written here is the drift this avoids. These are
// the sources Julia sends.
setSev({
  error: ['\\b(error|fatal|traceback|exception|segmentation fault|killed|oom|out of memory|exceeded|abort(ed)?)\\b',
          '\\b(?!0\\b)\\d+\\s+(failed|failures?|errors?)\\b'],
  warn: ['\\b(warn|warning|deprecat)'],
});

eq(sevOf('ERROR: LoadError'), 'error', 'an error line');
eq(sevOf('slurmstepd: error: Exceeded job memory limit'), 'error', 'a scheduler kill');
eq(sevOf('chunk c1: 1 ran, 0 skipped, 3 failed of 4'), 'error', 'a non-zero failure count');
// The runner's own success line is the most common line in a healthy log; colouring it red makes
// every good run look like the thing you are hunting for.
eq(sevOf('chunk c1: 4 ran, 0 skipped, 0 failed of 4'), 'info', 'a zero failure count');
eq(sevOf('Warning: assignment in soft scope'), 'warn', 'a warning');
eq(sevOf('Precompiling MyPkg'), 'info', 'an ordinary line');

// ── Byte offsets, not character counts ──────────────────────────────────────────────────────
// A page starts at the byte `log_slice` said it did, and each line after it is offset by the BYTES
// of what preceded — so a log that says anything non-ASCII does not shift every subsequent line.
const ascii = cut('alpha\nbeta\ngamma', 1000);
eq(ascii.map(l => l.o), [1000, 1006, 1011], 'ascii line offsets');

// 'é' is two bytes in UTF-8 and one JavaScript character. Counting characters would report the
// next line one byte early, and the search highlight would land on the wrong one.
const wide = cut('café\nnext', 0);
eq(wide.map(l => l.o), [0, 6], 'offsets past a multi-byte character');
eq(wide.map(l => l.t), ['café', 'next'], 'the text itself is unchanged');

// ── Which end is the top ────────────────────────────────────────────────────────────────────
// Pages are held ascending by `from` whichever way they are read, so paging never has to know
// which direction the reader is going. Only the paint order flips.
S.pages = [{ from: 0, to: 11, lines: cut('one\ntwo', 0) },
           { from: 12, to: 23, lines: cut('three\nfour', 12) }];
S.filter = 'all';

S.order = 'old';
eq(visible().map(l => l.t), ['one', 'two', 'three', 'four'], 'oldest first');
S.order = 'new';
eq(visible().map(l => l.t), ['four', 'three', 'two', 'one'], 'newest first');
// …and the offsets travel with the lines rather than being re-derived from their new position.
eq(visible().map(l => l.o), [18, 12, 4, 0], 'offsets survive the reversal');

// ── The level filter ────────────────────────────────────────────────────────────────────────
S.pages = [{ from: 0, to: 99, lines: cut('starting up\nWarning: slow\nERROR: died\nbye', 0) }];
S.order = 'old';
S.filter = 'all';
eq(visible().length, 4, 'all shows everything');
S.filter = 'error';
eq(visible().map(l => l.t), ['ERROR: died'], 'error shows only errors');
S.filter = 'warn';
eq(visible().map(l => l.t), ['Warning: slow'], 'warn shows only warnings');
S.filter = 'info';
eq(visible().map(l => l.t), ['starting up', 'bye'], 'info is what is left');

// ── Severity runs in sections ───────────────────────────────────────────────────────────────
// The sentence that says a job died is one line; the reason is the indented frames under it. If
// those classify on their own words they become ordinary output, and the error filter then shows
// the headline of every problem and the detail of none.
const trace = cut([
  'Precompiling MyPkg',
  'ERROR: LoadError: UndefVarError: `trial` not defined',
  'Stacktrace:',
  ' [1] top-level scope',
  '   @ /home/u/run.jl:12',
  '',
  'done',
].join('\n'), 0);
eq(trace.map(l => l.sev),
   ['info', 'error', 'error', 'error', 'error', 'error', 'info'],
   'a traceback is one error section');

// …and a warning section closes when ordinary output resumes, rather than staining the rest.
const warns = cut('Warning: slow\n  retrying\nall fine\nmore', 0);
eq(warns.map(l => l.sev), ['warn', 'warn', 'info', 'info'], 'a section ends at the next entry');

// A continuation that names something worse than its section keeps its own level: an indented
// line reading ERROR is an error wherever it sits.
const worse = cut('Warning: slow\n  ERROR: and then it died', 0);
eq(worse.map(l => l.sev), ['warn', 'error'], 'a continuation may name a worse level');

if (fails.length) { fails.forEach(f => console.error('logview:', f)); process.exit(1); }
console.log('logview: ok');
