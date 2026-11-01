import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import {
  DISK_STATUS_STALE_MS,
  classifyDisk,
  measureDisk,
  type AppConfig,
  type DiskState,
} from '@voxstudio/core';
import { CONFIG, PrismaService } from './infra';

export interface DiskInfo {
  state: DiskState;
  totalBytes: number;
  freeBytes: number;
  checkedAt: string;
  /** true when the stored measurement was missing or stale and the API measured the volume itself */
  measuredHere: boolean;
}

/** Reads the worker's disk measurement; measures itself when there is none or it is stale. */
@Injectable()
export class DiskService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async info(): Promise<DiskInfo> {
    const row = await this.prisma.diskStatus.findUnique({ where: { id: 1 } });
    if (row && Date.now() - row.checkedAt.getTime() < DISK_STATUS_STALE_MS)
      return {
        state: row.state as DiskState,
        totalBytes: Number(row.totalBytes),
        freeBytes: Number(row.freeBytes),
        checkedAt: row.checkedAt.toISOString(),
        measuredHere: false,
      };
    const usage = await measureDisk(this.config.storageRoot);
    return {
      state: classifyDisk(usage, this.config.disk),
      ...usage,
      checkedAt: new Date().toISOString(),
      measuredHere: true,
    };
  }

  /** New audio jobs are refused while the disk is critically full. */
  async assertWritable(): Promise<void> {
    const d = await this.info();
    if (d.state === 'block')
      throw new VoxError(
        ErrorCodes.DISK_FULL,
        'The server is almost out of storage space, so new audio cannot be created right now. Saved audio still plays. Try again later.',
        { freeBytes: d.freeBytes },
      );
  }
}
