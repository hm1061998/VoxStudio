import { Injectable } from '@nestjs/common';
import { Prisma } from '@voxstudio/db';
import { Logger, PrismaService } from './infra';

/**
 * Security and administration trail (table audit_events). Never stores passwords, tokens, full e-mail addresses of
 * unknown accounts or user text; writing must never break the request that triggered it.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  async record(e: {
    eventType: string;
    resourceType: string;
    resourceId: string;
    actorUserId?: string | null;
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          eventType: e.eventType,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          actorUserId: e.actorUserId ?? null,
          workspaceId: e.workspaceId ?? null,
          metadataJson: (e.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error('audit write failed', { eventType: e.eventType, err: (err as Error).name });
    }
    this.logger.info('audit', {
      eventType: e.eventType,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
    });
  }
}
