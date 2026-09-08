/**
 * [hub] A small read-only status page.
 *
 * Login and 2FA are driven from a real VRCX client over the Hub link; this
 * exists only so that when something is wrong you can see what without SSHing
 * in. It never accepts input and never exposes the token.
 */

import { createServer } from 'node:http';

/**
 * @param {number} seconds
 * @returns {string}
 */
function humaniseUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * @param {object} status
 * @returns {string}
 */
function renderPage(status) {
    const rows = [
        ['Status', status.loggedIn ? 'Logged in' : 'Not logged in'],
        ['VRChat user', status.displayName ?? '—'],
        ['Pipeline', status.pipelineConnected ? 'Connected' : 'Disconnected'],
        ['Connected clients', String(status.clientCount)],
        ['Database schema', String(status.databaseVersion)],
        ['Uptime', humaniseUptime(status.uptimeSeconds)],
        ['Version', status.version]
    ];
    const healthy = status.loggedIn && status.pipelineConnected;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VRCX Hub</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem;
         display: flex; justify-content: center; }
  main { width: 100%; max-width: 34rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .state { display: inline-flex; align-items: center; gap: .5rem;
           margin-bottom: 1.5rem; font-weight: 600; }
  .dot { width: .6rem; height: .6rem; border-radius: 50%;
         background: ${healthy ? '#22c55e' : '#f59e0b'}; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem 0; border-bottom: 1px solid #8883; }
  th { font-weight: 500; opacity: .7; width: 45%; }
  td { font-variant-numeric: tabular-nums; }
  footer { margin-top: 1.5rem; opacity: .6; font-size: .85rem; }
  code { background: #8882; padding: .1rem .3rem; border-radius: .2rem; }
</style>
</head>
<body>
<main>
  <h1>VRCX Hub</h1>
  <div class="state"><span class="dot"></span>${healthy ? 'Collecting' : 'Needs attention'}</div>
  <table>
    ${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n    ')}
  </table>
  <footer>
    Read-only. Sign in from a VRCX client connected to this Hub.
    Machine-readable at <code>/status.json</code>.
  </footer>
</main>
</body>
</html>`;
}

/**
 * @param {{ port: number, host?: string, getStatus: () => object }} options
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void>, address: object }}
 */
export function createStatusServer(options) {
    const { port, host = '0.0.0.0', getStatus } = options;

    const server = createServer((request, response) => {
        const status = getStatus();
        if (request.url === '/status.json') {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(status, null, 2));
            return;
        }
        if (request.url === '/' || request.url === '/index.html') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(renderPage(status));
            return;
        }
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
    });

    return {
        start() {
            if (!port) {
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.removeListener('error', reject);
                    resolve();
                });
            });
        },
        stop() {
            return new Promise((resolve) => server.close(() => resolve()));
        },
        get address() {
            return server.address();
        }
    };
}
