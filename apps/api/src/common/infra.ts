import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import {
  EngineRegistry,
  LocalStorageDriver,
  createEngineRegistry,
  loadConfig,
  type AppConfig,
  type StorageDriver,
} from '@voxstudio/core';
import { PrismaClient } from '@voxstudio/db';

export const CONFIG = Symbol('CONFIG');
export const STORAGE = Symbol('STORAGE');

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON logger. Callers must never pass user text or audio content. */
@Injectable()
export class Logger {
  constructor(private readonly level: Level = 'info') {}
  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: 'api', msg, ...fields });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
  info(msg: string, f?: Record<string, unknown>): void {
    this.log('info', msg, f);
  }
  warn(msg: string, f?: Record<string, unknown>): void {
    this.log('warn', msg, f);
  }
  error(msg: string, f?: Record<string, unknown>): void {
    this.log('error', msg, f);
  }
  debug(msg: string, f?: Record<string, unknown>): void {
    this.log('debug', msg, f);
  }
}

export function makeInfraProviders(config: AppConfig) {
  return [
    { provide: CONFIG, useValue: config },
    { provide: Logger, useValue: new Logger(config.env === 'test' ? 'warn' : config.logLevel) },
    { provide: EngineRegistry, useValue: createEngineRegistry(config) },
    { provide: STORAGE, useValue: new LocalStorageDriver(config.storageRoot) as StorageDriver },
    {
      provide: PrismaService,
      useFactory: () => {
        const p = new PrismaService({ datasources: { db: { url: config.databaseUrl } } });
        return p;
      },
    },
  ];
}

@Global()
@Module({})
export class InfraModule {
  static forRoot(config: AppConfig = loadConfig()) {
    const providers = makeInfraProviders(config);
    return { module: InfraModule, providers, exports: providers.map((p) => p.provide) };
  }
}
