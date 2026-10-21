import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { createWorkbenchServer, WORKSPACE_ROOT, type WorkbenchServerOptions } from './http.js';

const envPath = resolve(WORKSPACE_ROOT, '.env');
if (existsSync(envPath)) loadDotEnv({ path: envPath, quiet: true });

const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const configuredPort = process.env.GENUI_PORT?.trim();
const port = configuredPort ? Number(configuredPort) : 5310;
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('GENUI_PORT 必须是 1–65535 的整数；留空时使用 5310。');
}
const options: WorkbenchServerOptions = {};
const server = createWorkbenchServer(options);
const vite = production
  ? undefined
  : await createViteServer({
      configFile: resolve(WORKSPACE_ROOT, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { host: '127.0.0.1', server } },
      appType: 'spa',
    });
options.middleware = vite?.middlewares;
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请先关闭已有工作台进程。`
      : '工作台启动失败，请检查本地端口和目录权限。',
  );
  process.exitCode = 1;
  void vite?.close();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`GenUI 工作台已启动：http://127.0.0.1:${port}`);
  console.log('API Key 仅由本地服务端读取；示例和 HTML 导入可离线使用。');
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await vite?.close();
  server.close();
  server.closeAllConnections();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
