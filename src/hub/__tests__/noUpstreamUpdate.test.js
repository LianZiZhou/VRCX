/**
 * [hub] A Hub client never auto-updates to upstream's build.
 *
 * Upstream's updater asks api0.vrcx.app for the latest release and, with the
 * default "Auto Download", fetches and installs it. That installer is plain
 * VRCX: on 2026-09-16 it replaced a mirror client, which then started
 * standalone against its own local database. The fork turns the updater off
 * the same way upstream does for builds that cannot self-update.
 */

import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    configRepository: {
        getString: vi.fn(),
        setString: vi.fn(),
        getBool: vi.fn()
    },
    toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
}));

vi.mock('../../services/config', () => ({ default: mocks.configRepository }));
vi.mock('vue-sonner', () => ({ toast: mocks.toast }));
vi.mock('vue-i18n', async (importOriginal) => {
    const { ref } = await import('vue');
    return { ...(await importOriginal()), useI18n: () => ({ t: (key) => key, locale: ref('en') }) };
});

const { useVRCXUpdaterStore } = await import('../../stores/vrcxUpdater');

/** @returns {Promise<void>} */
function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Hub client updater', () => {
    const saved = {};

    beforeEach(() => {
        for (const key of ['AppApi', 'webApiService']) {
            saved[key] = globalThis[key];
        }
        saved.electron = globalThis.window?.electron;
        mocks.configRepository.getString.mockImplementation((key, defaultValue) =>
            // What a user who never opened the setting has: the default.
            Promise.resolve(key === 'VRCX_autoUpdateVRCX' ? 'Auto Download' : (defaultValue ?? ''))
        );
        mocks.configRepository.setString.mockResolvedValue(undefined);
        mocks.configRepository.getBool.mockResolvedValue(false);
        globalThis.AppApi = {
            GetVersion: vi.fn().mockResolvedValue('2026.07.18'),
            DownloadUpdate: vi.fn()
        };
        globalThis.webApiService = {
            execute: vi.fn().mockResolvedValue({
                status: 200,
                data: JSON.stringify({ name: '2099.01.01', published_at: '2099-01-01', body: '', assets: [] })
            })
        };
        // An installer build: upstream would leave its updater on.
        globalThis.window.electron = {
            getArch: vi.fn().mockResolvedValue('x64'),
            getNoUpdater: vi.fn().mockResolvedValue(false)
        };
        setActivePinia(createPinia());
    });

    afterEach(() => {
        globalThis.AppApi = saved.AppApi;
        globalThis.webApiService = saved.webApiService;
        globalThis.window.electron = saved.electron;
    });

    it('keeps auto-update off and never asks upstream for a release', async () => {
        const store = useVRCXUpdaterStore();
        await vi.waitFor(() => expect(globalThis.AppApi.GetVersion).toHaveBeenCalled());
        await flushPromises();

        expect(store.noUpdater).toBe(true);
        expect(store.autoUpdateVRCX).toBe('Off');
        expect(globalThis.webApiService.execute).not.toHaveBeenCalled();
        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
        // The shared setting on the Hub is left as the user set it.
        expect(mocks.configRepository.setString).not.toHaveBeenCalledWith('VRCX_autoUpdateVRCX', expect.anything());
    });
});
