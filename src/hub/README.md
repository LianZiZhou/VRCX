# VRCX Hub

A headless VRCX backend. It runs on a always-on machine (a Raspberry Pi, a NAS,
a spare box), holds the database and the VRChat session, and keeps collecting
friend activity 24/7 whether or not any desktop client is open. Desktop VRCX
clients on the same LAN attach to it and become mirrors: same UI, same features,
but reading and writing the Hub's data instead of their own.

This is a fork feature. It lives almost entirely in `src/hub/`, and touches the
upstream tree in a handful of small guarded places so that rebasing onto
upstream stays cheap.

---

## How it fits together

```
Raspberry Pi (Hub, Node)                  Desktop PC (mirror)
┌──────────────────────────┐              ┌──────────────────────────┐
│ happy-dom shim           │              │ CefSharp / Electron      │
│ the same src/ data core, │              │ the same src/ data core, │
│ with no UI mounted       │              │ with the full UI         │
│                          │              │ derived writes suppressed│
│ .NET via node-api-dotnet │              │ local AppApi, LogWatcher,│
│  ├ SQLite   → VRCX.sqlite3              │  Discord, VRCXStorage    │
│  ├ WebApi   → VRChat API │◄── ws + ────►│ SQLite / WebApi → remote │
│  └ VRCXStorage (local)   │   AES-GCM    │                          │
│ VRChat pipeline (the one) │──relay────► │ handlePipeline()         │
│ status page :9002        │◄──uplink─────│ game log, Photon, state  │
└──────────────────────────┘              └──────────────────────────┘
```

Both sides run **the same `src/` code**. That is the central design decision:
the Hub needs the full data core (it must process pipeline events and write
rows on its own), and a client must be able to run standalone when the Hub is
away. Maintaining two implementations of that logic would guarantee they drift,
so instead the Hub boots the real store graph headlessly.

### Three run modes

| Mode         | Where                                  | Native bindings                      | Pipeline socket  | Derived writes |
| ------------ | -------------------------------------- | ------------------------------------ | ---------------- | -------------- |
| `standalone` | today's VRCX, and the offline fallback | all local                            | its own          | its own        |
| `hub`        | the always-on box                      | all local                            | **the only one** | its own        |
| `mirror`     | a client attached to a Hub             | `SQLite`/`WebApi` remote, rest local | none — relayed   | suppressed     |

`VRCXStorage` deliberately stays local in mirror mode. It backs `VRCX.json`,
which holds per-machine things — window geometry, GPU flags, database path,
proxy — and the Hub connection settings themselves, which have to be readable
before any remote binding exists. Application settings (theme, sort orders,
filters, saved credentials) live in the SQLite `configs` table and therefore
follow the database to the Hub, which is the intended behaviour.

---

## Running the Hub

### From a release zip

`npm run package-hub` builds archives that unpack and run with nothing else
installed, six platforms with two variants each:

|           |                                                                       |
| --------- | --------------------------------------------------------------------- |
| Platforms | `linux-x64` `linux-arm64` `win-x64` `win-arm64` `osx-x64` `osx-arm64` |
| `full`    | bundles Node too, so nothing at all is required (~82-98 MB)           |
| `slim`    | expects Node 24.15+ on `PATH` (~50-55 MB)                             |

```bash
npm run package-hub                               # all twelve, into build/dist/
npm run package-hub -- --platforms=linux-arm64    # or just one
npm run package-hub -- --variants=slim
```

Unpack it and run `./start-hub.sh`, or `start-hub.cmd` on Windows. The launcher
changes into its own directory first, because the Hub resolves `dotnet/` and
`dotnet-runtime/` relative to the working directory.

Both variants carry a private .NET runtime, which the Hub prefers over any
system install. The startup log says which runtimes it actually got:

```
[hub] Node 24.20.0 on win32-x64
[hub] .NET bridge ready (SQLite, WebApi, VRCXStorage) on .NET 10.0.12 [bundled]
```

