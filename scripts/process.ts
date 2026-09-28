import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export class CloneError extends Error {
  constructor(
    public readonly code: string,
    public readonly childExitCode?: number,
    public readonly sqlDiagnostics?: {
      oracleCodes: string[];
      setupCheckIndex?: number;
    },
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
  onProgressLine?: (record: {
    stream: 'stdout' | 'stderr';
    line: string;
  }) => void;
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
/** Discard a whole oversized record, including tails arriving in later chunks. */
function progressRecords(
  stream: 'stdout' | 'stderr',
  observer: CommandOptions['onProgressLine'],
) {
  const decoder = new StringDecoder('utf8');
  let pending = '',
    discarded = false;
  const emit = () => {
    if (!discarded && pending) {
      try {
        observer?.({ stream, line: pending });
      } catch {
        /* Best effort. */
      }
    }
    pending = '';
    discarded = false;
  };
  const consume = (text: string) => {
    for (const part of text.split(/([\r\n])/)) {
      if (part === '\r' || part === '\n') emit();
      else if (!discarded) {
        if (pending.length + part.length > 64_000) {
          pending = '';
          discarded = true;
        } else pending += part;
      }
    }
  };
  return {
    write: (chunk: Buffer) => consume(decoder.write(chunk)),
    end: () => {
      consume(decoder.end());
      emit();
    },
  };
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
    let settled = false;
    const outRecords = progressRecords('stdout', options.onProgressLine);
    const errRecords = progressRecords('stderr', options.onProgressLine);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      if (options.onProgressLine) outRecords.write(chunk);
      stdout = (stdout + chunk).slice(-4_000_000);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      if (options.onProgressLine) errRecords.write(chunk);
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
      settled = true;
      cleanup();
      reject(new CloneError('CLONE_STAGE_FAILED'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.onProgressLine) {
        outRecords.end();
        errRecords.end();
      }
      if (interrupted) reject(new CloneError('CLONE_INTERRUPTED'));
      else if (code !== 0 || timedOut)
        reject(new CloneError('CLONE_STAGE_FAILED', code ?? undefined));
      else resolve(stdout);
    });
    child.stdin.end(options.input);
  });
};
