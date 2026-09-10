/**
 * [hub] `initWebsocket()` tries again when the pipeline token fetch fails.
 *
 * Upstream gave up after one failed `GET auth`: a network blip that outlasted
 * the five-second close-retry left the pipeline down until the hourly friends
 * refresh, or the person clicking it, called `reconnectWebSocket()`. Both the
 * Hub and a standalone desktop client go through this path.
 */

import { vi } from 'vitest';

vi.mock('../../services/request.js', () => ({
    request: vi.fn()
}));

import { request } from '../../services/request.js';
import { initWebsocket } from '../../services/websocket.js';
import { watchState } from '../../services/watchState.js';

beforeEach(() => {
    vi.useFakeTimers();
    request.mockReset();
    watchState.isLoggedIn = true;
    watchState.isFriendsLoaded = true;
});

afterEach(async () => {
    // Drain any retry still scheduled so it cannot leak into the next test.
    watchState.isLoggedIn = false;
    watchState.isFriendsLoaded = false;
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
});

describe('pipeline token fetch', () => {
    it('is retried after a failure, and stops once it goes through', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        request.mockRejectedValueOnce(new Error('Error Message: {}\nEndpoint: "auth"'));
        request.mockRejectedValueOnce(new Error('Error Message: {}\nEndpoint: "auth"'));
        // Not `ok`, so no socket is opened; that is enough to end the chain.
        request.mockResolvedValue({ ok: false });

        await initWebsocket();
        expect(request).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5000);
        expect(request).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(5000);
        expect(request).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(20000);
        expect(request).toHaveBeenCalledTimes(3);
        expect(errors).toHaveBeenCalledTimes(2);
        errors.mockRestore();
    });

    it('is not retried once the user has signed out', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        request.mockRejectedValue(new Error('down'));

        await initWebsocket();
        expect(request).toHaveBeenCalledTimes(1);

        watchState.isLoggedIn = false;
        await vi.advanceTimersByTimeAsync(20000);
        expect(request).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });
});
