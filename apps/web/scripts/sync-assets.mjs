#!/usr/bin/env node
/**
 * Syncs build-time static dependencies into apps/web/public so the Vite dev
 * server and production build both serve them from the same origin:
 *
 *   /viewer/*          <- apps/viewer/dist   (SuperSplat embed build)
 *
 * Scene assets (`/local-scenes/*`) are NOT copied: the dev server serves them
 * straight from the git-ignored `scenes/` tree via the `gs-serve-streamed-
 * scenes` Vite middleware (real HTTP Range, symlink-aware). Copying would
 * break the `current` version symlink (absolute link escaping the public
 * root) and duplicate gigabytes of chunk units.
 *
 * The source directories are not committed (scene assets are large, viewer
 * dist is a build artifact), so this runs as a pre-step of dev/build.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');
const publicDir = join(webRoot, 'public');

/** Copy one tree into public/<name>, removing stale entries first. */
const syncTree = (name, sourceDir) => {
    const destDir = join(publicDir, name);
    rmSync(destDir, { recursive: true, force: true });
    if (!existsSync(sourceDir)) {
        console.log(`[sync-assets] skip ${name}: source ${sourceDir} not found`);
        return;
    }
    mkdirSync(destDir, { recursive: true });
    cpSync(sourceDir, destDir, { recursive: true });
    console.log(`[sync-assets] ${sourceDir} -> ${destDir}`);
};

syncTree('viewer', join(webRoot, '../viewer/dist'));
// local-scenes intentionally omitted — served from scenes/ by the dev
// middleware (see vite.config.ts gs-serve-streamed-scenes).