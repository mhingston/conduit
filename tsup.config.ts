import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'executors/pyodide.worker': 'src/executors/pyodide.worker.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    loader: {
        '.py': 'text',
        '.ts': 'text', // We want the shim source as text
    },
    // Ensure assets are included
    // We can use the 'onSuccess' hook to copy them or just include them in the bundle
    // But the spec says 'into dist/assets', which implies they should be separate files.
    // tsup doesn't have a direct 'copy directory' but we can use a custom plugin or hook.
    onSuccess: 'mkdir -p dist/assets && cp src/assets/* dist/assets/',
});
