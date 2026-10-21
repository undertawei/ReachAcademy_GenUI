import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../../../packages/reach-deck-player/src/interactiveExternalRuntimes.generated.js';
import { HttpError } from './errors.js';

export { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES };

/** Serve only immutable files present in the original checked-in pin registry. */
export class RuntimeStore {
  private readonly cache = new Map<string, Buffer>();
  constructor(private readonly publicDirectory: string) {}

  async get(pathname: string): Promise<Buffer> {
    const pin = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      (entry) => entry.scriptPath === pathname,
    );
    if (!pin) throw new HttpError(404, 'runtime_not_found', '找不到该固定版本运行库。');
    const cached = this.cache.get(pathname);
    if (cached) return cached;
    const path = resolve(this.publicDirectory, pathname.slice(1));
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== pin.sourceBytes)
        throw new Error('runtime_size');
      const contents = await readFile(path);
      if (createHash('sha256').update(contents).digest('hex') !== pin.sha256)
        throw new Error('runtime_digest');
      this.cache.set(pathname, contents);
      return contents;
    } catch {
      throw new HttpError(
        503,
        'runtime_unavailable',
        '本地固定版本运行库缺失或校验失败，请重新准备工作台资源。',
      );
    }
  }
}
