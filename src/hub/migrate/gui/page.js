/**
 * [hub] The one page the GUI serves.
 *
 * Kept as a string in JS rather than an .html file so it runs from source
 * under plain Node and through the Vite bundle without either needing to
 * know about it. No framework, no external assets: the CSP the server sends
 * allows nothing but the inline script and stylesheet below.
 *
 * Bilingual by a small dictionary, defaulting to the browser's language,
 * because the people this page is for are the ones who would not use the
 * command line -- and many of them read Chinese.
 */

const STRINGS = {
    en: {
        title: 'VRCX Hub migration tool',
        lang: '中文',
        quit: 'Quit',
        hubCard: 'Hub',
        hubUrl: 'Hub address',
        hubUrlHint: 'host, host:port or ws://host:9001',
        hubToken: 'Token',
        hubTokenHint: 'the contents of hub-token on the Hub',
        show: 'show',
        check: 'Check Hub',
        migrate: 'Migrate this VRCX to the Hub',
        migrateHint:
            'Takes a consistent copy of the local database (including the VRChat session), uploads it, and the Hub restarts on it. The Hub keeps what it had in backups/.',
        configureClient: 'Also point this VRCX at the Hub (VRCX must be closed)',
        backupHub: 'Back up the Hub',
        localCard: 'This machine',
        localDir: 'VRCX data directory',
        backupTo: 'Write backups to',
        showInfo: 'Show what is there',
        backupLocal: 'Back up this VRCX',
        restoreCard: 'Restore a backup',
        restoreFrom: 'Backup directory',
        restoreTo: 'Restore into',
        withToken: 'Also restore hub-token (a Hub backup only)',
        restore: 'Restore',
        restoreHint: 'Close VRCX (or stop the Hub) first. What is there now is kept in backups/.',
        log: 'Output',
        clear: 'Clear',
        yes: 'Yes',
        no: 'No',
        running: 'Working…',
        done: 'Done.',
        failed: 'Failed: ',
        busy: 'Something is still running.',
        needHub: 'Enter the Hub address and token first.',
        needFrom: 'Enter the backup directory first.',
        quitDone: 'The tool has quit. You can close this tab.',
        lost: 'Lost the connection to the tool. Is it still running?'
    },
    zh: {
        title: 'VRCX Hub 迁移工具',
        lang: 'English',
        quit: '退出',
        hubCard: 'Hub',
        hubUrl: 'Hub 地址',
        hubUrlHint: '主机名、主机名:端口 或 ws://主机名:9001',
        hubToken: '令牌',
        hubTokenHint: 'Hub 数据目录里 hub-token 文件的内容',
        show: '显示',
        check: '检查 Hub',
        migrate: '把本机 VRCX 迁移到 Hub',
        migrateHint:
            '对本机数据库（含 VRChat 登录会话）做一致性快照并上传，Hub 会重启并使用它。Hub 原有的数据会保留在 backups/ 里。',
        configureClient: '同时把本机 VRCX 指向这个 Hub（需先关闭 VRCX）',
        backupHub: '备份 Hub',
        localCard: '本机',
        localDir: 'VRCX 数据目录',
        backupTo: '备份保存到',
        showInfo: '查看数据信息',
        backupLocal: '备份本机 VRCX',
        restoreCard: '恢复备份',
        restoreFrom: '备份目录',
        restoreTo: '恢复到',
        withToken: '同时恢复 hub-token（仅 Hub 的备份有）',
        restore: '恢复',
        restoreHint: '请先关闭 VRCX（或停止 Hub）。目标里现有的数据会保留在 backups/ 里。',
        log: '输出',
        clear: '清空',
        yes: '是',
        no: '否',
        running: '处理中…',
        done: '完成。',
        failed: '失败：',
        busy: '还有操作在进行中。',
        needHub: '请先填写 Hub 地址和令牌。',
        needFrom: '请先填写备份目录。',
        quitDone: '工具已退出，可以关闭这个标签页。',
        lost: '和工具的连接断开了，它还在运行吗？'
    }
};

const STYLE = `
:root { color-scheme: light dark; --line: #8884; --accent: #2563eb; --bad: #dc2626; --ok: #16a34a; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 1.5rem 1rem 3rem; }
main { max-width: 56rem; margin: 0 auto; }
header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1rem; }
h1 { font-size: 1.35rem; margin: 0; flex: 1; }
header small { opacity: .6; }
section { border: 1px solid var(--line); border-radius: .6rem; padding: 1rem 1.1rem; margin-bottom: 1rem; }
h2 { font-size: 1rem; margin: 0 0 .75rem; }
label { display: block; margin: .5rem 0 .2rem; font-weight: 500; }
label small { font-weight: 400; opacity: .6; margin-left: .4rem; }
input[type=text], input[type=password] { width: 100%; padding: .45rem .6rem; border: 1px solid var(--line); border-radius: .4rem; font: inherit; background: transparent; color: inherit; }
.row { display: flex; gap: .6rem; align-items: center; }
.row input { flex: 1; }
.actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .9rem; }
button { font: inherit; padding: .5rem .9rem; border-radius: .4rem; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.small { padding: .2rem .6rem; font-size: .85rem; }
button:disabled { opacity: .5; cursor: default; }
.hint { font-size: .9rem; opacity: .7; margin: .3rem 0 0; }
.check { display: flex; gap: .5rem; align-items: center; margin-top: .6rem; font-weight: 400; }
.check input { margin: 0; }
#log { white-space: pre-wrap; font: 13px/1.45 ui-monospace, Consolas, monospace; background: #8881; border-radius: .4rem; padding: .8rem; min-height: 8rem; max-height: 24rem; overflow: auto; margin: 0; }
#bar { height: .5rem; background: #8883; border-radius: .25rem; overflow: hidden; margin: .6rem 0; display: none; }
#bar div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
#ask { display: none; gap: .6rem; align-items: center; padding: .7rem .9rem; border: 1px solid var(--accent); border-radius: .4rem; margin: .6rem 0; }
#ask span { flex: 1; }
#status { margin: .4rem 0; min-height: 1.4rem; }
#status.bad { color: var(--bad); } #status.ok { color: var(--ok); }
`;

