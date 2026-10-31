import { loadConfig } from '@voxstudio/core';
import { createApp } from './bootstrap';
import { Logger } from './common/infra';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.apiPort, '0.0.0.0');
  app.get(Logger).info('api listening', { port: config.apiPort, env: config.env });
}

main().catch((e: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      svc: 'api',
      msg: 'startup failed',
      err: (e as Error).message,
    }) + '\n',
  );
  process.exit(1);
});
