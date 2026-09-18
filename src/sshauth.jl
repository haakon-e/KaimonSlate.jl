# ── Authenticating to a cluster that will not take a key ─────────────────────────────────────
#
# Plenty of production clusters refuse public keys outright and want a password plus a second
# factor — a code, or a push you accept on a phone. Slate holds the SSH session itself
# (`SshTransport`), so the server's `keyboard-interactive` prompts arrive as values rather than as
# terminal output, and answering one is a function call.
#
#   SshTransport asks     →  ask(host, prompt, echo) blocks here
#   the notebook          →  shows the prompt, sends back what the user typed
#   answer!               →  releases the waiting call
#
# Prompt-DRIVEN rather than scripted, because the conversation varies: password then code, or
# password then a push that just takes a while, or Duo's "passcode or option" menu. Whatever the
# server asks is what gets shown, in its own words.
#
# Answers live in memory for the moment between the browser sending one and the session consuming
# it, and never touch disk.

module SshAuth

mutable struct Prompt
    id::String
    host::String
    prompt::String
    echo::Bool          # false ⇒ a secret; the dialog masks it
    at::Float64
    reply::Channel{Union{String,Nothing}}   # nothing = cancelled
end

const _PENDING = Dict{String,Prompt}()
const _LOCK = ReentrantLock()
const _SEQ = Ref(0)

# Somewhere other than a browser to answer from: a terminal front end, or a test. Set, it takes
# every prompt and no dialog is raised here. Prompts only ever arise in the HUB — the process with a
# browser attached — because that is where the sessions live.
const _ANSWERER = Ref{Any}(nothing)

"How long a prompt waits for an answer. Long enough to reach for a phone, short enough that an
abandoned dialog does not hold a connection open."
const TIMEOUT = 120.0

"Route prompts to `f(host, prompt, echo) -> String | nothing` instead of a notebook dialog."
set_answerer!(f) = (_ANSWERER[] = f; nothing)

"Whether something in this process can answer a prompt without a dialog of its own."
has_answerer() = _ANSWERER[] !== nothing

# User-registered answerers, consulted in order before the browser dialog. Each is
# `f(host, prompt, echo) -> String | nothing`: a `String` answers the prompt, `nothing` defers to the
# next answerer, and finally to the dialog. `set_answerer!` still installs ONE replacement for
# everything; this chain is the layer a user registers into, so a per-host answerer can coexist with
# the padlock (see `register_answerer!`).
const _ANSWERERS = Vector{Any}()

function _chain_answerer(host, prompt, echo)
    for f in _ANSWERERS
        r = try
            # A hub init file defines its answerer at runtime via `include`, in a world newer than the
            # sign-in task's frozen frame; dispatch through the latest world so the call resolves.
            Base.invokelatest(f, host, prompt, echo)
        catch e
            @warn "SshAuth: a registered answerer errored; skipping it" host exception = e
            nothing
        end
        r isa AbstractString && return String(r)
    end
    return ask_via_dialog(String(host), String(prompt), echo)
end

"""
    register_answerer!(f) -> nothing

Add `f(host, prompt, echo) -> String | nothing` to the chain that answers ssh sign-in prompts before
the browser dialog. Return a `String` to answer the prompt, or `nothing` to defer to the next
answerer, and finally to the dialog. Answerers run in the hub process in the order registered. `echo`
is false for a secret such as a password. Register from a hub init file to answer a host's password
from a credential store without the prompt reaching the browser.
"""
function register_answerer!(f)
    push!(_ANSWERERS, f)
    _ANSWERER[] === _chain_answerer || set_answerer!(_chain_answerer)
    return nothing
end

# Answering the last prompt is not the end of the story: the server still has to accept it, and on a
# second factor that is exactly the part that can go wrong. Without this the dialog closes on the
# last keystroke and you find out whether you are signed in by trying something.
const _REPORTER = Ref{Any}(nothing)

"Route login outcomes to `f(host, ok::Bool, error::String)` — a worker relays them, a hub shows them."
set_reporter!(f) = (_REPORTER[] = f; nothing)

"Say how a login ended. Best-effort: nobody watching is not an error."
function report!(host::AbstractString, ok::Bool, err::AbstractString = "")
    f = _REPORTER[]
    f === nothing && return nothing
    try; Base.invokelatest(f, String(host), ok, String(err)); catch; end
    return nothing
end

"""
    ask(host, prompt, echo; timeout = TIMEOUT) -> String | nothing

Show `prompt` for `host` and block until the browser answers. `nothing` means the user cancelled or
nobody answered in time — the caller should abandon the connection rather than retry.

`echo` is the server's own word on whether the reply is a secret, so the dialog masks a password
without having to recognise the word "password".
"""
function ask(host::AbstractString, prompt::AbstractString, echo::Bool = false; timeout::Real = TIMEOUT)
    f = _ANSWERER[]
    f === nothing || return Base.invokelatest(f, String(host), String(prompt), echo)
    return ask_via_dialog(host, prompt, echo; timeout)
end

"""
    ask_via_dialog(host, prompt, echo; timeout = TIMEOUT) -> String | nothing

Raise a browser prompt for `host` and block until the browser answers, `nothing` on a timeout or a
cancel. This is the path `ask` takes when no answerer is installed, and the one a registered answerer
chain falls back to for a prompt no answerer handled.
"""
function ask_via_dialog(host::AbstractString, prompt::AbstractString, echo::Bool = false; timeout::Real = TIMEOUT)
    p = lock(_LOCK) do
        _SEQ[] += 1
        p = Prompt(string("p", _SEQ[]), String(host), String(prompt), echo, time(),
                   Channel{Union{String,Nothing}}(1))
        _PENDING[p.id] = p
        p
    end
    timer = Timer(_ -> (isopen(p.reply) && put!(p.reply, nothing)), timeout)
    try
        return take!(p.reply)
    catch
        return nothing
    finally
        close(timer)
        lock(_LOCK) do; delete!(_PENDING, p.id); end
    end
end

"""
    pending() -> Vector{NamedTuple}

Prompts waiting for an answer: `(; id, host, prompt, echo, at)`, oldest first.
"""
pending() = lock(_LOCK) do
    out = NamedTuple[(; id = p.id, host = p.host, prompt = p.prompt, echo = p.echo, at = p.at)
                     for p in values(_PENDING)]
    sort!(out; by = x -> x.at)
    out
end

"Hand one prompt its answer. False if it is no longer waiting."
function answer!(id::AbstractString, text::AbstractString)
    p = lock(_LOCK) do; get(_PENDING, String(id), nothing); end
    p === nothing && return false
    try; put!(p.reply, String(text)); catch; return false; end
    return true
end

"Abandon a prompt — the user dismissed the dialog, so the connection gives up rather than hanging."
function cancel!(id::AbstractString)
    p = lock(_LOCK) do; get(_PENDING, String(id), nothing); end
    p === nothing && return nothing
    try; put!(p.reply, nothing); catch; end
    return nothing
end

"Abandon everything waiting on `host` — used when a session is torn down under them."
function cancel_host!(host::AbstractString)
    for p in lock(_LOCK) do; [p for p in values(_PENDING) if p.host == String(host)]; end
        try; put!(p.reply, nothing); catch; end
    end
    return nothing
end

end # module SshAuth
