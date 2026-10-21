import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('infra/docker/ai-runtime-browser-manifest.json'));

describe('offline browser base image source contract', () => {
  it('aligns API, Worker, image catalog and build script on the exact browser base tag', () => {
    for (const file of [
      'services/ai-runtime/Dockerfile.api',
      'services/ai-runtime/Dockerfile.worker',
      'infra/docker/images.yml',
      'infra/appstack/services/build-ai-runtime-api-worker-base-acr.sh',
    ]) {
      expect(read(file)).toContain(manifest.baseTag);
    }
    expect(read('services/ai-runtime/Dockerfile.api')).toContain('USER nextjs');
    expect(read('services/ai-runtime/Dockerfile.worker')).toContain('USER nextjs');
  });

  it('pins and checksums all browser packages while retaining the sandbox and license', () => {
    const dockerfile = read('infra/docker/ai-runtime-api-worker-base.Dockerfile');
    expect(dockerfile).toContain(`ARG CHROMIUM_VERSION=${manifest.browser.packageVersion}`);
    expect(dockerfile).toContain('sha256sum --check SHA256SUMS');
    expect(dockerfile).toContain(`test -x ${manifest.browser.executablePath}`);
    expect(dockerfile).toContain(`test -u ${manifest.browser.sandboxPath}`);
    expect(dockerfile).toContain('test -s /usr/share/doc/chromium/copyright');
    expect(dockerfile).not.toContain('--no-sandbox');
    const hashes = read(manifest.browser.sha256Manifest).trim().split(/\r?\n/);
    expect(hashes).toHaveLength(3);
    for (const pkg of manifest.browser.packages) {
      expect(
        hashes.some(
          (entry) =>
            /^[a-f0-9]{64}  /.test(entry) &&
            entry.endsWith(`${pkg}_${manifest.browser.packageVersion}_amd64.deb`),
        ),
      ).toBe(true);
      expect(dockerfile).toContain(`"${pkg}=\${CHROMIUM_VERSION}"`);
    }
    const context = read('infra/docker/ai-runtime-api-worker-base.Dockerfile.dockerignore');
    expect(context).toContain('!infra/docker/ai-runtime-chromium.SHA256SUMS');
    expect(context).toContain('!infra/docker/ai-runtime-browser-manifest.json');
  });
});