const SCRIPT = `
const TOKEN = document.body.dataset.token;
const STRINGS = JSON.parse(document.getElementById('strings').textContent);
let lang = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
let jobId = null;
let source = null;

const $ = (id) => document.getElementById(id);
const t = (key) => STRINGS[lang][key];

function applyLanguage() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-t]')) {
        el.textContent = t(el.dataset.t);
    }
    for (const el of document.querySelectorAll('[data-t-title]')) {
        el.title = t(el.dataset.tTitle);
    }
    document.title = t('title');
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { 'x-migrate-token': TOKEN, 'content-type': 'application/json', ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.error || response.statusText);
    }
    return body;
}

function setBusy(busy) {
    for (const button of document.querySelectorAll('button[data-run], #quit')) {
        button.disabled = busy;
    }
    $('status').className = busy ? '' : $('status').className;
    if (busy) {
        $('status').textContent = t('running');
    }
}

function append(text) {
    const log = $('log');
    log.textContent += text + '\\n';
    log.scrollTop = log.scrollHeight;
}

function hubFlags() {
    return { hub: $('hubUrl').value, token: $('hubToken').value };
}

function requireHub() {
    if (!$('hubUrl').value.trim() || !$('hubToken').value.trim()) {
        $('status').textContent = t('needHub');
        $('status').className = 'bad';
        return false;
    }
    return true;
}

const ACTIONS = {
    check: () => requireHub() && { command: 'info', flags: { ...hubFlags(), from: $('localDir').value } },
    migrate: () =>
        requireHub() && {
            command: 'migrate',
            flags: { ...hubFlags(), from: $('localDir').value, 'configure-client': $('configureClient').checked }
        },
    backupHub: () => requireHub() && { command: 'backup', flags: { ...hubFlags(), to: $('backupTo').value } },
    info: () => ({ command: 'info', flags: { from: $('localDir').value } }),
    backupLocal: () => ({ command: 'backup', flags: { from: $('localDir').value, to: $('backupTo').value } }),
    restore: () => {
        if (!$('restoreFrom').value.trim()) {
            $('status').textContent = t('needFrom');
            $('status').className = 'bad';
            return false;
        }
        return {
            command: 'restore',
            flags: { from: $('restoreFrom').value, to: $('restoreTo').value, 'with-token': $('withToken').checked }
        };
    }
};

async function run(action) {
    const request = ACTIONS[action]();
    if (!request) {
        return;
    }
    if (jobId) {
        $('status').textContent = t('busy');
        return;
    }
    setBusy(true);
    $('bar').style.display = 'none';
    $('ask').style.display = 'none';
    append('$ ' + request.command);
    try {
        const { id } = await api('/api/run', { method: 'POST', body: JSON.stringify(request) });
        jobId = id;
        follow(id);
    } catch (err) {
        finish(false, err.message);
    }
}

function follow(id) {
    source = new EventSource('/api/events?id=' + id + '&t=' + encodeURIComponent(TOKEN));
    source.onmessage = (message) => {
        const event = JSON.parse(message.data);
        switch (event.type) {
            case 'line':
                append(event.text);
                break;
            case 'progress': {
                const bar = $('bar');
                bar.style.display = 'block';
                bar.firstElementChild.style.width = Math.floor((event.done / Math.max(event.total, 1)) * 100) + '%';
                $('status').textContent = event.label + ' ' + Math.floor((event.done / Math.max(event.total, 1)) * 100) + '%';
                break;
            }
            case 'confirm':
                $('question').textContent = event.question;
                $('ask').style.display = 'flex';
                break;
            case 'done':
                finish(event.ok, event.message);
                break;
        }
    };
    source.onerror = () => {
        if (jobId) {
            finish(false, t('lost'));
        }
    };
}

function finish(ok, message) {
    if (source) {
        source.close();
        source = null;
    }
    jobId = null;
    setBusy(false);
    $('bar').style.display = 'none';
    $('ask').style.display = 'none';
    $('status').textContent = ok ? t('done') : t('failed') + (message || '');
    $('status').className = ok ? 'ok' : 'bad';
    if (!ok && message) {
        append('! ' + message);
    }
    append('');
}

async function answer(yes) {
    $('ask').style.display = 'none';
    try {
        await api('/api/answer', { method: 'POST', body: JSON.stringify({ id: jobId, yes }) });
    } catch (err) {
        append('! ' + err.message);
    }
}

async function init() {
    applyLanguage();
    for (const button of document.querySelectorAll('button[data-run]')) {
        button.addEventListener('click', () => run(button.dataset.run));
    }
    $('yes').addEventListener('click', () => answer(true));
    $('no').addEventListener('click', () => answer(false));
    $('clear').addEventListener('click', () => ($('log').textContent = ''));
    $('lang').addEventListener('click', () => {
        lang = lang === 'zh' ? 'en' : 'zh';
        applyLanguage();
    });
    $('showToken').addEventListener('click', () => {
        const field = $('hubToken');
        field.type = field.type === 'password' ? 'text' : 'password';
    });
    $('quit').addEventListener('click', async () => {
        await api('/api/quit', { method: 'POST' }).catch(() => {});
        document.body.innerHTML = '<main><p>' + t('quitDone') + '</p></main>';
    });

    try {
        const state = await api('/api/state');
        $('version').textContent = state.version;
        $('localDir').value = state.localDir;
        $('restoreTo').value = state.localDir;
        $('backupTo').value = state.backupDir;
        if (state.hub) {
            $('hubUrl').value = state.hub.url;
            $('hubToken').value = state.hub.token || '';
        }
    } catch (err) {
        $('status').textContent = t('failed') + err.message;
        $('status').className = 'bad';
    }
}

init();
`;

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {{ token: string, version: string }} options
 * @returns {string}
 */
