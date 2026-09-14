// The log viewer — reading a job's output when the file is larger than anything worth sending.
//
// A sweep's output has no size bound. A cluster job that loads packages for ten minutes and then
// dies writes hundreds of MB of nothing followed by the one sentence you need, and the fabric can
// produce thousands of such files. So this never holds a file: it holds a WINDOW onto one.
//
// Byte offsets are the addressing throughout, never line numbers. A line number cannot be resolved
// to a position without counting newlines from the start of the file, which is the one thing a
// gigabyte forbids — while an offset is a seek, and `log_search` reports one per match. That single
// choice is what makes "jump to the 4000th match in a 1GB file" cost the same as jumping to the
// first.
//
// Three server actions, all on the sweep card's own channel (`sweeps.js` records it, so the file
// list can span every sweep in the notebook rather than only the card you pressed):
//   log_stat   {bytes, modified}          — a poll, cheap enough to run while you read
//   log_slice  {text, from, to, size}     — one window, trimmed to whole lines
//   log_search {total, hits, capped}      — the WHOLE file, wherever it lives
(function () {
  const PAGE = 1 << 16;        // bytes per window; a few hundred lines, one round trip
  const MAXPAGES = 24;         // ~1.5MB of DOM before the far end is dropped
  const POLL_MS = 3000;        // how often a live file is re-stated (not re-read)
  const NEAR = 600;            // px from the scroll edge that counts as "asking for more"
  const HIT_LIMIT = 2000;      // hits carried back; `total` still counts the whole file

  const esc = s => window.slateEscHtml(s);
  const bytes = b => (b == null || b < 0) ? '—' : window.slateBytes(b);
  const when = u => !u ? '' : new Date(u * 1000).toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ── What counts as an error ────────────────────────────────────────────────────────────────
  // Served by the `logs` action rather than written here, so the viewer's filter and the card's
  // colouring cannot disagree about the same line. Until one arrives, nothing is classified —
  // guessing with a second vocabulary is what this avoids.
  let SEV = null;
  function setSev(spec) {
    if (!spec) return;
    const one = src => { try { return new RegExp(src); } catch (e) { return null; } };
    const build = a => (a || []).map(src => { try { return new RegExp(src, 'i'); } catch (e) { return null; } })
                                .filter(Boolean);
    SEV = { declared: one(spec.declared), error: build(spec.error), warn: build(spec.warn) };
  }
  const LVL = { Error: 'error', Warning: 'warn', Info: 'info', Debug: 'info' };
  // A line that NAMES its level is believed and nothing else is consulted: `@info "0 errors so far"`
  // contains the word and is not one. Word-sniffing is the fallback for output that declares
  // nothing — a bare `println`, a C library, the scheduler's own messages.
  //
  // Colour codes come off first either way, or an escape sequence sitting between `Error` and its
  // word boundary stops it being one.
  function sevOf(line) {
    if (!SEV) return 'info';
    const t = line.indexOf('\x1b') < 0 ? line : window.slateAnsiText(line);
    if (SEV.declared) {
      const m = SEV.declared.exec(t);
      if (m) return LVL[m[1]] || 'info';
    }
    if (SEV.error.some(re => re.test(t))) return 'error';
    if (SEV.warn.some(re => re.test(t))) return 'warn';
    return 'info';
  }

  // ── Colouring one line ─────────────────────────────────────────────────────────────────────
  // Escape FIRST, then decorate. Matching raw text and escaping after would let a log line's own
  // angle brackets close a span the match had just opened.
  const TOK = [
    [/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/g, 'logv-t'],   // timestamp
    [/(\/[\w./+-]+:\d+)/g, 'logv-p'],                                       // path:line
    [/(\b\d+(?:\.\d+)?\b)/g, 'logv-n'],                                     // numbers
  ];
  // A line that COLOURED ITSELF is rendered as it asked to be, and nothing else is applied to it:
  // the tokeniser and the search mark are regexes over markup, and over `<span class="ansi-fg-1">`
  // they would match inside the attributes they had just written. A coloured hit is still located
  // and still gets the row highlight; it just does not get the needle underlined inside it.
  const hasAnsi = s => s.indexOf('\x1b') >= 0;
  function paintLine(text, mark) {
    if (hasAnsi(text)) return window.slateAnsiHtml(text);
    let h = esc(text);
    for (const [re, cls] of TOK) h = h.replace(re, `<span class="${cls}">$1</span>`);
    // The search term last, so a hit inside a token still shows — and on the ESCAPED text, which
    // is why the needle is escaped too rather than matched against the raw line.
    if (mark) {
      try {
        h = h.replace(new RegExp('(' + mark + ')', 'gi'), '<mark>$1</mark>');
      } catch (e) { /* an unbalanced regex from the search box is not worth failing a redraw for */ }
    }
    return h;
  }

  // ── State ──────────────────────────────────────────────────────────────────────────────────
  // `pages` is always ascending by `from`; the ORDER toggle decides which end is painted first,
  // so paging logic never has to care which way the reader is reading.
  const S = {
    key: '', ch: '', files: [], path: '', size: 0,
    pages: [], order: 'new', filter: 'all', paused: false,
    sort: { key: 'modified', dir: -1 }, needle: '', icase: true, rx: false,
    hits: null, rawHits: null, hitAt: -1, total: 0, capped: false, counts: null, loading: false, timer: 0, behind: 0,
  };

  const call = (action, arg, opts) =>
    window.slateCall(S.ch, Object.assign({ action, arg: arg || '' }, opts || {}));

  // ── Chrome ─────────────────────────────────────────────────────────────────────────────────
  let el = null;
  function build() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'modal-bg logv-bg';
    el.innerHTML = `
      <div class="modal logv">
        <div class="logv-head">
          <strong>Job output</strong>
          <select class="logv-sweep" title="which sweep in this notebook"></select>
          <span class="logv-err"></span>
          <button class="logv-x" title="close">✕</button>
        </div>
        <div class="logv-body">
          <div class="logv-side">
            <input class="logv-ffilter" type="search" placeholder="filter files or nodes…" spellcheck="false"/>
            <div class="logv-files"></div>
          </div>
          <div class="logv-main">
            <div class="logv-bar">
              <div class="logv-levels">
                <button data-lv="all" class="on">all</button>
                <button data-lv="info">info</button>
                <button data-lv="warn">warn</button>
                <button data-lv="error">error</button>
              </div>
              <input class="logv-search" type="search" placeholder="search this file…" spellcheck="false"/>
              <button class="logv-icase on" title="ignore case">Aa</button>
              <button class="logv-rx" title="regular expression">.*</button>
              <span class="logv-hits"></span>
              <button class="logv-prev" title="previous match">▲</button>
              <button class="logv-next" title="next match">▼</button>
            </div>
            <div class="logv-bar2">
              <button class="logv-order" title="newest first"></button>
              <button class="logv-pause" title="stop following the file"></button>
              <span class="logv-meta"></span>
              <button class="logv-jump" style="display:none">new output</button>
            </div>
            <div class="logv-pane"><pre class="logv-pre"></pre></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    wire();
    return el;
  }

  const q = sel => el.querySelector(sel);

  function wire() {
    q('.logv-x').onclick = close;
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.addEventListener('keydown', e => {
      if (!open_()) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    q('.logv-sweep').onchange = e => selectSweep(e.target.value);
    q('.logv-ffilter').oninput = paintFiles;
    q('.logv-levels').addEventListener('click', e => {
      const b = e.target.closest('[data-lv]');
      if (!b) return;
      S.filter = b.dataset.lv; refilterHits(); paintBar(); paintPre();
    });
    q('.logv-order').onclick = () => {
      S.order = S.order === 'new' ? 'old' : 'new';
      reload();
    };
    q('.logv-pause').onclick = () => { S.paused = !S.paused; paintBar(); };
    q('.logv-icase').onclick = () => { S.icase = !S.icase; paintBar(); runSearch(); };
    q('.logv-rx').onclick = () => { S.rx = !S.rx; paintBar(); runSearch(); };
    q('.logv-search').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? step(-1) : (S.hits ? step(1) : runSearch()); }
    });
    q('.logv-search').oninput = e => {
      if (e.target.value !== S.needle) { S.hits = null; S.rawHits = null; S.hitAt = -1; paintBar(); }
    };
    q('.logv-prev').onclick = () => step(-1);
    q('.logv-next').onclick = () => step(1);
    q('.logv-jump').onclick = () => { S.behind = 0; reload(); };
    q('.logv-pane').addEventListener('scroll', onScroll);
  }

  const open_ = () => el && el.classList.contains('show');

  function close() {
    if (S.timer) { clearInterval(S.timer); S.timer = 0; }
    if (el) el.classList.remove('show');
  }

  function fail(e) { q('.logv-err').textContent = e ? String(e && e.message || e).slice(0, 200) : ''; }

  // ── Opening ────────────────────────────────────────────────────────────────────────────────
  function open(key, ch) {
    build();
    el.classList.add('show');
    S.key = key; S.ch = ch || chanOf(key);
    paintSweeps();
    loadFiles();
    if (!S.timer) S.timer = setInterval(poll, POLL_MS);
  }

  // Every sweep in the notebook, from the registry each card reports into. A sweep with no channel
  // yet (a card that has not painted once) is not offered: there would be nothing to ask.
  const entries = () => (window.slateSweeps ? window.slateSweeps.all() : []).filter(s => s.ch);
  const chanOf = key => (entries().find(s => s.key === key) || {}).ch || '';

  function paintSweeps() {
    const sel = q('.logv-sweep'), all = entries();
    // Named by the CELL, which is what a reader recognises and can scroll to. A run key is a hash
    // of what the sweep IS, which makes it stable and unreadable in equal measure.
    sel.innerHTML = all.map(s => {
      const st = s.status || {};
      const lbl = s.cellId || st.id || s.key;
      return `<option value="${esc(s.key)}"${s.key === S.key ? ' selected' : ''}>${
        esc(lbl)}${st.state ? esc(' · ' + st.state) : ''}</option>`;
    }).join('');
    sel.style.display = all.length > 1 ? '' : 'none';
  }

  function selectSweep(key) {
    S.key = key; S.ch = chanOf(key);
    S.path = ''; S.pages = []; S.hits = null; S.counts = null;
    loadFiles();
  }

  function loadFiles() {
    fail('');
    call('logs').then(s => {
      setSev(s.logsev);
      S.files = s.loglist || [];
      if (s.logerr) fail(s.logerr);
      paintFiles();
      // The newest file is the one press that is almost always right: a job that died explains
      // itself in the element that died, and that is the one at the top.
      const want = S.files.find(f => f.path === S.path) || S.files[0];
      if (want) selectFile(want.path); else paintPre();
    }).catch(fail);
  }

  // ── The file table ─────────────────────────────────────────────────────────────────────────
  // The FILENAME is `<job>.<step>.log`, where the job is a hash of the sweep — the same twenty
  // characters on every row, and nothing a reader can tell apart. What distinguishes one file from
  // another is which array task wrote it, where it ran, and how it ended, so those are the columns.
  // The name is still there, in the row's tooltip, for when you need to name one to someone else.
  //
  // How a chunk ENDED, from its own status file: no scheduler is asked, so this is as true for a
  // laptop as for a queue, and a file with no status yet says so rather than claiming success.
  function fileStatus(f) {
    if (f.failed > 0) return { txt: f.failed + ' failed', cls: 'error', ord: 3 };
    if (f.total > 0 && f.done >= f.total) return { txt: 'ok', cls: 'ok', ord: 1 };
    if (f.done > 0) return { txt: f.done + '/' + f.total, cls: 'run', ord: 2 };
    return { txt: '—', cls: 'none', ord: 0 };
  }

  // A sweep is reconciled, so re-running it submits the work that is still missing as a NEW job —
  // and the array index restarts at 1 in each. Two rows reading `#1` are then two different files,
  // which is only confusing, so the submission is a column whenever there is more than one of them.
  const jobs = () => [...new Set(S.files.map(f => f.job))];
  const jobTag = j => { const i = jobs().indexOf(j); return i < 0 ? '' : 'j' + (i + 1); };

  const COLS = [
    ['job', 'job', f => jobTag(f.job), 'which submission'],
    ['step', '#', f => f.step, 'array task within its submission'],
    ['bytes', 'size', f => f.bytes, 'file size'],
    ['modified', 'modified', f => f.modified, 'last written'],
    ['node', 'node', f => f.node || '', 'where it ran'],
    ['pid', 'pid', f => f.pid || 0, 'the process that ran it'],
    ['status', 'status', f => fileStatus(f).ord, 'how its chunk ended'],
  ];
  // A column earns its place only when it says something. `job` distinguishes nothing until there
  // are two submissions; `pid` is only knowable for work this machine started, and a scheduler
  // identifies its own by job id instead.
  const anyPid = () => S.files.some(f => f.pid > 0);
  const cols = () => COLS.filter(c => c[0] === 'job' ? jobs().length > 1 :
                                      c[0] === 'pid' ? anyPid() : true);

  function sortedFiles() {
    const t = (q('.logv-ffilter').value || '').toLowerCase();
    const fs = S.files.filter(f => !t ||
      f.name.toLowerCase().includes(t) || (f.node || '').toLowerCase().includes(t) ||
      (f.chunk || '').toLowerCase().includes(t) || String(f.pid || '').includes(t));
    const col = COLS.find(c => c[0] === S.sort.key) || COLS[3];
    const get = col[2], dir = S.sort.dir;
    return fs.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      const c = (typeof x === 'string') ? x.localeCompare(y) : (x - y);
      // Job then step breaks every tie, so the order is total and a repaint cannot reshuffle rows
      // that compare equal on the chosen column.
      return (c || a.job.localeCompare(b.job) || (a.step - b.step)) * dir;
    });
  }

  function paintFiles() {
    const host = q('.logv-files'), fs = sortedFiles();
    if (!S.files.length) {
      host.innerHTML = `<div class="logv-none">No job output yet. A scheduler writes it once the
        job starts, and PBS only copies it back when the job ends.</div>`;
      return;
    }
    const arrow = k => S.sort.key !== k ? '' : (S.sort.dir < 0 ? ' ▾' : ' ▴');
    const show = cols();
    const head = show.map(([k, label, , hint]) =>
      `<th data-k="${k}" title="${esc(hint)}" class="${S.sort.key === k ? 'on' : ''}">${
        esc(label)}<span class="logv-arr">${arrow(k)}</span></th>`).join('');
    const rows = fs.map(f => {
      const st = fileStatus(f);
      return `<tr class="${f.path === S.path ? 'on' : ''}" data-p="${esc(f.path)}"
        title="${esc(f.name)}${f.chunk ? '\n' + esc(f.chunk) : ''}">
        ${show[0][0] === 'job' ? `<td class="logv-job">${esc(jobTag(f.job))}</td>` : ''}
        <td class="logv-step">${f.step || '—'}</td>
        <td class="logv-num">${bytes(f.bytes)}</td>
        <td class="logv-when">${esc(when(f.modified))}</td>
        <td class="logv-node">${esc(f.node || '—')}</td>
        ${anyPid() ? `<td class="logv-pid">${f.pid || '—'}</td>` : ''}
        <td class="logv-st logv-st-${st.cls}">${esc(st.txt)}</td></tr>`;
    }).join('');
    host.innerHTML = `<table class="logv-tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    host.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      // Same column toggles direction; a new column starts in the order that column is usually
      // read — newest and largest first, names and nodes A to Z.
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir }
                                : { key: k, dir: (k === 'node') ? 1 : -1 };
      paintFiles();
    });
    host.querySelectorAll('tr[data-p]').forEach(r => r.onclick = () => selectFile(r.dataset.p));
  }

  function selectFile(path) {
    S.path = path; S.hits = null; S.rawHits = null; S.hitAt = -1; S.counts = null; S.needle = '';
    q('.logv-search').value = '';
    paintFiles();
    reload();
    countLevels();
  }

  // ── The window ─────────────────────────────────────────────────────────────────────────────
  // Opening at the newest end needs no knowledge of the size: a negative offset counts back from
  // the end of the file, which is what makes the first page one round trip rather than two.
  function reload() {
    S.pages = []; S.behind = 0;
    q('.logv-jump').style.display = 'none';
    const at = S.order === 'new' ? -PAGE : 0;
    fetchPage(at).then(() => { q('.logv-pane').scrollTop = 0; });
  }

  function fetchPage(offset) {
    if (S.loading || !S.path) return Promise.resolve();
    S.loading = true;
    const pane = q('.logv-pane');
    const h0 = pane.scrollHeight, t0 = pane.scrollTop;
    let trimmed = false;
    return call('log_slice', S.path, { offset, nbytes: PAGE }).then(p => {
      S.size = p.size;
      if (p.text) {
        // Ascending by `from`, deduped: a poll and a scroll can both ask for the same window.
        if (!S.pages.some(x => x.from === p.from)) {
          S.pages.push({ from: p.from, to: p.to, lines: cut(p.text, p.from) });
          S.pages.sort((a, b) => a.from - b.from);
          // You always scroll DOWNWARD into content you have not read, whichever end is the top,
          // so the page to shed is always the one at the top — `pop` in newest-first, `shift` in
          // oldest-first, both naming the first page painted.
          const drop = S.order === 'new' ? 'pop' : 'shift';
          while (S.pages.length > MAXPAGES) { S.pages[drop](); trimmed = true; }
        }
      }
      paintPre(); paintBar();
      // Removing a page from ABOVE the viewport moves everything under the reader by its height.
      // Put the scroll back where the text is, rather than where the offset happens to land.
      if (trimmed) pane.scrollTop = Math.max(0, t0 + (pane.scrollHeight - h0));
    }).catch(fail).then(() => { S.loading = false; });
  }

  // Which window comes next depends only on which end is at the top: scrolling DOWN always means
  // "more of what I have not seen", and the order decides whether that is older or newer.
  function onScroll() {
    const pane = q('.logv-pane');
    if (pane.scrollTop + pane.clientHeight < pane.scrollHeight - NEAR) return;
    if (!S.pages.length || S.loading) return;
    if (S.order === 'new') {
      const lo = S.pages[0].from;
      if (lo > 0) fetchPage(Math.max(0, lo - PAGE));
    } else {
      const hi = S.pages[S.pages.length - 1].to;
      if (hi + 1 < S.size) fetchPage(hi + 1);
    }
  }

  // One page into lines, each carrying the BYTE offset it starts at — which is the address a search
  // hit comes back as, so a character count would put the highlight on the wrong line the moment a
  // log said anything non-ASCII. Done once, when the page lands, rather than on every repaint:
  // `sevOf` runs a handful of regexes and a filter change must not re-run them over the window.
  const enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const blen = s => (!enc || !/[^\x00-\x7F]/.test(s)) ? s.length : enc.encode(s).length;
  //
  // Severity runs in SECTIONS, not lines. What says a job died is one sentence; what tells you why
  // is the twenty indented frames under it, and classifying those on their own words makes them
  // ordinary output that the error filter then hides — leaving a filter that shows you the headline
  // of every problem and the detail of none. A continuation line inherits what it continues.
  // (A section split across a page boundary restarts, since the page above may not be loaded.)
  const CONT = /^(\s|│|└|\[\d+\]|@\s|at\s|\.\.\.|Caused by|Stacktrace)/;
  function cut(text, from) {
    const out = [];
    let off = from, run = 'info';
    for (const t of text.split('\n')) {
      const own = sevOf(t);
      // A continuation keeps the section's level unless it names a worse one of its own.
      const sev = (CONT.test(t) || t === '') && own === 'info' ? run : own;
      if (!CONT.test(t) && t !== '') run = sev;
      out.push({ t, o: off, sev });
      off += blen(t) + 1;                    // +1 for the newline the split consumed
    }
    return out;
  }

  // The lines on screen, in reading order. Reversal is per LINE in newest-first mode, which is what
  // puts the last thing the job said at the top.
  function visible() {
    const out = [];
    const ps = S.order === 'new' ? S.pages.slice().reverse() : S.pages;
    for (const p of ps) {
      const ls = S.order === 'new' ? p.lines.slice().reverse() : p.lines;
      for (const l of ls) {
        if (S.filter !== 'all' && l.sev !== S.filter) continue;
        out.push(l);
      }
    }
    return out;
  }

  function paintPre() {
    const pre = q('.logv-pre');
    if (!S.path) { pre.innerHTML = ''; return; }
    const mark = S.hits && S.needle && !S.rx ? S.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const at = S.hits && S.hitAt >= 0 ? S.hits[S.hitAt].offset : -1;
    pre.innerHTML = visible().map(l =>
      `<span class="logv-l logv-${l.sev}${l.o === at ? ' hit' : ''}" data-o="${l.o}">${paintLine(l.t, mark)}</span>`
    ).join('\n');
  }

  function paintBar() {
    q('.logv-levels').querySelectorAll('[data-lv]').forEach(b => {
      const lv = b.dataset.lv, n = S.counts && S.counts[lv];
      b.classList.toggle('on', lv === S.filter);
      b.textContent = lv + (n == null ? '' : ' ' + n);
    });
    const ord = q('.logv-order');
    ord.textContent = S.order === 'new' ? '↓' : '↑';
    ord.title = S.order === 'new' ? 'newest first — click for oldest first'
                                  : 'oldest first — click for newest first';
    const pz = q('.logv-pause');
    pz.textContent = S.paused ? '▶' : '⏸';
    pz.title = S.paused ? 'paused — click to follow the file again' : 'stop following the file';
    q('.logv-pause').classList.toggle('on', S.paused);
    q('.logv-icase').classList.toggle('on', S.icase);
    q('.logv-rx').classList.toggle('on', S.rx);
    // Two numbers when a filter is on, because they mean different things: how far through the
    // matches you can reach, and how many the FILE holds. One figure standing for both would be
    // wrong whichever it was.
    const h = q('.logv-hits');
    h.textContent = !S.hits ? '' :
      !S.hits.length ? (S.total ? `0 of ${S.total} (filtered out)` : 'no matches') :
      S.hits.length === S.total ? `${S.hitAt + 1} of ${S.total}${S.capped ? '+' : ''}`
                                : `${S.hitAt + 1} of ${S.hits.length} · ${S.total} in file`;
    const loaded = S.pages.reduce((n, p) => n + (p.to - p.from + 1), 0);
    q('.logv-meta').textContent = S.path
      ? `${bytes(loaded)} of ${bytes(S.size)}` : '';
  }

  // ── Whole-file counts ──────────────────────────────────────────────────────────────────────
  // The chips have to mean the FILE, not the window: "error 40" beside a screen holding three of
  // them is the number that tells you to keep looking. One scan per level, on the side the file
  // lives on, and only when the file is opened.
  function countLevels() {
    if (!SEV || !S.path) return;
    const path = S.path;
    S.counts = null; paintBar();
    // One search per level, not per pattern: a level's patterns are alternatives, so a line
    // matching either is one line. Counting them separately and taking the larger would under-count
    // a file where different lines matched different patterns.
    const one = lv => {
      const src = lv === 'error' ? SEV.error : SEV.warn;
      if (!src.length) return Promise.resolve(0);
      const pat = src.map(re => '(?:' + re.source + ')').join('|');
      // `limit: 0` asks for the count and no hit list, which is one pass over the file and one
      // integer back. A chip is a number; fetching the matches to arrive at it would move the file.
      return call('log_search', path, { pattern: pat, regex: true, ignorecase: true, limit: 0 })
        .then(r => r.total).catch(() => 0);
    };
    Promise.all([one('error'), one('warn')]).then(([e, w]) => {
      if (S.path !== path) return;                 // the reader moved on while this was in flight
      S.counts = { error: e, warn: w };
      paintBar();
    });
  }

  // ── Search ─────────────────────────────────────────────────────────────────────────────────
  // Over the WHOLE file, on the side it lives on — which is the only way a match past the window
  // can be found at all. `total` counts every line even when the hit list stops, because "3 of 412"
  // is the number a reader needs and quietly meaning "3 of the first 2000" would be a lie.
  function runSearch() {
    const needle = (q('.logv-search').value || '').trim();
    S.needle = needle;
    if (!needle || !S.path) { S.hits = null; S.rawHits = null; S.hitAt = -1; paintBar(); paintPre(); return; }
    call('log_search', S.path, { pattern: needle, ignorecase: S.icase, regex: S.rx, limit: HIT_LIMIT })
      .then(r => {
        S.total = r.total; S.capped = r.capped;
        S.rawHits = r.hits || [];
        refilterHits();
        if (S.hits.length) step(1); else { paintBar(); paintPre(); }
      }).catch(fail);
  }

  // The search is applied ON TOP of the level filter, so changing the level changes which hits you
  // can reach — a match on a line the filter is hiding is not a result you could navigate to. Held
  // as the raw list plus a derived one so switching levels does not cost another scan of the file.
  function refilterHits() {
    if (!S.rawHits) { S.hits = null; return; }
    S.hits = S.rawHits.filter(h => S.filter === 'all' || sevOf(h.text) === S.filter);
    S.hitAt = S.hits.length ? 0 : -1;
  }

  function step(d) {
    if (!S.hits || !S.hits.length) { runSearch(); return; }
    S.hitAt = (S.hitAt + d + S.hits.length) % S.hits.length;
    seek(S.hits[S.hitAt].offset);
  }

  // Land ON the match: the hit's offset is the first byte of its line, so a window starting there
  // holds it. Half a page of lead-in, because a traceback is read from above its last line.
  function seek(offset) {
    const have = S.pages.find(p => offset >= p.from && offset <= p.to);
    if (have) { paintPre(); paintBar(); scrollToHit(); return; }
    S.pages = [];
    fetchPage(Math.max(0, offset - (PAGE >> 1))).then(() => {
      if (!S.pages.some(p => offset >= p.from && offset <= p.to)) return fetchPage(offset);
    }).then(scrollToHit);
  }

  function scrollToHit() {
    const n = el && q('.logv-pre .hit');
    if (n) n.scrollIntoView({ block: 'center' });
  }

  // ── Following a live file ──────────────────────────────────────────────────────────────────
  // A stat, not a read. Re-reading only matters once the file has grown, and a viewer left open on
  // a running job would otherwise pull a window over ssh every few seconds for the rest of the day.
  function poll() {
    if (!open_() || S.paused || !S.path || S.loading) return;
    call('log_stat', S.path).then(st => {
      if (st.bytes < 0 || st.bytes === S.size) return;
      const pane = q('.logv-pane');
      // Follow only when the reader is AT the end that grows. Anywhere else, say that there is
      // more rather than moving the text out from under them.
      const atEdge = S.order === 'new' ? pane.scrollTop < NEAR
                                       : pane.scrollTop + pane.clientHeight > pane.scrollHeight - NEAR;
      S.size = st.bytes;
      if (!atEdge) { S.behind = st.bytes; q('.logv-jump').style.display = ''; return; }
      // Newest-first puts the growing end at the top, so the whole window moves; oldest-first only
      // gains a page at the bottom, and rewinding to the start of the file would be absurd.
      if (S.order === 'new') reload();
      else fetchPage(S.pages.length ? S.pages[S.pages.length - 1].to + 1 : 0);
    }).catch(() => {});
  }

  // The addressing is the part that has to be right and the part a browser cannot show you is
  // wrong: an off-by-one in a byte offset looks like a highlight on the neighbouring line. Exposed
  // so `test/js/logview_window.mjs` can pin it without a DOM.
  window.slateLogs = { open, close, _test: { S, cut, visible, sevOf, setSev, paintLine } };
})();
