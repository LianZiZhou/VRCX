/**
 * [hub] Which way a raw IPC packet goes on a mirror client.
 *
 * The named-pipe bridge from the C# side carries three kinds of traffic:
 *
 *   hub    Photon data (`OnEvent`, `OnOperationResponse`, `VRCEvent`, ...)
 *          and the VRCX messages that produce database rows (`Noty`,
 *          `External`). One writer: the Hub processes these and echoes the
 *          packet to every client, sender included.
 *   both   Facts the Hub needs *and* the machine needs for itself: `Ping`
 *          (sets `ipcEnabled`, which gates the portal-spawn and avatar-change
 *          handlers in `gameLogCoordinator.js`), `MsgPing` (the external
 *          notifier version that gates `VrcxMessage/Noty` rows), and
 *          `Event7List` (the Photon bot check). Sent up and processed locally;
 *          the Hub does not echo them.
 *   local  Machine-only control: `LaunchCommand` (a `vrcx://` link clicked on
 *          this PC must open a dialog here, not on every attached client and
 *          not on the Hub), `VRCXLaunch`, and the custom-tag messages, which
 *          edit this client's in-memory tag map.
 *
 * Shared so the Hub's echo filter and the client's uplink guard cannot drift.
 */

export const IpcRoute = Object.freeze({
    LOCAL: 'local',
    BOTH: 'both',
    HUB: 'hub'
});

const LOCAL_TYPES = new Set(['LaunchCommand', 'VRCXLaunch']);
const BOTH_TYPES = new Set(['Ping', 'MsgPing', 'Event7List']);
const LOCAL_VRCX_MESSAGES = new Set(['CustomTag', 'ClearCustomTags']);

/**
 * @param {string | object} packet - the raw JSON string from the pipe, or its parsed form
 * @returns {string} one of `IpcRoute`
 */
export function classifyIpc(packet) {
    let data = packet;
    if (typeof packet === 'string') {
        try {
            data = JSON.parse(packet);
        } catch {
            // Unparseable: let the Hub log it, where the log is watched.
            return IpcRoute.HUB;
        }
    }
    if (!data || typeof data !== 'object') {
        return IpcRoute.HUB;
    }
    if (LOCAL_TYPES.has(data.type)) {
        return IpcRoute.LOCAL;
    }
    if (data.type === 'VrcxMessage' && LOCAL_VRCX_MESSAGES.has(data.MsgType)) {
        return IpcRoute.LOCAL;
    }
    if (BOTH_TYPES.has(data.type)) {
        return IpcRoute.BOTH;
    }
    return IpcRoute.HUB;
}

/**
 * Whether the Hub should echo a packet it processed back to the clients.
 *
 * @param {string | object} packet
 * @returns {boolean}
 */
export function isEchoedIpc(packet) {
    return classifyIpc(packet) === IpcRoute.HUB;
}