export function renderPage(options) {
    const { token, version } = options;
    // The dictionary goes into the page as data, never interpolated into the
    // script, so a translated string can hold anything.
    const strings = JSON.stringify(STRINGS).replace(/</g, '\\u003c');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VRCX Hub migration tool</title>
<style>${STYLE}</style>
</head>
<body data-token="${escapeHtml(token)}">
<script type="application/json" id="strings">${strings}</script>
<main>
  <header>
    <h1 data-t="title">VRCX Hub migration tool</h1>
    <small id="version">${escapeHtml(version)}</small>
    <button class="small" id="lang" data-t="lang">中文</button>
    <button class="small" id="quit" data-t="quit">Quit</button>
  </header>

  <section>
    <h2 data-t="hubCard">Hub</h2>
    <label for="hubUrl"><span data-t="hubUrl">Hub address</span><small data-t="hubUrlHint"></small></label>
    <input type="text" id="hubUrl" placeholder="192.168.1.50" autocomplete="off" spellcheck="false">
    <label for="hubToken"><span data-t="hubToken">Token</span><small data-t="hubTokenHint"></small></label>
    <div class="row">
      <input type="password" id="hubToken" autocomplete="off" spellcheck="false">
      <button class="small" id="showToken" data-t="show">show</button>
    </div>
    <div class="check"><input type="checkbox" id="configureClient"><label for="configureClient" style="margin:0" data-t="configureClient"></label></div>
    <div class="actions">
      <button data-run="check" data-t="check">Check Hub</button>
      <button class="primary" data-run="migrate" data-t="migrate">Migrate this VRCX to the Hub</button>
      <button data-run="backupHub" data-t="backupHub">Back up the Hub</button>
    </div>
    <p class="hint" data-t="migrateHint"></p>
  </section>

  <section>
    <h2 data-t="localCard">This machine</h2>
    <label for="localDir" data-t="localDir">VRCX data directory</label>
    <input type="text" id="localDir" spellcheck="false">
    <label for="backupTo" data-t="backupTo">Write backups to</label>
    <input type="text" id="backupTo" spellcheck="false">
    <div class="actions">
      <button data-run="info" data-t="showInfo">Show what is there</button>
      <button data-run="backupLocal" data-t="backupLocal">Back up this VRCX</button>
    </div>
  </section>

  <section>
    <h2 data-t="restoreCard">Restore a backup</h2>
    <label for="restoreFrom" data-t="restoreFrom">Backup directory</label>
    <input type="text" id="restoreFrom" spellcheck="false">
    <label for="restoreTo" data-t="restoreTo">Restore into</label>
    <input type="text" id="restoreTo" spellcheck="false">
    <div class="check"><input type="checkbox" id="withToken"><label for="withToken" style="margin:0" data-t="withToken"></label></div>
    <div class="actions">
      <button data-run="restore" data-t="restore">Restore</button>
    </div>
    <p class="hint" data-t="restoreHint"></p>
  </section>

  <section>
    <div class="row"><h2 data-t="log" style="flex:1">Output</h2><button class="small" id="clear" data-t="clear">Clear</button></div>
    <div id="status"></div>
    <div id="bar"><div></div></div>
    <div id="ask"><span id="question"></span><button class="primary" id="yes" data-t="yes">Yes</button><button id="no" data-t="no">No</button></div>
    <pre id="log"></pre>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
