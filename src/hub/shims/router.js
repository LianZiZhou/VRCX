/**
 * [hub] Node replacement for `src/plugins/router.js`.
 *
 * The real router module statically imports ~20 `.vue` views, which would drag
 * the entire UI (and therefore Vue SFC compilation, Tailwind, echarts, sigma…)
 * into the headless Hub bundle. The data core only needs three things from it:
 *
 *   - `router.currentRoute` — dereferenced at store construction time in
 *     `stores/friend.js`, `stores/gameLog/index.js`, `stores/ui.js`,
 *     `stores/settings/appearance.js` and `stores/charts.js`
 *   - `router.push({ name })` to not throw (`stores/charts.js`, `shared/utils/base/ui.js`)
 *   - the module-level `router` singleton imported by `stores/avatarProvider.js`
 *     and `stores/gallery.js`
 *
 * We build a genuine `createRouter` over memory history so `currentRoute` is a
 * real `ShallowRef` and named navigation resolves, but every route renders
 * nothing. Route names are kept in sync with the real router by the
 * `hubRouterRoutes` test in `src/hub/__tests__/`.
 */

import { createMemoryHistory, createRouter } from 'vue-router';

const Blank = { name: 'HubBlank', render: () => null };

/** Route names mirrored from `src/plugins/router.js`. */
export const routeNames = [
    'login',
    'feed',
    'friends-locations',
    'game-log',
    'player-list',
    'search',
    'dashboard',
    'favorite-friends',
    'favorite-worlds',
    'favorite-avatars',
    'friend-log',
    'moderation',
    'my-avatars',
    'notification',
    'friend-list',
    'charts',
    'charts-instance',
    'charts-mutual',
    'charts-hot-worlds',
    'tools',
    'gallery',
    'screenshot-metadata',
    'settings'
];

const routes = [
    { path: '/login', name: 'login', component: Blank, meta: { public: true } },
    {
        path: '/',
        component: Blank,
        children: [
            { path: '', redirect: { name: 'feed' } },
            ...routeNames
                .filter((name) => name !== 'login' && name !== 'charts')
                .map((name) => ({
                    path: name === 'dashboard' ? 'dashboard/:id' : name,
                    name,
                    component: Blank
                })),
            { path: 'charts', name: 'charts', redirect: { name: 'charts-instance' } }
        ]
    }
];

export const router = createRouter({
    history: createMemoryHistory(),
    // @ts-ignore
    routes
});

/**
 * @param {import('vue').App} app
 */
export function initRouter(app) {
    app.use(router);
}
