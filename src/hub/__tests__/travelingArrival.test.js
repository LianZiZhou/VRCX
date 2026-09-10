/**
 * [hub] A friend who comes online while traveling still gets a GPS entry for
 * where they arrive.
 *
 * Upstream's Online entry for such a friend says "traveling", and since
 * 654872fc (2024-11) the arrival that follows was dropped as "no previous
 * location", so the first stop after login went unrecorded. The Hub keeps it.
 * Runs the real coordinator against the real store graph.
 */

import { startHubCore } from '../bootstrap/core.js';
import { runHandleUserUpdateFlow } from '../../coordinators/userEventCoordinator';

const WORLD_A = 'wrld_aaaaaaaa-0000-0000-0000-000000000000:11111~region(jp)';
const WORLD_B = 'wrld_bbbbbbbb-0000-0000-0000-000000000000:22222~region(jp)';

/**
 * @param {string} id
 * @returns {object}
 */
function fakeWorld(id) {
    return {
        id,
        name: `World ${id.slice(5, 13)}`,
        description: '',
        authorId: 'usr_author',
        authorName: 'Author',
        releaseStatus: 'public',
        capacity: 32,
        recommendedCapacity: 16,
        imageUrl: '',
        thumbnailImageUrl: '',
        version: 1,
        organization: 'vrchat',
        tags: [],
        favorites: 0,
        visits: 0,
        popularity: 0,
        heat: 0,
        occupants: 0,
        publicOccupants: 0,
        privateOccupants: 0,
        instances: [],
        udonProducts: [],
        unityPackages: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        publicationDate: '2026-01-01T00:00:00.000Z',
        labsPublicationDate: 'none'
    };
}

/**
 * @param {string} location
 * @returns {object}
 */
function fakeInstance(location) {
    const [worldId, instanceId] = location.split(':');
    return {
        id: location,
        location,
        instanceId,
        worldId,
        name: instanceId.split('~')[0],
        type: 'public',
        ownerId: null,
        tags: [],
        active: true,
        full: false,
        n_users: 1,
        userCount: 1,
        capacity: 32,
        recommendedCapacity: 16,
        platforms: { standalonewindows: 1, android: 0, ios: 0 },
        region: 'jp',
        permanent: false,
        photonRegion: 'jp',
        secureName: 'x',
        shortName: 'x',
        clientNumber: 'unknown',
        canRequestInvite: true,
        hasCapacityForYou: true,
        queueEnabled: false,
        world: fakeWorld(worldId),
        users: []
    };
}

describe('GPS for the first stop after coming online', () => {
    let app = null;
    let stores = null;

    beforeAll(async () => {
        ({ app, stores } = await startHubCore());
        // A feed entry with a location makes the stores fetch the world and
        // the instance, fire-and-forget. The default stub answers 503, which
        // the Hub logs as an unhandled rejection and vitest fails on; answer
        // with a bare-bones world and instance instead.
        globalThis.WebApi.ExecuteJson = async (requestJson) => {
            const { url } = JSON.parse(requestJson);
            const path = new URL(url).pathname;
            let message = null;
            const world = path.match(/\/worlds\/(wrld_[^/]+)$/);
            const instance = path.match(/\/instances\/([^/]+)$/);
            if (world) {
                message = fakeWorld(world[1]);
            } else if (instance) {
                message = fakeInstance(decodeURIComponent(instance[1]));
            }
            return JSON.stringify(
                message ? { status: 200, message: JSON.stringify(message) } : { status: 503, message: '' }
            );
        };
    });

    afterAll(() => {
        app?.unmount();
    });

    beforeEach(() => {
        stores.feed.feedTableData = [];
    });

    /**
     * @param {string} id
     * @param {string} previousLocation what the friend's location was before this update
     * @returns {object} the user ref as `applyUser` would have left it
     */
    function friend(id, previousLocation) {
        const now = Date.now();
        const ref = {
            id,
            displayName: `Friend ${id}`,
            state: 'online',
            location: '',
            $location_at: now - 1000,
            // Set when the location changed to "traveling": the location before that.
            $previousLocation: previousLocation,
            $travelingToTime: now - 1000
        };
        stores.friend.friends.set(id, { id, name: ref.displayName, state: 'online', ref });
        return ref;
    }

    /** @returns {object[]} */
    function gpsEntries() {
        return stores.feed.feedTableData.filter((entry) => entry.type === 'GPS');
    }

    it('records the arrival when the friend came online traveling', async () => {
        const ref = friend('usr_traveler', 'offline');
        await runHandleUserUpdateFlow(ref, { location: [WORLD_A, 'traveling', 1000] });
        expect(gpsEntries()).toMatchObject([
            { type: 'GPS', userId: 'usr_traveler', location: WORLD_A, previousLocation: 'traveling' }
        ]);
    });

    it('still skips it when the friend came online straight into a world', async () => {
        // The Online entry already carries WORLD_B; a GPS "offline -> WORLD_B" would repeat it.
        const ref = friend('usr_direct', '');
        await runHandleUserUpdateFlow(ref, { location: [WORLD_B, 'offline', 1000] });
        expect(gpsEntries()).toEqual([]);
    });

    it('still records an ordinary move between worlds', async () => {
        const ref = friend('usr_mover', WORLD_A);
        await runHandleUserUpdateFlow(ref, { location: [WORLD_B, 'traveling', 1000] });
        expect(gpsEntries()).toMatchObject([{ userId: 'usr_mover', location: WORLD_B, previousLocation: WORLD_A }]);
    });
});
