let observedWindow;
let deviceRequested = false;
let adapterInfo = null;

Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get: () => observedWindow,
    set: (value) => {
        observedWindow = value;
        let observedGpu;
        Object.defineProperty(value.navigator, 'gpu', {
            configurable: true,
            get: () => observedGpu,
            set: (gpu) => {
                observedGpu = gpu;
                const requestAdapter = gpu.requestAdapter.bind(gpu);
                gpu.requestAdapter = async (...argumentsList) => {
                    const adapter = await requestAdapter(...argumentsList);
                    if (adapter) {
                        deviceRequested = true;
                        const info = adapter.info || {};
                        adapterInfo = {
                            vendor: info.vendor || null,
                            architecture: info.architecture || null,
                            device: info.device || null,
                            description: info.description || null
                        };
                    }
                    return adapter;
                };
            }
        });
    }
});

const emitDevice = (code) => {
    if (code === 0) {
        writeSync(1, 'GS_SPLAT_DEVICE ' + JSON.stringify({
            backend: deviceRequested ? 'webgpu' : 'cpu',
            adapter: adapterInfo
        }) + '\n');
    }
};

const originalExit = process.exit.bind(process);
process.exit = (code = process.exitCode ?? 0) => {
    if (typeof process.execve === 'function') {
        emitDevice(Number(code));
        process.execve(process.execPath, [process.execPath, '-e',
            'process.exit(Number(process.argv[1]))', String(code)], process.env);
    }
    originalExit(code);
};
syncBuiltinESMExports();
process.on('exit', emitDevice);
import { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
