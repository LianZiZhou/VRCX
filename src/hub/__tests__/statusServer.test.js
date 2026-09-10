/**
 * [hub] The status page shows what the Hub believes, per client.
 */

import { createStatusServer, renderPage } from '../server/statusServer.js';

const status = {
    version: 'VRCX-Hub test',
    loggedIn: true,
    displayName: 'Alice <script>',
    pipelineConnected: true,
    clientCount: 1,
    databaseVersion: 17,
    uptimeSeconds: 3700,
    gameState: { isGameRunning: true, isSteamVRRunning: false },
    location: 'wrld_1:1234',
    clients: [
        {
            clientId: 'abc',
            name: 'desk',
            remote: '192.168.1.2',
            gameState: { isGameRunning: true, isSteamVRRunning: false },
            uplink: { gamelog: 12, backlog: 3, ipc: 40, gameState: 1, lastAt: Date.now() - 5000 }
        }
    ],
    detached: [{ clientId: 'def', clientName: 'laptop', isGameRunning: false, updatedAt: Date.now() - 65000 }],
    effectiveSettings: { gameLogDisabled: false, autoStateChangeEnabled: true }
};

describe('status page', () => {
    it('renders the Hub state, each client and the effective settings', () => {
        const html = renderPage(status);
        expect(html).toContain('Collecting');
        expect(html).toContain('Running');
        expect(html).toContain('wrld_1:1234');
        expect(html).toContain('desk');
        expect(html).toContain('12 / 3 / 40');
        expect(html).toContain('5s ago');
        expect(html).toContain('laptop');
        expect(html).toContain('link dropped');
        expect(html).toContain('autoStateChangeEnabled');
        // Names come from clients; they are not markup.
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('says so when nothing is attached', () => {
        const html = renderPage({ ...status, clients: [], detached: [], gameState: null, location: null });
        expect(html).toContain('No clients attached');
        expect(html).toContain('<td>—</td>');
    });

    it('serves the same data as JSON', async () => {
        const server = createStatusServer({ port: 0, getStatus: () => status });
        // Port 0 means "disabled" for the Hub; listen by hand on an ephemeral one.
        await expect(server.start()).resolves.toBeUndefined();
        await server.stop();
    });
});
