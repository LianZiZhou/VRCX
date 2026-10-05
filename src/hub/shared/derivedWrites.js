/**
 * [hub] What a mirror client may and may not write, by `database.*` method.
 *
 * Derived rows are produced by processing the VRChat pipeline and the game log.
 * In mirror mode the Hub has already processed the same events and written
 * these rows, so a client repeating them would duplicate every feed entry,
 * friend-log line and notification. Those are *suppressed*.
 *
 * User-initiated writes are deliberately absent: memos, notes, avatar tags,
 * local favourites, deletions and `configs` must still reach the Hub's DB when
 * a person clicks something in the UI. They pass through untouched.
 *
 * A few methods serve both: `addFriendLogHistory` is written by the friend
 * coordinators when the pipeline says a friend was added, *and* by the user
 * dialog when a person sends or cancels a friend request. The Hub covers the
 * first; nothing covers the second, so an earlier flat suppression made those
 * rows vanish on reload. Such methods get a predicate on their arguments.
 * Others turned out to be written from exactly one place that only a client
 * ever runs (`setFriendLogCurrentArray` from `initFriendLog`, say), and are
 * simply allowed; a mirror's statement lands on the same Hub connection the
 * Hub's own would.
 *
 * Kept as data rather than as edits at each call site on purpose. The call
 * sites are scattered (`setFriendLogCurrent` alone has nine), so guarding them
 * individually would mean a large diff that conflicts with upstream constantly.
 * Intercepting once at the single export point is three lines. The cost is that
 * an upstream rename silently drops a name from this table, which is what the
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
        // those follow a user action. `updateNotificationExpired` is allowed
        // (below): it is an idempotent UPDATE and one of its callers is the
        // user answering an invite that has already expired.
        'addNotificationToDatabase',
        'addNotificationV2ToDatabase',
        'expireNotificationV2',

        // services/database/friendLogCurrent.js — pipeline-driven removal.
        // The other friend-log methods are conditional or allowed, below.
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
        'addAvatarTimeSpent',

        // services/database/userProfile.js — the cache the bio diff compares
        // against (userCoordinator.js). A mirror runs the same comparison on
        // every relayed user update and whenever someone opens a profile; had
        // it updated the cache, the Hub would compare against the new bio,
        // find nothing changed, and never write the feed row only it writes.
        'setUserProfile'
    ])
);

/**
 * Derived inserts that resolve to the persisted entry, `{ ...entry, rowId }`,
 * or to nothing when no row was written. Callers only show an entry once it is
 * persisted (upstream 58033a22), so answering a suppressed call with undefined
 * would leave a mirror's feed and game log tables frozen until a reload.
 *
 * A mirror therefore gets its entry back with a synthetic rowId. The Hub wrote
 * the real row; the tables key and sort on rowId, so the synthetic ones are
 * unique and newer than any real row, and a reload replaces them.
 */
export const PERSISTED_ENTRY_WRITES = Object.freeze(
    new Set([
        'addGPSToDatabase',
        'addStatusToDatabase',
        'addBioToDatabase',
        'addAvatarToDatabase',
        'addOnlineOfflineToDatabase',
        'addGamelogLocationToDatabase',
        'addGamelogJoinLeaveToDatabase',
        'addGamelogPortalSpawnToDatabase',
        'addGamelogVideoPlayToDatabase',
        'addGamelogResourceLoadToDatabase',
        'addGamelogEventToDatabase',
        'addGamelogExternalToDatabase'
    ])
);

/** As above, for inserts that take and return an array of entries. */
export const PERSISTED_ENTRIES_WRITES = Object.freeze(new Set(['addGamelogJoinLeaveBulk']));

/**
 * Friend-log history types written by a person, from the user dialog's
 * Send / Cancel Friend Request buttons (`useUserDialogCommands.js`). The
 * pipeline-derived types are `Friend`, `Unfriend`, `DisplayName` and
 * `TrustLevel` (`friendRelationshipCoordinator.js`), and those the Hub writes.
 */
export const USER_FRIEND_LOG_TYPES = Object.freeze(new Set(['FriendRequest', 'CancelFriendRequest']));

/**
 * Methods that are derived in some call sites and user-initiated in others,
 * told apart by their arguments. The predicate answers "may a mirror run
 * this call".
 *
 * @type {Readonly<Record<string, (args: any[]) => boolean>>}
 */
export const CONDITIONAL_WRITES = Object.freeze({
    addFriendLogHistory: (args) => USER_FRIEND_LOG_TYPES.has(args?.[0]?.type)
});

/**
 * Methods that write derived-looking rows but are allowed from a mirror, each
 * for a stated reason. Listed so the decision is visible and tested, not so
 * the guard does anything with them.
 */
export const ALLOWED_ON_MIRROR = Object.freeze(
    new Set([
        // INSERT OR REPLACE on the primary key. The user-initiated local
        // favourite path (`favoriteCoordinator.js`) writes the cache row and
        // the favourite row together; with the cache row suppressed the
        // favourite came back with no name or thumbnail.
        'addWorldToCache',
        'addAvatarToCache',
        // `tryApplyFriendOrder` writes friend numbers here and then a "done"
        // sentinel to the shared `configs` table. Suppressing the rows while
        // the sentinel went through left the order applied nowhere, forever.
        'setFriendLogCurrent',
        // Sole caller is `initFriendLog`, the first-login path, which also
        // sets the `friendLogInit_<user>` flag: a mirror that signs in first
        // must actually write the table the flag says exists.
        'setFriendLogCurrentArray',
        // Sole caller is `migrateFriendLog`, which deletes the legacy source
        // from local VRCXStorage right after; suppressing the copy lost it.
        'addFriendLogHistoryArray',
        // Idempotent UPDATE; one caller is the user answering an expired invite.
        'updateNotificationExpired',
        // The only remaining caller after the mirror-gated migration path is
        // the user's "purge and compact" action, which must actually compact.
        'vacuum'
    ])
);

/**
 * Schema work. Only the Hub may run this: `upgradeDatabaseVersion` fans out to
 * migrations, and the C# layer has a single SQLite connection behind one
 * lock, so N clients migrating the same remote DB at once means long stalls
 * at best and a migration race at worst. `optimize` runs on a daily timer in
 * every client and is pointless N times over.
 */
export const SCHEMA_WRITES = Object.freeze(new Set(['upgradeDatabaseVersion', 'optimize']));

/**
 * Every method the guard may intercept. `derivedWrites.test.js` checks each
 * still exists on the real `database` object.
 *
 * @returns {Set<string>}
 */
export function mirrorSuppressedMethods() {
    return new Set([...DERIVED_WRITES, ...SCHEMA_WRITES, ...Object.keys(CONDITIONAL_WRITES)]);
}

/**
 * @param {string} method
 * @param {any[]} args
 * @returns {boolean} whether a mirror client must not execute this call
 */
export function isSuppressedOnMirror(method, args) {
    if (DERIVED_WRITES.has(method) || SCHEMA_WRITES.has(method)) {
        return true;
    }
    const predicate = CONDITIONAL_WRITES[method];
    if (predicate) {
        return !predicate(args);
    }
    return false;
}
