import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '@voxstudio/core';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppModule } from './app.module';
import { requestContext, type VoxRequest } from './common/http';
import { Logger } from './common/infra';

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  const logger = app.get(Logger);
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((req: VoxRequest, res: Response, next: NextFunction) => requestContext(logger)(req, res, next));
  app.use(cookieParser());
  app.use('/api', express.json({ limit: '2mb' }));
  // Body-parser errors occur before Nest routing, so map them to the API error envelope here.
  app.use(
    '/api',
    (err: { type?: string } | undefined, req: VoxRequest, res: Response, next: NextFunction) => {
      if (!err) return next();
      const tooLarge = err.type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({
        error: {
          code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
          message: tooLarge ? 'Request body is too large.' : 'Malformed JSON body.',
        },
        meta: { requestId: req.requestId },
      });
    },
  );
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.setGlobalPrefix('api/v1');

  // Serve the built web client (single-origin deployment) with SPA fallback.
  const webDist = path.join(config.repoRoot, 'apps', 'web', 'dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    app.use(
      express.static(webDist, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, p) =>
          p.includes(`${path.sep}assets${path.sep}`) &&
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
      }),
    );
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }
  await app.init();
  return app;
}
