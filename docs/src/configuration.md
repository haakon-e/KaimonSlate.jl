# Configuration

Settings live in one dialog with two **scopes**. **Global** is your own preference, kept per browser
and applied to every notebook. **This notebook** is the per-notebook override, and the pinned ones
travel *in the `.jl`* so the notebook reopens the same way anywhere.

Open it with the gear in the top bar, or ⌘K → *Settings*. ⌘K → *Settings: this notebook* opens the
same dialog already on the second scope.

A section list runs down the side and a search box sits above it. The search covers both scopes and
matches tooltips and placeholders as well as visible text, so typing "vim", "trackpad" or "svg" finds
the setting even when the word is not its label.

## Global

Four sections.

**Display**

| Setting | Effect |
| --- | --- |
| **Full page width** | Use the full window width instead of the centered column. |
| **Page width** | The content column's width, when not using full width. |
| **Figure width** | How wide figures render, independently of the text column. |
| **Chart scroll-zoom** | How much a wheel notch zooms a chart that has zooming enabled. |
| **Wrap text output** | Soft-wrap long lines of cell output instead of scrolling them. |
| **Wrap code editor** | Soft-wrap long lines in the editor. |

**Appearance**

| Setting | Effect |
| --- | --- |
| **Theme** | The notebook UI's colour theme: Midnight (default), Graphite, Nord, Dracula, Solarized Dark, and the light Daylight and Solarized Light. |
| **Chart renderer** | How interactive charts are drawn: *Auto* (each chart's own setting), *Canvas*, or *SVG*. See below. |
| **Editor syntax** | Syntax-highlighting palette for the editor: Dark+, Monokai, Dracula, Nord, Tokyo Night, GitHub Dark, Gruvbox Dark, Solarized Dark, and the light One Light and Solarized Light. |

**Editing**

| Setting | Effect |
| --- | --- |
| **Editor keymap** | Default, Vim or Emacs bindings in the cell editor. |
| **Live-update debounce** | Minimum delay (ms) between live recomputes while dragging a control. Higher = fewer recomputes on a slow kernel. |
| **Autocomplete delay** | How long to wait before the completion popup opens. |
| **Tab in autocomplete** | Whether ⇥ accepts the highlighted completion. |

**Agent**

| Setting | Effect |
| --- | --- |
| **Agent model** | Sonnet / Opus / Haiku, any model served locally by Ollama or vmlx (both listed automatically, stored as `ollama:<name>` / `vmlx:<name>`), or a custom model id typed in. |
| **Agent permissions** | `lab` / `auto` / `default` / `bypass` preset for the agent. |

Model and permission changes [reap the agent](agent.md) so the next message respawns on the
new setting (the transcript is kept).

![The Settings dialog: a Global / This notebook scope switch, a search box, the section list down the side, and the settings rows](./assets/settings.png)

### Chart renderer

ECharts draws to a canvas, and some browser and driver combinations fail to composite it. The chart
then runs correctly behind a blank rectangle. Switching to **SVG** avoids that path.

Which renderer works depends on the browser doing the viewing, so this reader setting outranks the
[`renderer =`](visualization.md#Choosing-a-renderer) keyword an author put on a chart. Changing it
rebuilds every chart on the page, because ECharts fixes the renderer when a chart is created.

A static export has no Settings dialog, so a reader who hits this can add `?renderer=svg` to the URL
instead.

## This notebook

The second scope. Each setting starts from your global default and can be **pinned to this
notebook**, and the pinned ones travel in the `.jl`.

A row that has not been pinned is badged **default** and says which value it is following, so you can
tell an inherited setting from one this document has decided. The header says **all defaults** when
nothing has been pinned at all.

![The Settings dialog on its This notebook scope: sections for Agent, Execution, Slides, Publishing and Agent (local only), with an unpinned row badged default and showing the value it follows](./assets/settings-notebook.png)

It holds:

- **Worker threads** (`"<compute>,<interactive>"`) and **Extra Julia flags** (appended to this
  notebook's worker command line, e.g. `--gcthreads=4,1 --heap-size-hint=4G`). Changing either
  respawns the worker.
- **Parallel cells** — run independent cells concurrently.
- **Hot-reload /src edits** — whether edits to the project's own source re-enter the running kernel.
  See [Editing project source](hot-reload.md).
- **Macro-aware deps** — expand unknown macros in the kernel to recover their real reads and writes.
  Off falls back to conservative static analysis, which is what you want for the rare macro with
  expansion-time side effects.
- **Slides** — heading level, transition, and PDF aspect ratio for a [slide deck](slides.md).
- **Bibliography style** — see [Documents & Citations](documents.md).
- **Agent model** — override the global agent default for this notebook. (Agent permissions are a
  ⚙ Settings item, remembered locally and never written to the file.)
- **Series** — the publishing series this notebook belongs to.
- **Replay resolution** — read-only here, showing what the export dialog's
  [replay step](replay.md#exporting) decided. The panel is where you clear it.

Whether a notebook runs its cells as it opens is not a config setting. It is chosen when the notebook
is opened, from the front page's **Launch worker on open** checkbox.

Where a value crosses into other UI: the notebook's **run location** is the toolbar "Running on"
picker (whole-notebook placement, [Remotes](remotes.md)), and its **regions** are the
[Destinations](regions.md#Using-a-region-in-a-notebook) it enables — both are saved in the same
config footer.

## Serving

The [`slate` app](installation.md) is the normal way to run the hub:

```sh
slate                 # start (or attach to) the hub + status TUI
slate notebook.jl     # also open a notebook
slate --own           # force a standalone hub even if a Kaimon extension is registered
slate --port 8080     # run the hub on this port, for this launch only
slate --status        # print hub status and open notebooks, then exit (0 = up, 1 = no hub)
```

The port is taken from `--port` first, then `KAIMONSLATE_PORT`, then a `port` saved in `slate.json`,
then 8765. Set `KAIMONSLATE_NO_OPEN=1` to never open a browser.

### `slate.json`

Machine-wide settings live in `slate.json` in your config home. Changes apply on the next hub start.

| Key | What it sets |
| --- | --- |
| `port` | the hub port, unless a flag or environment variable overrides it |
| `worker_threads` | default worker threads, as `"<compute>,<interactive>"` |
| `worker_extra_flags` | default extra Julia flags for workers |
| `memo_cap_gb` | the [memoization](memoization.md) store's size cap |
| `blob_chunk_mb` | chunk size for binary transfers |
| `carry_max_s`, `xfer_confirm_s` | [region](regions.md) transfer thresholds |
| `remote` | per-host timing overrides, below |
| `catalog` | point the [Extensions gallery](extension-gallery.md) at a fork or mirror |

`secrets.json` sits beside it and holds the [publishing](publishing.md) credentials the ledger
refers to by name.

### Where Slate keeps its state

Slate uses three homes, each resolved as `KAIMONSLATE_<TYPE>_HOME`, then `KAIMONSLATE_HOME/<type>`,
then the XDG location:

| Home | Holds | Default |
| --- | --- | --- |
| config | `slate.json`, `secrets.json` | `~/.config/kaimonslate` |
| data | the publishing ledger's working checkout | `~/.local/share/kaimonslate` |
| cache | local site builds | `~/.cache/kaimonslate` |

The cache home is safe to delete. The data home is not.

Setting **`KAIMONSLATE_HOME`** relocates all three at once, which is how you run a second hub without
it sharing the first one's config, secrets and publish ledger.

To drive the hub from your own script instead, the programmatic API is still available:

```julia
KaimonSlate.serve_notebook(path; host = "127.0.0.1", port = 8765)   # blocking
h = KaimonSlate.start_server(path; port = 8765)                     # non-blocking → Hub
KaimonSlate.stop_hub(h)
```

`KaimonSlate.start_hub` / `open_notebook!` / `close_notebook!` / `stop_hub` give finer control over a
multi-notebook hub. Only `serve_notebook`, `LiveNotebook`, `expand`, `standalone!`,
`register_extension`, `export_app` and `app_defaults` are exported; the rest need the `KaimonSlate.`
prefix. See the [API Reference](api.md).

## Kernel selection

A notebook uses a **gate worker** whenever Kaimon's gate is available; otherwise it runs
**in-process**. The gate worker gives you a clean namespace, a tailable log (🪵),
[package management](packages.md), and isolation. There's no setting for this. A notebook outside any
Julia project still gets a worker, with an environment of its own. Restart a worker any time with
**⟲ Restart worker** (top bar), or rebuild the namespace with **↻ Rebuild**.

A worker can also run on **another machine** — a workstation, GPU box, or cloud VM — with the
notebook behaving exactly as if local. Set hosts up on the front page's **🖧 Remotes** dialog and
place a whole notebook with **Run on**, or route individual cells to a named
[region](regions.md) (kept warm for instant startup). See [Remotes](remotes.md).

## Remote worker timing

The SSH/connect/tunnel/transfer timeouts used when a worker runs on [another
machine](remotes.md) default to values tuned for a LAN. A slow-auth, high-latency, or cold
(heavy-precompile) host can legitimately exceed them — a cold cloud VM's first spawn, say,
outrunning the 120 s dial deadline. Rather than rebuild, override any of them per machine in a
`"remote"` object in `slate.json` (in your config home — `$XDG_CONFIG_HOME/kaimonslate/`, changes
apply on the next hub start):

```json
{
  "remote": {
    "dial_deadline_cold": 300,
    "ssh_connect_timeout": 30,
    "pkg_op_timeout": 1800
  }
}
```

Each key also has a `KAIMONSLATE_*` environment-variable equivalent (handy for a one-off run or a
test); precedence is **`slate.json` → env var → built-in default**. Values are **seconds** unless
noted.

| `slate.json` key | Env var | Default | Governs |
| --- | --- | --- | --- |
| `dial_deadline_cold` | `KAIMONSLATE_DIAL_DEADLINE_COLD` | `120` | Cold-spawn dial — covers remote Julia boot + KaimonGate load. |
| `dial_deadline_probe` | `KAIMONSLATE_DIAL_DEADLINE_PROBE` | `15` | Reattach-probe / warm-pool-adopt dial. |
| `dial_deadline_record` | `KAIMONSLATE_DIAL_DEADLINE_RECORD` | `5` | Record-first dial (a live worker answers in well under a second). |
| `connect_deadline_local` | `KAIMONSLATE_CONNECT_DEADLINE_LOCAL` | `90` | Local (`127.0.0.1`) worker connect deadline. |
| `ssh_connect_timeout` | `KAIMONSLATE_SSH_CONNECT_TIMEOUT` | `15` | `ConnectTimeout` for every ssh/scp/rsync op. |
| `ssh_control_persist` | `KAIMONSLATE_SSH_CONTROL_PERSIST` | `600` | SSH connection-mux master warm-hold past the last op. |
| `tunnel_alive_interval` | `KAIMONSLATE_TUNNEL_ALIVE_INTERVAL` | `5` | Supervised tunnel `ServerAliveInterval`. |
| `tunnel_alive_count` | `KAIMONSLATE_TUNNEL_ALIVE_COUNT` | `3` | Supervised tunnel `ServerAliveCountMax`. |
| `tunnel_respawn_backoff` | `KAIMONSLATE_TUNNEL_RESPAWN_BACKOFF` | `1` | Backoff after a dropped forward before respawning it. |
| `fwd_ready_wait` | `KAIMONSLATE_FWD_READY_WAIT` | `8` | Bounded wait for an async `ssh -L` local port to start accepting before the first connect. |
| `probe_timeout` | `KAIMONSLATE_PROBE_TIMEOUT` | `4` | `:direct` TCP port-open probe. |
| `firewall_giveup` | `KAIMONSLATE_FIREWALL_GIVEUP` | `10` | Sustained SYN-drop ⇒ declare a firewall and fail fast. |
| `pkg_op_timeout` | `KAIMONSLATE_PKG_OP_TIMEOUT` | `900` | Package add/rm/reconstruct — a heavy stack's resolve + precompile. |
| `sync_parent_timeout` | `KAIMONSLATE_SYNC_PARENT_TIMEOUT` | `600` | Parent-project `/src` sync. |
| `blob_xfer_timeout` | `KAIMONSLATE_BLOB_XFER_TIMEOUT` | `600` | Whole-binding / direct-blob boundary move. |
| `blob_chunk_timeout` | `KAIMONSLATE_BLOB_CHUNK_TIMEOUT` | `20` | Per-chunk ZMQ recv/send timeout on a transfer. |
| `sysimage_lock_stale` | `KAIMONSLATE_SYSIMAGE_LOCK_STALE` | `1800` | Concurrent sysimage-build lock staleness window. |
| `peer_bw_mbps` | `KAIMONSLATE_PEER_BW_MBPS` | `30` | Assumed rate (MB/s) for an unmeasured worker→worker link. |

## Ollama (local models)

The agent model dropdown lists models from your local Ollama install, queried from its HTTP
API (embedding-only models are filtered out). Point at a non-default host with the standard
environment variable:

```bash
export OLLAMA_HOST=http://127.0.0.1:11434
```

Driving a local model requires Kaimon's Ollama agent backend. Selecting a model stores it as
`ollama:<name>`, which rides each chat turn.

## Environment variables

| Variable | Used for |
| --- | --- |
| `KAIMONSLATE_PORT` | Hub port for the `slate` app / server (default `8765`; `--port` beats it). |
| `KAIMONSLATE_NO_OPEN` | `=1` → never open a browser when the `slate` app starts. |
| `KAIMONSLATE_HOME` | Sets the config, data and cache homes at once from one directory. The way to run an isolated hub. |
| `KAIMONSLATE_CONFIG_HOME` | The config home on its own. Beats `KAIMONSLATE_HOME`. |
| `KAIMONSLATE_DATA_HOME` | The data home on its own. Beats `KAIMONSLATE_HOME`. |
| `KAIMONSLATE_CACHE_HOME` | The cache home on its own. Beats `KAIMONSLATE_HOME`. |
| `KAIMONSLATE_SITES_DIR` | Local site builds, overriding the cache home's `sites/`. |
| `KAIMONSLATE_DATADIR` | A notebook's data directory, as `datadir()` resolves it. |
| `KAIMONSLATE_NO_AUTOREGISTER` | `=1` → do not register as a Kaimon extension on load. |
| `KAIMONSLATE_MEMO_CAP_GB` | Size cap for the [memoization](memoization.md) store. |
| `KAIMONSLATE_MEMO_DEBUG` | `=1` → log cache-key components. |
| `OLLAMA_HOST` | Ollama API endpoint for the model list (default `http://127.0.0.1:11434`). |
| `VMLX_HOST` | vmlx (MLX) API endpoint for the model list (default `http://127.0.0.1:8000`). |
| `SLATE_BROWSER` | Open a specific browser (e.g. `"Google Chrome"`) instead of the OS default. |
| `KAIMONSLATE_ALLOWED_HOSTS` | Extra Host/Origin names the hub will answer to (a DNS alias, a proxy). This machine's own names are admitted automatically. |
| `KAIMONSLATE_ASSET_BASE` | **Docs build only** — points the site at the docs-assets GitHub Release for generated demo media. Unset locally → served from `public/assets/`. |

The remote-worker timing knobs above each have a `KAIMONSLATE_*` equivalent too, and a number of
further variables exist for tuning transfers, regions and sysimages. Those are listed beside the
code that reads them rather than here.
