/**
 * [hub] Stub for `echarts`.
 *
 * `shared/utils/chart.js` lazy-loads echarts for the Charts views. Nothing the
 * Hub runs reaches that path, but bundling it anyway costs ~2.7 MB on a
 * Raspberry Pi image. Throwing rather than silently returning an empty object
 * means that if a future code path does reach for it on the Hub, we hear about
 * it instead of getting a mysterious undefined.
 */

function unavailable() {
    throw new Error('echarts is not available in the headless Hub');
}

export const init = unavailable;
export const use = unavailable;
export const registerTheme = unavailable;
export const getInstanceByDom = unavailable;

export default new Proxy({}, { get: unavailable });