That private runtime is a requirement, not a convenience: `node-api-dotnet`
starts the CLR through hostfxr instead of launching a .NET executable, so the
runtime files a `--self-contained` publish leaves next to `VRCX.dll` are never
read. hostfxr does honour `DOTNET_ROOT`, and `server/nativeBridge.js` points it
at the bundled copy.

One machine cross-builds all six platforms, so `package-hub.js` verifies what
it cannot run: the right native SQLite for the RID, the generated interop shim,
the other five platforms' native hosts pruned, the bundled Node's ELF/Mach-O/PE
header matching the target architecture, and -- by reading the finished zip
back -- `start-hub.sh` keeping its executable bit. CI does the same through
`.github/workflows/hub-release.yml`.

### Prerequisites (running from a checkout)

- Node 24+
- The .NET 10 runtime
- VRCX's .NET assemblies built for the target: `dotnet publish
Dotnet/VRCX-Electron-arm64.csproj -c Release`, giving `build/Electron/`

### Build and run

```bash
npm run build-hub
# then on the target machine, with build/hub/ and build/Electron/ in place:
npm install --omit=dev
node main.js
```

Or with Docker (see `docker/Dockerfile.hub`), or under systemd (see
`docker/vrcx-hub.service`).

To try it without a database or a VRChat session:

```bash
node build/hub/main.js --dry-run --config=/tmp/hub-demo
```

### Options

```
--config=<dir>        data directory (default: the platform VRCX config dir)
--port=<n>            client port (default 9001)
--host=<addr>         bind address (default 0.0.0.0)
--status-port=<n>     read-only status page (default 9002, 0 disables)
--token=<secret>      override the stored token
--tls-cert=<file>     optional TLS, on top of the built-in encryption
--tls-key=<file>
--dry-run             boot against stubs; touches no real data
--verbose             log every interop call
```

The shared token is generated on first run into `<config>/hub-token`. Clients
need the host, the port and that token.

---

## Connecting a client

The Hub settings live in the client's `VRCX.json` (not in the database — see
above):

```json
{
    "VRCX_HubEnabled": "true",
    "VRCX_HubUrl": "ws://192.168.1.50:9001",
    "VRCX_HubToken": "<the token from the Hub>"
}
```

On startup the client tries the Hub for three seconds. If it connects and the
database schema versions match, it becomes a mirror. If anything fails — no
settings, unreachable, wrong token, schema mismatch — it runs as an ordinary
standalone VRCX against its own local database, and says so in the console.

**Signing in is done from a client.** The Hub has no login UI on purpose. Attach
a client, sign in as usual (the request travels to the Hub, whose cookie jar it
establishes), and from then on the Hub holds the session. Other clients that
attach afterwards find themselves already signed in.

**Signing out from a mirror client signs out the Hub** and therefore every other
client, and stops collection. If you only want to detach this machine, turn off
`VRCX_HubEnabled` instead.

---

## Security

The link is `ws://` carrying application-layer encryption rather than `wss://`.

That is not a shortcut. A mirror client's socket is created in the VRCX renderer
with the browser `WebSocket` API; browsers refuse `wss://` to a self-signed
certificate and give JavaScript no way to inspect or pin a fingerprint, so
trust-on-first-use cannot be implemented where it would need to live. Doing it
at the host layer would mean patching `src-electron/main.js` _and_ the CefSharp
request handler in `Dotnet/` — exactly the kind of upstream surface this fork is
trying not to grow.

So instead:

- Client and server each send a random nonce in the clear.
- Both derive two AES-256-GCM keys with HKDF-SHA256 over the shared token,
  salted with both nonces — one key per direction.
- The client proves it holds the token by sending a sealed frame. The token
  itself never goes on the wire.
- Every subsequent frame is sealed. Per-message IVs come from a counter that is
  unique per key, and keys are fresh per connection, so IV reuse cannot happen.
  Receivers require strictly increasing counters, which makes replay and
  reordering detectable.
