/**
 * [hub] The Socket Inspect window.
 *
 * A separate page, opened from the tray menu next to DevTools, that shows the
 * main window's socket traffic live: the VRChat pipeline, the Hub link's
 * events and this machine's uplinks. It has no store, no framework and no
 * bindings of its own -- the C# side feeds it through
 * `window.__socketInspect.push(json)` with what
 * `src/hub/client/socketInspector.js` recorded in the main window, backlog
 * first, then every message as it arrives.
 */

import './socketInspect.css';

/** Rows kept in the window; older ones fall off the top. */
const MAX_ROWS = 4000;
/** The window is redrawn at most this often while messages stream in. */
const RENDER_INTERVAL_MS = 100;
/** Messages per second are measured over this window. */
const RATE_WINDOW_MS = 5000;

const state = {
    /** @type {object[]} */
    entries: [],
    /** @type {number[]} arrival times, for the rate */
    arrivals: [],
    paused: false,
    /** what arrived while paused, applied on resume */
    held: [],
    autoscroll: true,
    /**
     * `messages`: what the app sees (pipeline, Hub events, uplinks).
     * `frames`: what the wire carries -- every frame of the Hub link decoded,
     * which is the DevTools network tab's binary blobs made readable.
     */
    mode: 'messages',
    channel: 'all',
    direction: 'all',
    typeFilter: '',
    search: '',
    selectedId: null,
    totalReceived: 0,
    dropped: 0
};

const root = document.getElementById('root');
root.innerHTML = `
<div class="toolbar">
  <span class="modes">
    <button id="mode-messages" class="active" title="Pipeline messages, Hub events and uplinks, as the app sees them">Messages</button>
    <button id="mode-frames" title="Every frame of the Hub link, decoded: calls, results, events, ping/pong">All frames</button>
  </span>
  <select id="channel" title="Channel">
    <option value="all">All channels</option>
    <option value="vrchat">VRChat pipeline</option>
    <option value="hub">Hub events</option>
    <option value="uplink">Uplink</option>
  </select>
  <select id="direction" title="Direction" hidden>
    <option value="all">Both directions</option>
    <option value="in">Received</option>
    <option value="out">Sent</option>
  </select>
  <input id="type" type="search" placeholder="Type filter, e.g. friend-location" />
  <input id="search" type="search" placeholder="Search in payload" />
  <button id="pause" title="Stop the list from moving; messages keep arriving">Pause</button>
  <button id="clear">Clear</button>
  <label><input id="autoscroll" type="checkbox" checked /> Follow</label>
</div>
<div class="status">
  <span>Shown <b id="shown">0</b></span>
  <span>Received <b id="received">0</b></span>
  <span>Rate <b id="rate">0</b>/s</span>
  <span id="types"></span>
</div>
<div class="main">
  <div class="list" id="list">
    <table>
      <thead id="head"></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty">Waiting for messages… Open VRCX's main window and let it talk.</div>
  </div>
  <div class="detail">
    <div class="detail-head">
      <span id="detail-title">Select a message</span>
      <span class="spacer"></span>
      <button id="copy" hidden>Copy JSON</button>
    </div>
    <pre id="detail"></pre>
  </div>
</div>`;

const el = {
    modeMessages: document.getElementById('mode-messages'),
    modeFrames: document.getElementById('mode-frames'),
    channel: document.getElementById('channel'),
    direction: document.getElementById('direction'),
    head: document.getElementById('head'),
    type: document.getElementById('type'),
    search: document.getElementById('search'),
    pause: document.getElementById('pause'),
    clear: document.getElementById('clear'),
    autoscroll: document.getElementById('autoscroll'),
    shown: document.getElementById('shown'),
    received: document.getElementById('received'),
    rate: document.getElementById('rate'),
    types: document.getElementById('types'),
    list: document.getElementById('list'),
    rows: document.getElementById('rows'),
    empty: document.getElementById('empty'),
    detailTitle: document.getElementById('detail-title'),
    detail: document.getElementById('detail'),
    copy: document.getElementById('copy')
};

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * @param {number} at
 * @returns {string}
 */
