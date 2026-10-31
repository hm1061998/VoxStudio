import { spawn } from 'node:child_process';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';

export interface RunOptions {
  /** Hard wall-clock limit; the process is killed when exceeded. */
  timeoutMs: number;
  /** Max bytes kept from stdout/stderr each (excess is dropped, not buffered). */
  maxOutputBytes?: number;
  cwd?: string;
  signal?: AbortSignal;
  stdin?: Buffer;
  /** Environment overrides merged into a minimal environment. */
  env?: Record<string, string>;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  durationMs: number;
}

/**
 * Run a fixed executable with an argument array. Never uses a shell, so user values cannot be
 * interpreted as shell syntax. Output is size-capped and the process is killed on timeout/abort.
 */
export function runProcess(
  executable: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  const maxBytes = opts.maxOutputBytes ?? 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.'));
      return;
    }
    const baseEnv: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) {
      const v = process.env[key];
      if (v !== undefined) baseEnv[key] = v;
    }
    const child = spawn(executable, [...args], {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...baseEnv, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let settled = false;
    let killedReason: 'timeout' | 'abort' | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = (reason: 'timeout' | 'abort') => {
      killedReason = reason;
      child.kill('SIGKILL');
    };
    const onAbort = () => kill('abort');
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes < maxBytes) {
        out.push(chunk.subarray(0, maxBytes - outBytes));
        outBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < maxBytes) err += chunk.toString('utf8').slice(0, maxBytes - err.length);
    });
    child.on('error', (e) =>
      finish(() =>
        reject(
          new VoxError(
            ErrorCodes.ENGINE_UNAVAILABLE,
            `Required tool could not be started (${(e as NodeJS.ErrnoException).code ?? 'error'}).`,
          ),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        if (killedReason === 'timeout')
          reject(new VoxError(ErrorCodes.SYNTHESIS_TIMEOUT, 'Processing exceeded the time limit.'));
        else if (killedReason === 'abort')
          reject(new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.'));
        else
          resolve({
            code: code ?? -1,
            stdout: Buffer.concat(out),
            stderr: err,
            durationMs: Date.now() - started,
          });
      }),
    );
    if (opts.stdin) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Strip anything that looks like a filesystem path from tool diagnostics before logging/storing. */
export function redactToolOutput(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>')
    .replace(/\/(?:[\w.-]+\/)+[\w.-]*/g, '<path>')
    .slice(0, 500);
}
