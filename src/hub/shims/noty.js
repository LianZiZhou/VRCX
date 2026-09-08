/**
 * [hub] Node replacement for `noty`.
 *
 * `stores/auth.js` and `coordinators/authCoordinator.js` construct Noty
 * instances on login/logout. Noty is a DOM + animation library with no
 * meaning in a headless process.
 */

export default class Noty {
    constructor(options = {}) {
        this.options = options;
    }

    show() {
        const { type, text } = this.options;
        console.log(`[noty:${type ?? 'info'}] ${text ?? ''}`);
        return this;
    }

    close() {
        return this;
    }

    static overrideDefaults() {}

    static closeAll() {}
}
