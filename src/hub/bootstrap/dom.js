/**
 * [hub] Browser environment for the headless Hub.
 *
 * Side-effect module. Must be evaluated before anything under `src/` is
 * imported, because several stores touch DOM globals at module scope and at
 * store-construction time.
 *
 * Registers happy-dom globally, then fills the gaps happy-dom leaves that the
 * VRCX data core actually reaches.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

let registered = false;

/**
 * Install the DOM environment. Idempotent.
 */
export function installDom() {
    if (registered) {
        return;
    }
    registered = true;

    GlobalRegistrator.register({
        url: 'http://localhost/',
        settings: {
            // `shared/utils/base/ui.js#refreshCustomScript()` appends the user's
            // custom script to <head>, and it is called from `stores/vrcx.js`
            // during init(). happy-dom executes scripts by default, so without
            // these flags the Hub would evaluate arbitrary user JS in-process.
            disableJavaScriptEvaluation: true,
            disableJavaScriptFileLoading: true,
            disableCSSFileLoading: true,
            disableComputedStyleRendering: true
        }
    });

    installExtraGlobals();
}

/**
 * Globals happy-dom does not provide but the data core uses.
 */
export function installExtraGlobals() {
    // `stores/settings/notifications.js` calls speechSynthesis.getVoices()
    // during store construction.
    globalThis.speechSynthesis ??= {
        getVoices: () => [],
        cancel: () => {},
        speak: () => {},
        pause: () => {},
        resume: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    globalThis.SpeechSynthesisUtterance ??= class {
        constructor(text) {
            this.text = text;
        }
    };

    // The Electron preload surface. Reached from stores/vrcx.js init(), and
    // every second from updateLoop -> vr.js. An unguarded throw there is
    // swallowed by the update loop's catch and starves the rest of the tick.
    globalThis.electron ??= new Proxy(
        {
            ipcRenderer: {
                on: () => {},
                off: () => {},
                once: () => {},
                send: () => {},
                invoke: async () => undefined
            },
            // stores/vrcxUpdater.js asks for these at start-up and logs the
            // first. A Hub cannot replace its own files, so the updater is
            // told to stand down rather than fetch release notes every boot.
            getArch: async () => process.arch,
            getNoUpdater: async () => true
        },
        {
            get(target, prop) {
                if (prop in target) {
                    return target[prop];
                }
                return async () => undefined;
            }
        }
    );

    // Imported at module scope by @dnd-kit/vue in the browser build; harmless
    // insurance here.
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };

    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.electron ??= globalThis.electron;
        globalThis.window.speechSynthesis ??= globalThis.speechSynthesis;
    }
}

installDom();
