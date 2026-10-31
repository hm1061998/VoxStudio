import {
  ArgumentsHost,
  BadRequestException,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  PipeTransform,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { ErrorCodes, VoxError, type ErrorCode } from '@voxstudio/contracts';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { map, type Observable } from 'rxjs';
import { ZodError, type ZodType } from 'zod';
import { Logger } from './infra';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  sessionId: string;
  csrfToken: string;
  workspaceIds: string[];
}

export interface VoxRequest extends Request {
  requestId: string;
  user?: SessionUser;
}

export const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  EMPTY_TEXT: 400,
  UNIT_MISSING: 422,
  UNRESOLVED_TOKENS: 422,
  NOTHING_TO_RENDER: 400,
  PARAMETER_UNSUPPORTED: 400,
  PARAMETER_OUT_OF_RANGE: 400,
  VOICE_LOCALE_UNSUPPORTED: 400,
  VOICE_NOT_AVAILABLE: 400,
  OUTPUT_FORMAT_UNSUPPORTED: 400,
  PRONUNCIATION_INVALID: 400,
  ENGINE_DISABLED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  NOT_FOUND: 404,
  ASSET_MISSING: 404,
  EMAIL_TAKEN: 409,
  REVISION_CONFLICT: 409,
  JOB_NOT_RETRYABLE: 409,
  JOB_NOT_CANCELLABLE: 409,
  PAYLOAD_TOO_LARGE: 413,
  TEXT_TOO_LONG: 413,
  RATE_LIMITED: 429,
  QUEUE_FULL: 429,
  QUOTA_EXCEEDED: 402,
  PASSWORD_REJECTED: 400,
  ENGINE_BUSY: 503,
  ENGINE_UNAVAILABLE: 503,
};

export const notFound = (what = 'Resource'): VoxError =>
  new VoxError(ErrorCodes.NOT_FOUND, `${what} not found.`);

/** Assigns a request id and emits one structured access-log line per request (no bodies). */
export function requestContext(logger: Logger) {
  return (req: VoxRequest, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/health')) return;
      logger.info('http', {
        requestId: req.requestId,
        method: req.method,
        path: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path.replace(/[0-9a-f-]{36}/g, ':id'),
        status: res.statusCode,
        ms: Date.now() - started,
        userId: req.user?.id,
      });
    });
    next();
  };
}

export const RAW_RESPONSE = 'vox:raw';
/** Skip the `{ data, meta }` envelope (downloads, SSE). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [ctx.getHandler(), ctx.getClass()]);
    if (raw) return next.handle();
    const req = ctx.switchToHttp().getRequest<VoxRequest>();
    return next
      .handle()
      .pipe(map((data: unknown) => ({ data: data ?? null, meta: { requestId: req.requestId } })));
  }
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<VoxRequest>();
    let status = 500;
    let code: ErrorCode = ErrorCodes.INTERNAL_ERROR;
    let message = 'An unexpected error occurred. Please retry; if it persists, contact the operator.';
    let details: Record<string, unknown> | undefined;
    if (exception instanceof VoxError) {
      code = exception.code;
      status = STATUS_BY_CODE[code] ?? 500;
      message = exception.message;
      details = exception.details && { ...exception.details };
      if (details) delete details.tool;
    } else if (exception instanceof ZodError) {
      status = 400;
      code = ErrorCodes.VALIDATION_FAILED;
      message = 'Request validation failed.';
      details = { issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      code = ErrorCodes.RATE_LIMITED;
      message = 'Too many requests. Please wait a moment and try again.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      if (status === 413) {
        code = ErrorCodes.PAYLOAD_TOO_LARGE;
        message = 'Request body is too large.';
      } else if (status === 404) {
        code = ErrorCodes.NOT_FOUND;
        message = 'Not found.';
      } else if (status === 400) {
        code = ErrorCodes.VALIDATION_FAILED;
        message = 'Malformed request.';
      } else if (status < 500) {
        code = ErrorCodes.VALIDATION_FAILED;
        message = exception.message;
      }
    } else if ((exception as { type?: string })?.type === 'entity.too.large') {
      status = 413;
      code = ErrorCodes.PAYLOAD_TOO_LARGE;
      message = 'Request body is too large.';
    }
    if (status >= 500)
      this.logger.error('request failed', {
        requestId: req.requestId,
        code,
        err:
          exception instanceof Error
            ? { name: exception.name, message: exception.message.slice(0, 300) }
            : String(exception),
      });
    if (res.headersSent) return;
    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      meta: { requestId: req.requestId },
    });
  }
}

/** Validates and returns parsed data. Unknown keys are rejected by strict schemas. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw r.error;
    return r.data;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Route ids that are not UUIDs can never exist; answer 404 without touching the DB. */
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID_RE.test(value)) throw notFound();
    return value.toLowerCase();
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  const req = ctx.switchToHttp().getRequest<VoxRequest>();
  if (!req.user) throw new VoxError(ErrorCodes.UNAUTHENTICATED, 'Sign in required.');
  return req.user;
});

export { BadRequestException };
