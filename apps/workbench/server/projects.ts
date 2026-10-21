import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project, ProjectSummary } from '../shared/types.js';
import { HttpError, requestObject, textField } from './errors.js';
import { validateScene } from './scenes.js';

export const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectStore {
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    if (!PROJECT_ID.test(id)) {
      throw new HttpError(400, 'invalid_project_id', '项目 ID 必须是 UUID。');
    }
    return resolve(this.directory, `${id.toLowerCase()}.json`);
  }

  async load(id: string): Promise<Project> {
    const path = this.path(id);
    let serialized: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
        throw new HttpError(422, 'invalid_project', '项目文件格式不正确。');
      }
      serialized = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'project_not_found', '找不到该项目。');
      }
      throw error;
    }
    let value: Record<string, unknown>;
    try {
      value = requestObject(JSON.parse(serialized), [
        'schemaVersion',
        'id',
        'title',
        'createdAt',
        'updatedAt',
        'instruction',
        'scene',
      ]);
    } catch {
      throw new HttpError(422, 'invalid_project', '项目 JSON 格式不正确。');
    }
    if (
      value.schemaVersion !== 'genui-workbench-project/v1' ||
      value.id !== id.toLowerCase() ||
      typeof value.title !== 'string' ||
      !value.title.trim() ||
      value.title.length > 200 ||
      typeof value.instruction !== 'string' ||
      value.instruction.length > 16000 ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt))
    ) {
      throw new HttpError(422, 'invalid_project', '项目数据格式不正确。');
    }
    return {
      schemaVersion: 'genui-workbench-project/v1',
      id: id.toLowerCase(),
      title: value.title,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      instruction: value.instruction,
      scene: await validateScene(value.scene),
    };
  }

  async list(): Promise<ProjectSummary[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      const id = entry.name.slice(0, -5);
      if (!entry.isFile() || !entry.name.endsWith('.json') || !PROJECT_ID.test(id)) continue;
      try {
        const project = await this.load(id);
        summaries.push({ id: project.id, title: project.title, updatedAt: project.updatedAt });
      } catch (error) {
        // A malformed or interrupted user-edited file must not break other projects.
        if (!(error instanceof HttpError)) throw error;
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(input: unknown): Promise<Project> {
    const value = requestObject(input, ['id', 'title', 'scene', 'instruction']);
    const suppliedId = textField(value.id, '项目 ID', 36, true);
    const id = suppliedId?.toLowerCase() ?? randomUUID();
    const path = this.path(id);
    const title = textField(value.title, '标题', 200)!;
    if (
      value.instruction !== undefined &&
      (typeof value.instruction !== 'string' || value.instruction.length > 16000)
    ) {
      throw new HttpError(400, 'invalid_request', '创作要求必须是最多 16000 个字符的文本。');
    }
    const scene = await validateScene(value.scene);
    let existing: Project | undefined;
    if (suppliedId) {
      try {
        existing = await this.load(id);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    const now = new Date().toISOString();
    const project: Project = {
      schemaVersion: 'genui-workbench-project/v1',
      id,
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      instruction: (value.instruction as string | undefined) ?? existing?.instruction ?? '',
      scene,
    };
    await mkdir(this.directory, { recursive: true });
    const temporary = resolve(this.directory, `${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(project, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      // Clean up only this explicitly named single temporary file.
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return project;
  }
}
