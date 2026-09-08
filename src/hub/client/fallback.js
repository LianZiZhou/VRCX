/**
 * [hub] What a mirror client does when the Hub goes away mid-session.
 *
 * The connection reconnects on its own with backoff, and most drops are brief —
 * the Pi rebooting, Wi-Fi hiccupping — so the first response is to say so and
 * wait rather than to tear the session down.
 *
 * If it stays down, the client offers to fall back to standalone. That path
 * reloads the window instead of re-pointing the bindings in place: the remote
 * and local databases hold different content and different per-user table
 * prefixes, and swapping them underneath a running app is a whole family of
 * half-migrated-state bugs. Re-entering the app is cheap and unambiguous.
 *
 * Everything here uses services the app already has — `vue-sonner` for
 * transient messages, the modal store for the prompt — so no UI component
 * changes are needed.
 */

import { ConnectionState } from './connection.js';
import { leaveMirrorMode } from './mirrorMode.js';

/** How long to let reconnection run before offering the fallback. */
const OFFER_FALLBACK_AFTER_MS = 20000;

let offerTimer = null;
let disconnectedSince = null;
let offering = false;

/**
 * Lazily resolved: this module is imported during boot, before Pinia exists.
 *
 * @returns {Promise<{toast: any, modalStore: any, t: any}>}
 */
async function ui() {
    const [{ toast }, { useModalStore }, { i18n }] = await Promise.all([
        import('vue-sonner'),
        import('../../stores/modal.js'),
        import('../../plugins/i18n.js')
    ]);
    return { toast, modalStore: useModalStore(), t: i18n.global.t };
}

function clearOfferTimer() {
    if (offerTimer) {
        clearTimeout(offerTimer);
        offerTimer = null;
    }
}

/**
 * Ask whether to drop to local mode, and act on the answer.
 *
 * @returns {Promise<void>}
 */
async function offerFallback() {
    if (offering) {
        return;
    }
    offering = true;
    try {
        const { modalStore } = await ui();
        const { ok } = await modalStore.confirm({
            title: 'VRCX Hub is unreachable',
            description:
                'The Hub has been offline for a while. Switch this client to local mode?\n\n' +
                'VRCX will reload and use this computer’s own database. Anything recorded ' +
                'while local stays local until you merge it back into the Hub.'
        });
        if (ok) {
            leaveMirrorMode();
        }
    } catch {
        // The dialog was dismissed; keep reconnecting in the background.
    } finally {
        offering = false;
    }
}

/**
 * Wire the connection's state changes to user-facing behaviour.
 *
 * @param {string} state - a `ConnectionState`
 * @param {any} detail
 */
export function handleHubConnectionState(state, detail) {
    switch (state) {
        case ConnectionState.READY:
            clearOfferTimer();
            if (disconnectedSince) {
                disconnectedSince = null;
                ui().then(({ toast }) => toast.success('Reconnected to the VRCX Hub'));
            }
            break;

        case ConnectionState.CLOSED:
            if (disconnectedSince) {
                break; // already counting
            }
            disconnectedSince = Date.now();
            ui().then(({ toast }) => toast.warning('Lost the VRCX Hub', { description: 'Reconnecting…' }));
            clearOfferTimer();
            offerTimer = setTimeout(() => {
                offerTimer = null;
                offerFallback();
            }, OFFER_FALLBACK_AFTER_MS);
            break;

        case ConnectionState.REJECTED:
            // Configuration, not connectivity: reconnecting will not help.
            clearOfferTimer();
            ui().then(({ toast }) =>
                toast.error('The VRCX Hub refused this client', {
                    description: detail?.message ?? 'Check the Hub URL, token and version.'
                })
            );
            offerFallback();
            break;

        default:
            break;
    }
}

/** Test seam. */
export function resetFallbackState() {
    clearOfferTimer();
    disconnectedSince = null;
    offering = false;
}
