import type { ApiErrorBody, ErrorCode, SettingKey } from '@voxstudio/contracts';
import { hasKey, settingLabel, translate } from '../i18n';

/** User-facing message in the UI language, built from the stable error code (server text as fallback). */
export function localizedError(
  code: string,
  serverMessage: string,
  details?: Record<string, unknown>,
): string {
  let msg = hasKey(`error.${code}`) ? translate(`error.${code}`) : serverMessage;
  if (details?.parameter && (code === 'PARAMETER_OUT_OF_RANGE' || code === 'PARAMETER_UNSUPPORTED')) {
    const label = settingLabel(details.parameter as SettingKey);
    msg +=
      details.min !== undefined
        ? ` (${label}: ${String(details.min)}–${String(details.max)})`
        : ` (${label})`;
  }
  if (typeof details?.position === 'number')
    msg = translate('error.paragraph', { n: details.position + 1, msg });
  return msg;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let csrfToken = '';
export function setCsrfToken(t: string): void {
  csrfToken = t;
}

const BASE = '/api/v1';

/** Fetch wrapper: cookie session, CSRF header on mutations, `{ data }` envelope, typed errors. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', localizedError('NETWORK_ERROR', 'Network error'));
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { data?: T } & Partial<ApiErrorBody>) : {};
  if (!res.ok) {
    const err = json.error;
    const code = err?.code ?? 'INTERNAL_ERROR';
    throw new ApiError(
      res.status,
      code,
      localizedError(code, err?.message ?? `HTTP ${res.status}`, err?.details),
      err?.details,
    );
  }
  return json.data as T;
}

export const assetUrl = (id: string, kind: 'stream' | 'download' = 'stream') =>
  `${BASE}/assets/${id}/${kind}`;

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = (e.details?.issues as { path: string; message: string }[] | undefined) ?? [];
    // Field-level validation details are technical; show them compactly after the translated summary.
    return issues.length ? `${e.message} (${issues.map((i) => i.path).join(', ')})` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
