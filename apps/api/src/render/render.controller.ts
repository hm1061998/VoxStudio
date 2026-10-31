import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  localeSchema,
  outputProfileSchema,
  previewRequestSchema,
  renderRequestSchema,
  synthesisSettingsSchema,
  voiceIdSchema,
} from '@voxstudio/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CurrentUser,
  RawResponse,
  UuidPipe,
  ZodPipe,
  type SessionUser,
  type VoxRequest,
} from '../common/http';
import { JobEventsService } from './events.service';
import { RenderService } from './render.service';

const standalonePreviewSchema = z.strictObject({
  text: z.string().min(1).max(1000),
  voiceId: voiceIdSchema,
  locale: localeSchema,
  settings: synthesisSettingsSchema.optional(),
});
const exportSchema = z.strictObject({
  revision: z.number().int().min(0),
  outputProfile: outputProfileSchema,
});

@Controller()
export class RenderController {
  constructor(
    private readonly render: RenderService,
    private readonly events: JobEventsService,
  ) {}

  /** The caller's plan, limits and this month's AI usage (for the account page). */
  @Get('me/plan')
  myPlan(@CurrentUser() user: SessionUser) {
    return this.render.planFor(user);
  }

  @Post('segments/:segmentId/preview')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  preview(
    @CurrentUser() user: SessionUser,
    @Param('segmentId', UuidPipe) id: string,
    @Body(new ZodPipe(previewRequestSchema)) body: z.infer<typeof previewRequestSchema>,
  ) {
    return this.render.previewSegment(user, id, body, 'preview');
  }

  @Post('segments/:segmentId/render')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  renderSegment(@CurrentUser() user: SessionUser, @Param('segmentId', UuidPipe) id: string) {
    return this.render.previewSegment(user, id, {}, 'render');
  }

  @Post('previews')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  previewText(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(standalonePreviewSchema)) body: z.infer<typeof standalonePreviewSchema>,
  ) {
    return this.render.previewText(user, body);
  }

  @Post('projects/:projectId/render')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  renderProject(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(renderRequestSchema)) body: z.infer<typeof renderRequestSchema>,
  ) {
    return this.render.renderProject(user, id, body.revision, body.outputProfile, 'render');
  }

  @Post('projects/:projectId/export')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  exportProject(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(exportSchema)) body: z.infer<typeof exportSchema>,
  ) {
    return this.render.renderProject(user, id, body.revision, body.outputProfile, 'export');
  }

  @Get('projects/:projectId/render-jobs')
  listForProject(@CurrentUser() user: SessionUser, @Param('projectId', UuidPipe) id: string) {
    return this.render.listForProject(user, id);
  }

  @Get('render-jobs')
  listRecent(@CurrentUser() user: SessionUser) {
    return this.render.listRecent(user);
  }

  @Get('render-jobs/:jobId')
  get(@CurrentUser() user: SessionUser, @Param('jobId', UuidPipe) id: string) {
    return this.render.get(user, id);
  }

  @Post('render-jobs/:jobId/retry')
  @HttpCode(200)
  retry(@CurrentUser() user: SessionUser, @Param('jobId', UuidPipe) id: string) {
    return this.render.retry(user, id);
  }

  @Post('render-jobs/:jobId/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: SessionUser, @Param('jobId', UuidPipe) id: string) {
    return this.render.cancel(user, id);
  }

  /** Server-sent events for render jobs in the user's workspaces. */
  @Get('events/render-jobs')
  @RawResponse()
  sse(@CurrentUser() user: SessionUser, @Req() req: VoxRequest, @Res() res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`retry: 3000\n: connected\n\n`);
    const sub = this.events.stream(user.workspaceIds).subscribe(({ event }) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      sub.unsubscribe();
    });
  }
}
