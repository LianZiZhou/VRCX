/**
 * [hub] Node replacement for the `src/plugins` barrel.
 *
 * The real barrel does `export * from './components'` and `'./router'`, which
 * pulls every `.vue` view into the module graph. Only two data-core modules
 * import from the barrel at all:
 *
 *   - `stores/index.js`             -> getSentry, isSentryOptedIn
 *   - `stores/settings/appearance.js` -> loadLocalizedStrings
 *
 * Everything else imports `plugins/i18n` or `plugins/router` directly, so this
 * shim only has to cover those three names.
 */

export { i18n, loadLocalizedStrings, tForLocale, updateLocalizedStrings } from '../../plugins/i18n';
export { router, initRouter } from './router.js';

/** Sentry is never initialised in the Hub. */
export function getSentry() {
    return null;
}

/** @returns {Promise<boolean>} */
export async function isSentryOptedIn() {
    return false;
}

export async function initSentry() {}
