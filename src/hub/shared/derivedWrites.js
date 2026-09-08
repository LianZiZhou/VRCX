/**
 * [hub] Names of the `database.*` methods that write *derived* rows.
 *
 * Derived rows are produced by processing the VRChat pipeline and the game log.
 * In mirror mode the Hub has already processed the same events and written
 * these rows, so a client repeating them would duplicate every feed entry,
 * friend-log line and notification.
 *
 * User-initiated writes are deliberately absent: memos, notes, avatar tags,
 * local favourites, deletions and `configs` must still reach the Hub's DB when
 * a person clicks something in the UI.
 *
 * Kept as data rather than as edits at each call site on purpose. The call
 * sites are scattered (`setFriendLogCurrent` alone has nine), so guarding them
 * individually would mean a large diff that conflicts with upstream constantly.
 * Intercepting once at the single export point is three lines. The cost is that
 * an upstream rename silently drops a name from this set, which is what the
 * `derivedWrites.test.js` assertion exists to catch.
 */

export const DERIVED_WRITES = Object.freeze(
    new Set([
        // services/database/feed.js — written from userEventCoordinator and
        // friendPresenceCoordinator on pipeline events.
        'addGPSToDatabase',
        'addStatusToDatabase',
        'addBioToDatabase',
        'addAvatarToDatabase',
        'addOnlineOfflineToDatabase',

        // services/database/gameLog.js — written while ingesting game log lines.
        'addGamelogLocationToDatabase',
        'updateGamelogLocationTimeToDatabase',
        'addGamelogJoinLeaveToDatabase',
        'addGamelogJoinLeaveBulk',
        'addGamelogPortalSpawnToDatabase',
        'addGamelogVideoPlayToDatabase',
        'addGamelogResourceLoadToDatabase',
        'addGamelogEventToDatabase',
        'addGamelogExternalToDatabase',

        // services/database/notifications.js — pipeline notification handling.
        // Note `deleteNotification*` and `seenNotificationV2` are NOT here:
        // those follow a user action.
        'addNotificationToDatabase',
        'addNotificationV2ToDatabase',
        'updateNotificationExpired',
        'expireNotificationV2',

        // services/database/friendLogHistory.js + friendLogCurrent.js —
        // friend add/remove/rename derivation.
        'addFriendLogHistory',
        'addFriendLogHistoryArray',
        'setFriendLogCurrent',
        'setFriendLogCurrentArray',
        'deleteFriendLogCurrent',

        // services/database/moderation.js — derived purely from Photon events
        // (stores/photon.js is the only caller). Photon arrives on the Hub via
        // the client uplink, so the Hub owns these writes like any other.
        'setModeration',
        'deleteModeration',

        // services/database/avatarFavorites.js — avatar history tracking.
        // addAvatarTimeSpent is `SET time = time + @x`, a read-modify-write in
        // SQL: if both the Hub and a client ran it the counter would double.
        'addAvatarToHistory',
        'addAvatarTimeSpent'
    ])
);

/**
 * Methods that are safe to run from any process because they are idempotent
 * (`INSERT OR REPLACE` on a primary key) but are still owned by the Hub to
 * avoid pointless duplicate traffic. Kept separate from `DERIVED_WRITES` so the
 * distinction stays visible.
 */
export const HUB_OWNED_CACHE_WRITES = Object.freeze(new Set(['addAvatarToCache', 'addWorldToCache']));

/**
 * Schema work. Only the Hub may run this: `upgradeDatabaseVersion` fans out to
 * migrations plus `vacuum()`, and the C# layer has a single SQLite connection
 * behind one lock, so N clients migrating the same remote DB at once means long
 * stalls at best and a migration race at worst.
 */
export const SCHEMA_WRITES = Object.freeze(new Set(['upgradeDatabaseVersion', 'vacuum', 'optimize']));

/**
 * Everything a mirror client must not execute.
 *
 * @returns {Set<string>}
 */
export function mirrorSuppressedMethods() {
    return new Set([...DERIVED_WRITES, ...HUB_OWNED_CACHE_WRITES, ...SCHEMA_WRITES]);
}
