import { spawn } from 'node:child_process';

export class CloneError extends Error {
  constructor(
    public readonly code: string,
    public readonly childExitCode?: number,
  ) {
    super(code);
  }
}
export interface CommandOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}
export type Runner = (
  file: string,
  args: string[],
  options: CommandOptions,
) => Promise<string>;
/** Explicit allowlist: no Oracle, Compose, Node injection, or implicit dotenv settings. */
export function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'DOCKER_CONFIG'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
}
export const runProcess: Runner = async (file, args, options) => {
  if (options.signal?.aborted) throw new CloneError('CLONE_INTERRUPTED');
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      pending = '',
      interrupted = false,
      timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const abort = () => {
      interrupted = true;
      stop();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.min(options.timeoutMs ?? 1_800_000, 2_147_483_647),
    );
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-4_000_000);
    });
    child.stderr.on('data', (chunk) => {
      pending = (pending + chunk).slice(-64_000);
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) options.onLine?.(line);
    });
    child.stdin.on('error', () => {});
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', () => {
      cleanup();
      reject(new CloneError('CLONE_STAGE_FAILED'));
    });
    child.on('close', (code) => {
      cleanup();
      if (interrupted) reject(new CloneError('CLONE_INTERRUPTED'));
      else if (code !== 0 || timedOut)
        reject(new CloneError('CLONE_STAGE_FAILED', code ?? undefined));
      else resolve(stdout);
    });
    child.stdin.end(options.input);
  });
};
