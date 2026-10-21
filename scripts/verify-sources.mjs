import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'SOURCE_MANIFEST.json'), 'utf8'));
let mismatches = 0;
for (const file of manifest.files) {
  try {
    const bytes = await readFile(resolve(root, file.destination));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      console.error(`Source differs: ${file.destination}`);
      mismatches++;
    }
  } catch {
    console.error(`Missing source: ${file.destination}`);
    mismatches++;
  }
}
console.log(`Verified ${manifest.files.length} copied files; mismatches: ${mismatches}.`);
process.exitCode = mismatches ? 1 : 0;
