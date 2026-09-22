/**
 * Does `npm install` need to run.
 *
 * Exit 0 when it does, 1 when node_modules is current. Both launchers call
 * this rather than each answering it in their own shell: the POSIX one had
 * `[ package-lock.json -nt node_modules ]`, and cmd.exe has no equivalent that
 * is worth writing in batch. node is guaranteed present by the time either
 * launcher gets here, so the check may as well live in one file that both read.
 *
 * Uses nothing outside node:fs, because it runs BEFORE dependencies exist.
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mtime = (p) => { try { return statSync(join(root, p)).mtimeMs; } catch { return null; } };

const mods = mtime('node_modules');
const lock = mtime('package-lock.json') ?? mtime('package.json');

// No node_modules at all, or a lockfile that moved after it was last installed.
// A missing lockfile AND a missing package.json would be a broken checkout, and
// installing is the more useful answer there than silently serving.
process.exit(mods === null || lock === null || lock > mods ? 0 : 1);
