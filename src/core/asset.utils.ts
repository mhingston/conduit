import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the absolute path to an asset file, handling both source (dev)
 * and distribution (prod) directory structures.
 * 
 * Strategies:
 * 1. ../assets/{filename} (Source: src/core -> src/assets)
 * 2. ./assets/{filename} (Dist: dist/ -> dist/assets, if core is merged or similar)
 * 3. ../../assets/{filename} (Dist: dist/core -> dist/assets)
 * 4. assets/{filename} (Relative to cwd, unlikely but fallback)
 * 
 * @param filename The name of the asset file (e.g., 'deno-shim.ts')
 * @returns The absolute path to the asset if found
 * @throws Error if the asset cannot be found
 */
export function resolveAssetPath(filename: string): string {
    const candidates = [
        // Source structure: src/core/asset.utils.ts -> src/assets/
        path.resolve(__dirname, '../assets', filename),
        // Dist structure possibility 1: dist/ (flat) with assets/ subdir
        path.resolve(__dirname, './assets', filename),
        // Dist structure possibility 2: dist/core/ -> dist/assets/
        path.resolve(__dirname, '../../assets', filename),
        // Dist structure possibility 3: dist/ -> assets/ (if called from root)
        path.resolve(process.cwd(), 'assets', filename),
        // Dist structure possibility 4: dist/assets/ (from root)
        path.resolve(process.cwd(), 'dist/assets', filename)
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Asset not found: ${filename}. Checked paths: ${candidates.join(', ')}`);
}
