import { cp, lstat, mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const standalone = path.resolve(fileURLToPath(new URL('../../.next/standalone/', import.meta.url)));
const packages = path.join(standalone, 'packages');
const scope = path.join(standalone, 'node_modules/@reachany');
await mkdir(scope, { recursive: true });
// Next's Windows tracing copies workspace files but can omit their package links.
// Materialize only files already in the artifact; never point back to the checkout.
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const target = path.join(scope, entry.name);
  try {
    const resolved = await realpath(target);
    if (!resolved.startsWith(`${standalone}${path.sep}`))
      throw new Error(`Standalone package escapes its artifact: ${entry.name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const existing = await lstat(target).catch((failure) => {
      if (failure.code !== 'ENOENT') throw failure;
      return undefined;
    });
    // Unlink only the dangling mapping itself, never follow it into another tree.
    if (existing?.isSymbolicLink()) await unlink(target);
    await cp(path.join(packages, entry.name), target, { recursive: true, dereference: true });
  }
}