- A plaintext frame on an established connection closes it.

Pass `--tls-cert`/`--tls-key` to add TLS underneath if you want defence in
depth.

The call surface is a strict class+method allowlist: `SQLite.{Execute,
ExecuteJson, ExecuteNonQuery}` and `WebApi.{Execute, ExecuteJson, GetCookies,
SetCookies, ClearCookies}`. Nothing else is reachable. (The in-process Electron
bridge can construct any public class in the `VRCX` namespace by name; that is
fine for same-process IPC and not fine for a network.)

---

## Behaviour worth knowing about

**Who writes what.** The Hub is the only writer of derived rows — feed entries,
friend log, notifications, game log, Photon-derived moderation. Mirror clients
have those suppressed at the single point where the `database` object is
exported. User-initiated writes (memos, notes, tags, local favourites,
deletions, settings) still go through to the Hub's database as normal.

**Local data goes up, not sideways.** Game log lines, Photon events and
game-running state can only be collected on the machine actually running
VRChat. Clients uplink them; the Hub processes each once and echoes the result
to everyone, including the sender. That way there is one writer and one code
path.

**Schema is Hub-owned.** Migrations and `VACUUM` run only on the Hub. C# holds a
single SQLite connection behind one lock, so several clients migrating the same
database would stall each other at best. The handshake compares schema versions
and refuses to attach on a mismatch rather than writing malformed rows.

**Rate limits.** Every client runs its own update loop and its own pipeline
handling, so one event can make N clients fetch the same resource on one shared
VRChat session. The Hub coalesces concurrent identical GETs. Auth endpoints are
never shared. A short response cache exists but is off by default; turn it on
only if 429s actually appear.

**Offline fallback.** The Hub broadcasts its VRChat cookies to clients as they
change, so a client that loses the Hub can fall back to standalone without a
fresh login and a 2FA prompt. Switching modes reloads the window rather than
swapping the database underneath a running app — the two databases hold
different content and different per-user table prefixes.

**Data written offline diverges.** A client running standalone writes to its own
local database, and nothing merges that back on its own. To fold it in, copy the
client's `VRCX.sqlite3` to the Hub machine, stop the Hub, and run:

```bash
npm run hub-merge-offline -- --client-db=/tmp/offline-VRCX.sqlite3
```

That wraps `Dotnet/DBMerger` (build it with `dotnet publish
Dotnet/DBMerger/DBMerger.csproj -c Release -r linux-arm64`). It refuses to run
while the Hub is listening — DBMerger opens both files directly and would race
the Hub's writes — and it always takes a timestamped backup of the Hub database
into `backups/` before touching anything.

---

## Development

```bash
npm run test:hub     # the Hub suite, in the node environment
npm run build-hub    # bundle for deployment
```

`vitest.hub.config.js` runs in Node with happy-dom and the same module aliases
the production bundle uses, so a green run there means the alias set is
complete.

`boot.spike.test.js` is the load-bearing one: it boots the entire store graph
headlessly and is what catches an upstream change that reaches for a browser API
the shim does not cover.

### Upstream footprint

Everything else is new files. The upstream tree is touched in seven places, each
a small guarded block marked `// [hub]`:

| File                             | What                                              |
| -------------------------------- | ------------------------------------------------- |
| `src/plugins/interopApi.js`      | attempt the Hub, rebind `SQLite`/`WebApi`         |
| `src/services/database/index.js` | wrap the export in the suppression proxy          |
| `src/services/websocket.js`      | relay pipeline messages; mirrors do not connect   |
| `src/stores/updateLoop.js`       | gate timers by mode; uplink instead of processing |
| `src/stores/vrcx.js`             | Hub owns the schema; uplink Photon events         |
| `vitest.config.js`               | exclude the Hub suite (it has its own config)     |
| `package.json`                   | two scripts, four dev dependencies                |

`git log -S'[hub]'` finds all of them. `Dotnet/` is untouched.
