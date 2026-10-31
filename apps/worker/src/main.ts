import { loadConfig } from '@voxstudio/core';
import { createPrisma } from '@voxstudio/db';
import { RenderWorker } from './worker';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = createPrisma(config.databaseUrl);
  const worker = new RenderWorker({ config, prisma });
  await worker.start();
  const shutdown = async (signal: string) => {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        svc: 'worker',
        msg: 'shutting down',
        signal,
      }) + '\n',
    );
    await worker.stop({ abortRunning: true });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      svc: 'worker',
      msg: 'startup failed',
      err: (e as Error).message,
    }) + '\n',
  );
  process.exit(1);
});