function formatTime(at) {
    const d = new Date(at);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Parse a payload for display. Pipeline messages carry their `content` as a
 * JSON string inside JSON; that is unwrapped so the detail pane shows the
 * object rather than an escaped blob.
 *
 * @param {object} entry
 * @returns {any}
 */
function parsePayload(entry) {
    let value;
    try {
        value = JSON.parse(entry.raw);
    } catch {
        return entry.raw;
    }
    if (entry.channel === 'vrchat' && value && typeof value.content === 'string') {
        try {
            value = { ...value, content: JSON.parse(value.content) };
        } catch {
            // Left as the string VRChat sent.
        }
    }
    // A link frame carrying a relayed pipeline message: unwrap that too.
    if (
        entry.channel === 'link' &&
        value?.t === 'event' &&
        value.p?.event === 'pipeline' &&
        typeof value.p.data === 'string'
    ) {
        try {
            const inner = JSON.parse(value.p.data);
            if (typeof inner.content === 'string') {
                try {
                    inner.content = JSON.parse(inner.content);
                } catch {
                    // As above.
                }
            }
            value = { ...value, p: { ...value.p, data: inner } };
        } catch {
            // Not JSON; shown as sent.
        }
    }
    return value;
}

/**
 * Syntax-coloured JSON.
 *
 * @param {any} value
 * @returns {string} HTML
 */
function highlightJson(value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return escapeHtml(json).replace(
        /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        (match) => {
            let cls = 'number';
            if (match.startsWith('"')) {
                cls = match.endsWith(':') ? 'key' : 'string';
            } else if (/true|false|null/.test(match)) {
                cls = 'literal';
            }
            return `<span class="${cls}">${match}</span>`;
        }
    );
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
function matches(entry) {
    if (state.mode === 'frames') {
        // The link's frames, plus a directly connected pipeline socket's
        // messages (a standalone client has no link; its pipeline *is* the
        // wire). Relayed pipeline messages are already inside `event` frames.
        const onWire = entry.channel === 'link' || (entry.channel === 'vrchat' && !entry.via);
        if (!onWire) {
            return false;
        }
        if (state.direction !== 'all' && entry.direction !== state.direction) {
            return false;
        }
    } else {
        if (entry.channel === 'link') {
            return false;
        }
        if (state.channel !== 'all' && entry.channel !== state.channel) {
            return false;
        }
    }
    if (
        state.typeFilter &&
        !entry.type.toLowerCase().includes(state.typeFilter) &&
        !(entry.summary ?? '').toLowerCase().includes(state.typeFilter)
    ) {
        return false;
    }
    if (state.search && !entry.raw.toLowerCase().includes(state.search)) {
        return false;
    }
    return true;
}

let renderScheduled = false;

function scheduleRender() {
    if (renderScheduled) {
        return;
    }
    renderScheduled = true;
    setTimeout(() => {
        renderScheduled = false;
        render();
    }, RENDER_INTERVAL_MS);
}

const HEADS = {
    messages: `<tr>
  <th class="time">Time</th>
  <th class="channel">Channel</th>
  <th class="dir">Dir</th>
  <th class="type">Type</th>
  <th class="size">Bytes</th>
  <th>Preview</th>
</tr>`,
    frames: `<tr>
  <th class="time">Time</th>
  <th class="dir">Dir</th>
  <th class="frame">Frame</th>
  <th class="frame-id">#</th>
  <th>Summary</th>
  <th class="size">Wire</th>
  <th class="latency">ms</th>
</tr>`
};

/**
 * @param {object} entry
 * @returns {string}
 */
function messageRow(entry) {
    const preview = entry.raw.length > 160 ? `${entry.raw.slice(0, 160)}…` : entry.raw;
    return `<tr data-id="${entry.id}" class="${entry.id === state.selectedId ? 'selected' : ''}">
  <td class="time">${formatTime(entry.at)}</td>
  <td class="channel"><span class="badge ${entry.channel}">${entry.channel}</span>${entry.via ? ` <span class="preview">via ${escapeHtml(entry.via)}</span>` : ''}</td>
  <td class="dir ${entry.direction}">${entry.direction === 'in' ? '◀' : '▶'}</td>
  <td class="type" title="${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</td>
  <td class="size">${entry.size}</td>
  <td class="preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</td>
</tr>`;
}

/**
 * @param {object} entry
 * @returns {string}
 */
function frameRow(entry) {
    const isLink = entry.channel === 'link';
    const summary = isLink ? (entry.summary ?? '') : entry.raw.length > 160 ? `${entry.raw.slice(0, 160)}…` : entry.raw;
    const frameType = isLink ? entry.type : `pipeline ${entry.type}`;
    const wire = isLink ? (entry.wireBytes ?? entry.size) : entry.size;
    const latency = isLink && entry.latencyMs !== null && entry.latencyMs !== undefined ? entry.latencyMs : '';
    return `<tr data-id="${entry.id}" class="${entry.id === state.selectedId ? 'selected' : ''}">
  <td class="time">${formatTime(entry.at)}</td>
  <td class="dir ${entry.direction}">${entry.direction === 'in' ? '◀' : '▶'}</td>
  <td class="frame"><span class="badge frame-${isLink ? escapeHtml(entry.type) : 'pipeline'}">${escapeHtml(frameType)}</span></td>
  <td class="frame-id">${entry.frameId ?? ''}</td>
  <td class="preview" title="${escapeHtml(summary)}">${escapeHtml(summary)}</td>
  <td class="size">${wire}</td>
  <td class="latency">${latency}</td>
</tr>`;
}

function render() {
    const visible = state.entries.filter(matches);
    const typeCounts = new Map();
    for (const entry of visible) {
        typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
    }

    el.head.innerHTML = HEADS[state.mode];
    el.rows.innerHTML = visible.map(state.mode === 'frames' ? frameRow : messageRow).join('');
    el.empty.hidden = visible.length > 0;
    el.shown.textContent = String(visible.length);
    el.received.textContent = state.dropped
        ? `${state.totalReceived} (${state.dropped} scrolled off)`
        : String(state.totalReceived);

    const now = Date.now();
    state.arrivals = state.arrivals.filter((at) => now - at <= RATE_WINDOW_MS);
    el.rate.textContent = (state.arrivals.length / (RATE_WINDOW_MS / 1000)).toFixed(1);

    const top = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    el.types.textContent = top.map(([type, count]) => `${type} ${count}`).join('  ·  ');

    if (state.autoscroll && !state.paused) {
        el.list.scrollTop = el.list.scrollHeight;
    }
}

/**
 * @param {object} entry
 */
function select(entry) {
    state.selectedId = entry?.id ?? null;
    if (!entry) {
        el.detailTitle.textContent = 'Select a message';
        el.detail.innerHTML = '';
        el.copy.hidden = true;
        render();
        return;
    }
    const via = entry.via ? ` via ${entry.via}` : '';
    const cut = entry.truncated ? ` (showing the first ${entry.raw.length} of ${entry.size} bytes)` : '';
    const frame =
        entry.channel === 'link'
            ? ` #${entry.frameId ?? '-'}  ${entry.wireBytes ?? '?'} B on the wire${entry.latencyMs !== null && entry.latencyMs !== undefined ? `  ${entry.latencyMs} ms` : ''}`
            : '';
    el.detailTitle.textContent = `${formatTime(entry.at)}  ${entry.channel}${via}  ${entry.direction}  ${entry.type}${frame}${cut}`;
    el.detail.innerHTML = highlightJson(parsePayload(entry));
    el.copy.hidden = false;
    for (const row of el.rows.querySelectorAll('tr')) {
        row.classList.toggle('selected', Number(row.dataset.id) === entry.id);
    }
}

/**
 * @param {object} entry
 */
function add(entry) {
    state.totalReceived++;
    state.arrivals.push(entry.at);
    if (state.paused) {
        state.held.push(entry);
        if (state.held.length > MAX_ROWS) {
            state.held.shift();
        }
        el.pause.textContent = `Resume (${state.held.length})`;
        return;
    }
    state.entries.push(entry);
    if (state.entries.length > MAX_ROWS) {
        state.entries.shift();
        state.dropped++;
    }
    scheduleRender();
}

/**
 * Called by the C# side for every message the main window recorded.
 *
 * @param {string} json - `{ kind: 'message', entry }` or `{ kind: 'backlog', entries }`
 */
function push(json) {
    let frame;
    try {
        frame = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
        return;
    }
    if (frame?.kind === 'backlog') {
        state.entries = (frame.entries ?? []).slice(-MAX_ROWS);
        state.totalReceived = state.entries.length;
        state.arrivals = [];
        state.dropped = 0;
        render();
        return;
    }
    if (frame?.kind === 'message' && frame.entry) {
        add(frame.entry);
    }
}

/**
 * @param {'messages' | 'frames'} mode
 */
function setMode(mode) {
    state.mode = mode;
    el.modeMessages.classList.toggle('active', mode === 'messages');
    el.modeFrames.classList.toggle('active', mode === 'frames');
    el.channel.hidden = mode === 'frames';
    el.direction.hidden = mode !== 'frames';
    el.type.placeholder =
        mode === 'frames'
            ? 'Filter frame type or summary, e.g. call, SELECT, auth/user'
            : 'Type filter, e.g. friend-location';
    select(null);
}

el.modeMessages.addEventListener('click', () => setMode('messages'));
el.modeFrames.addEventListener('click', () => setMode('frames'));
el.channel.addEventListener('change', () => {
    state.channel = el.channel.value;
    render();
});
el.direction.addEventListener('change', () => {
    state.direction = el.direction.value;
    render();
});
el.type.addEventListener('input', () => {
    state.typeFilter = el.type.value.trim().toLowerCase();
    render();
});
el.search.addEventListener('input', () => {
    state.search = el.search.value.trim().toLowerCase();
    render();
});
el.pause.addEventListener('click', () => {
    state.paused = !state.paused;
    el.pause.classList.toggle('active', state.paused);
    if (!state.paused) {
        for (const entry of state.held) {
            state.entries.push(entry);
        }
        state.held = [];
        while (state.entries.length > MAX_ROWS) {
            state.entries.shift();
            state.dropped++;
        }
        el.pause.textContent = 'Pause';
        render();
    } else {
        el.pause.textContent = 'Resume';
    }
});
el.clear.addEventListener('click', () => {
    state.entries = [];
    state.held = [];
    state.arrivals = [];
    state.dropped = 0;
    state.totalReceived = 0;
    select(null);
});
el.autoscroll.addEventListener('change', () => {
    state.autoscroll = el.autoscroll.checked;
});
el.list.addEventListener('scroll', () => {
    // Scrolling up is the natural way to say "stop following".
    const atBottom = el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 4;
    if (!atBottom && state.autoscroll) {
        state.autoscroll = false;
        el.autoscroll.checked = false;
    }
});
el.rows.addEventListener('click', (event) => {
    const row = event.target.closest('tr');
    if (!row) {
        return;
    }
    const id = Number(row.dataset.id);
    select(state.entries.find((entry) => entry.id === id) ?? null);
});
el.copy.addEventListener('click', async () => {
    const entry = state.entries.find((candidate) => candidate.id === state.selectedId);
    if (!entry) {
        return;
    }
    const text = JSON.stringify(parsePayload(entry), null, 2);
    try {
        await navigator.clipboard.writeText(text);
        el.copy.textContent = 'Copied';
    } catch {
        // No clipboard permission: select the text so a keyboard copy works.
        const range = document.createRange();
        range.selectNodeContents(el.detail);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        el.copy.textContent = 'Selected; press Ctrl+C';
    }
    setTimeout(() => {
        el.copy.textContent = 'Copy JSON';
    }, 1500);
});

setInterval(() => {
    if (state.arrivals.length) {
        scheduleRender();
    }
}, 1000);

window.__socketInspect = { push, state };
render();
