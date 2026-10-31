export type WorkerLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  fields?: Record<string, unknown>,
) => void;

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** Structured JSON logs with job ids; never includes user text or audio. */
export function createLogger(min: keyof typeof ORDER): WorkerLogger {
  return (level, msg, fields = {}) => {
    if (ORDER[level] < ORDER[min]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: 'worker', msg, ...fields });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
}
