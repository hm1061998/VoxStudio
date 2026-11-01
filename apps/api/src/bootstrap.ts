import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '@voxstudio/core';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync, readFileSync } from 'node:fs';
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
  // Only the configured proxies may set X-Forwarded-For (see TRUST_PROXY); rate limits and lockouts key on req.ip.
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
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
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });
  app.use((req: VoxRequest, res: Response, next: NextFunction) => requestContext(logger)(req, res, next));
  // API answers are private and never cached by browsers or proxies (individual routes may override).
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  // Defence in depth against cross-site requests: a state-changing call that names a foreign Origin is refused
  // before any handler runs (the CSRF token and SameSite=Strict cookies are the primary defences).
  const allowedOrigins = new Set([
    ...config.corsOrigins,
    ...(() => {
      try {
        return [new URL(config.publicBaseUrl).origin];
      } catch {
        return [];
      }
    })(),
  ]);
  app.use('/api', (req: VoxRequest, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !allowedOrigins.has(origin))
      return void res.status(403).json({
        error: { code: 'CSRF_INVALID', message: 'Cross-site request refused.' },
        meta: { requestId: req.requestId },
      });
    next();
  });
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
    // Search-engine files are generated from PUBLIC_BASE_URL so canonical and sitemap addresses are absolute.
    const base = config.publicBaseUrl.replace(/\/+$/, '');
    const indexHtml = readFileSync(path.join(webDist, 'index.html'), 'utf8').replaceAll(
      '__PUBLIC_BASE_URL__',
      base,
    );
    const robots = [
      'User-agent: *',
      'Allow: /$',
      'Allow: /login',
      ...(config.allowRegistration ? ['Allow: /register'] : []),
      'Disallow: /api/',
      'Disallow: /admin',
      'Disallow: /projects',
      'Disallow: /voices',
      'Disallow: /presets',
      'Disallow: /pronunciation',
      'Disallow: /renders',
      'Disallow: /settings',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n');
    const sitemap = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...['/login', ...(config.allowRegistration ? ['/register'] : [])].map(
        (p) => `  <url><loc>${base}${p}</loc></url>`,
      ),
      '</urlset>',
      '',
    ].join('\n');
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET') return next();
      if (req.path === '/robots.txt') return void res.type('text/plain').send(robots);
      if (req.path === '/sitemap.xml') return void res.type('application/xml').send(sitemap);
      if (req.path === '/' || req.path === '/index.html') return void res.type('html').send(indexHtml);
      return next();
    });
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
      res.type('html').send(indexHtml);
    });
  }
  await app.init();
  return app;
}
