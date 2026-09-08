/**
 * [hub] Node replacement for `src/localization/index.js`.
 *
 * The real module resolves locale JSON through
 * `import.meta.glob(..., { query: '?url' })` and then `fetch(url)`. In Node a
 * relative URL fetch throws, so `getLocalizedStrings` would silently return
 * `{}` and every `t()` call would come back as its own key. That matters on the
 * Hub because translated strings are *persisted and broadcast* — see
 * `shared/utils/notificationMessage.js` and `coordinators/gameLogCoordinator.js`.
 *
 * Here the JSON is imported directly so the bundler inlines it.
 */

import { languageCodes } from '../../localization/locales';

const messages = import.meta.glob('../../localization/*.json', {
    eager: true,
    import: 'default'
});

const FALLBACK = 'en';

/**
 * @param {string} code
 * @returns {object}
 */
function lookup(code) {
    return messages[`../../localization/${code}.json`];
}

/**
 * @param {string} code - The language code
 * @returns {Promise<object>} The localized strings
 */
async function getLocalizedStrings(code) {
    return lookup(code) ?? lookup(FALLBACK) ?? {};
}

/**
 * @param {string} code - The language code
 * @returns {string} The language name
 */
function getLanguageName(code) {
    return String(lookup(code)?.language ?? code);
}

export { resolveSystemLanguage } from '../../localization/index.js';
export * from '../../localization/locales';
export { getLanguageName, getLocalizedStrings, languageCodes };
