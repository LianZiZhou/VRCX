/**
 * [hub] Node replacement for `vue-sonner`.
 *
 * ~30 data-core modules call `toast(...)`. Without a mounted `<Toaster>` the
 * real library still retains every created toast in an internal array that
 * only a mounted component prunes, which is an unbounded leak in a 24/7
 * process. It would also drag Vue SFC rendering into the Node bundle.
 */

const log = (level, message, options) => {
    const description = options?.description;
    console.log(
        `[toast:${level}] ${typeof message === 'string' ? message : JSON.stringify(message)}${
            description ? ` - ${description}` : ''
        }`
    );
    return 0;
};

export const toast = Object.assign((message, options) => log('info', message, options), {
    error: (message, options) => log('error', message, options),
    success: (message, options) => log('success', message, options),
    warning: (message, options) => log('warning', message, options),
    info: (message, options) => log('info', message, options),
    message: (message, options) => log('info', message, options),
    custom: (message, options) => log('custom', message, options),
    loading: (message, options) => log('loading', message, options),
    dismiss: () => {},
    promise: (promise) => promise
});

export const Toaster = { name: 'ToasterStub', render: () => null };

export default { toast, Toaster };
