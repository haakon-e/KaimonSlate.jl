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
// The REAL ansi.js, not a stand-in: a job's output arrives coloured, and what has to hold is that
// the viewer's classifier reads through the escape codes while its renderer keeps them.
(0, eval)(readFileSync(join(here, '..', '..', 'src', 'assets', 'js', 'ansi.js'), 'utf8'));
let LV;
try { (0, eval)(src); LV = globalThis.slateLogs; } catch (e) {
  console.error('logview: could not evaluate logview.js —', e.message); process.exit(2);
}
if (!LV || !LV._test) { console.error('logview: logview.js exposed no test surface'); process.exit(2); }

const { S, cut, visible, sevOf, setSev, paintLine } = LV._test;
const fails = [];
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) fails.push(`${what}: got ${a}, want ${b}`);
};

// The severity vocabulary is SERVED (Julia's `_LOG_BAD_SRC` and friends), so the viewer classifies
// nothing until it arrives — a second vocabulary written here is the drift this avoids. These are
// the sources Julia sends.
// An escape sequence is accepted wherever a word boundary is, because the chip counts run in
// ripgrep over the raw file where `\e[1mWarning` has no boundary before the `W`.
const SGR = '\\x1b\\[[0-9;]*m', B = '(?:' + SGR + '|\\b)';
setSev({
  declared: '^(?:' + SGR + '|\\s)*[┌\\[](?:' + SGR + '|\\s)*(Error|Warning|Info|Debug)\\b',
  error: [B + '(error|fatal|traceback|exception|segmentation fault|killed|oom|out of memory|exceeded|abort(ed)?)\\b',
          B + '[1-9][0-9]*\\s+(failed|failures?|errors?)\\b'],
  warn: [B + '(warn|warning|deprecat)'],
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

// A Julia log record is several lines and reads in one direction only. Newest-first puts the
// newest RECORD at the top with its own lines still in order; reversing line by line used to put
// the `└` suffix above the `│` fields and the fields backwards.
const recs = '┌ Info: one\n│   a = 1\n│   b = 2\n└ @ Mod f:1\n┌ Info: two\n│   c = 3\n└ @ Mod f:2';
S.pages = [{ from: 0, to: 200, lines: cut(recs, 0) }];
S.filter = 'all';
S.order = 'new';
eq(visible().map(l => l.t),
   ['┌ Info: two', '│   c = 3', '└ @ Mod f:2',
    '┌ Info: one', '│   a = 1', '│   b = 2', '└ @ Mod f:1'],
   'newest record first, each record still in reading order');
S.order = 'old';
eq(visible().map(l => l.t), recs.split('\n'), 'oldest first is the file as written');
// The head flag is what the renderer spaces on, so only a record's first line carries it.
eq(cut(recs, 0).map(l => l.head), [true, false, false, false, true, false, false],
   'only a record head is a head');

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

// ── A record that names its own level ───────────────────────────────────────────────────────
// Julia's logger STATES the level, and that beats reading the sentence: the message of an @info is
// free to mention an error without being one, and the sniffing patterns cannot tell the difference.
eq(sevOf('┌ Info 14:22:31.004: 0 errors so far'), 'info', 'a declared Info that says "errors"');
eq(sevOf('┌ Error 14:22:31.004: the solver gave up'), 'error', 'a declared Error');
eq(sevOf('┌ Warning 14:22:31.004: slow'), 'warn', 'a declared Warning');
eq(sevOf('[ Info 14:22:31.004: single-line form'), 'info', 'the single-line form');
// The logger COLOURS its box characters, so the escape codes arrive before the `┌`. Stripping
// first is what lets the level be seen at all — and note the fallback cannot rescue it either,
// because in `\e[1mError` the `m` of the escape code is a word character, so `\berror\b` fails too.
eq(sevOf('\x1b[31m\x1b[1m┌ \x1b[22m\x1b[39m\x1b[31m\x1b[1mError 14:22:31.004: \x1b[22m\x1b[39mit died'),
   'error', 'a coloured logger record still names its level');
eq(sevOf('\x1b[36m\x1b[1m┌ \x1b[22m\x1b[39m\x1b[36m\x1b[1mInfo 14:22:31.004: \x1b[22m\x1b[39m0 errors so far'),
   'info', 'a coloured Info that says "errors"');

// …and the sniffing patterns still cover everything that declares nothing.
eq(sevOf('slurmstepd: error: Exceeded job memory limit'), 'error', 'undeclared output still sniffs');

// A record's continuation lines are its keyword values and its source location, which are the part
// you actually wanted when you filtered to that level.
const rec = cut([
  '┌ Warning 14:22:31.004: batch is running hot',
  '│   margin = 0.02',
  '│   batch = 3',
  '└ @ Main run.jl:12',
  '[ Info 14:22:31.010: back to nominal',
].join('\n'), 0);
eq(rec.map(l => l.sev), ['warn', 'warn', 'warn', 'warn', 'info'],
   'a logger record is one section');

// ── Output that coloured itself ─────────────────────────────────────────────────────────────
// A job prints through Julia's own colour machinery, so the level word arrives wrapped in escape
// codes. Classifying the raw string would read `\e[31mERROR` and find no word boundary before it.
const red = '\x1b[31mERROR: it died\x1b[0m';
eq(sevOf(red), 'error', 'a coloured error line is still an error');
eq(sevOf('\x1b[33mWarning: slow\x1b[0m'), 'warn', 'a coloured warning is still a warning');

// …and the colour is KEPT when it is rendered, rather than escaped into visible junk.
const painted = paintLine(red, '');
if (!/ansi-fg-1/.test(painted)) fails.push('paintLine dropped the line\'s own colour');
if (painted.indexOf('\x1b') >= 0) fails.push('paintLine left a raw escape code in the markup');

// Byte offsets count the escape codes, because the file contains them: a search hit's offset comes
// from ripgrep, which reads the bytes on disk and knows nothing about what renders.
const coloured = cut(red + '\nnext', 0);
eq(coloured.map(l => l.o), [0, red.length + 1], 'offsets span the escape codes');

if (fails.length) { fails.forEach(f => console.error('logview:', f)); process.exit(1); }
console.log('logview: ok');
