import { prepareRetryInput, RetryInputError } from './clone-retry-input.js';
import { CloneExtractionProgress, formatPreflight } from './clone-progress.js';
import { mkdir, mkdtemp, open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { writeJson, OutputError } from '../src/files.js';
import { verifyCompletion } from '../src/completion.js';
import { targetDocumentSchema } from '../src/model.js';
import {
  loadCloneConfig,
  loadRetryConfig,
  type LoadedDestinationConfig,
} from './clone-config.js';
import {
  ComposeDestination,
  generatedReplay,
  setupChecks,
  setupRequirements,
  verificationChecks,
  type Destination,
} from './compose-destination.js';
import {
  childEnvironment,
  CloneError,
  runProcess,
  type Runner,
} from './process.js';

export const runResultSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    status: z.enum(['succeeded', 'failed']),
    lastStage: z.string(),
    destinationResetStarted: z.boolean(),
    errorCode: z.string().optional(),
    errorDetail: z.string().optional(),
    oracleErrorCodes: z
      .array(z.string().regex(/^(?:ORA-\d{5}|SP2-\d{4})$/))
      .optional(),
    childExitCode: z.number().int().optional(),
    prerequisite: z
      .object({
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    destinationImageId: z.string().optional(),
  })
  .strict();
export type RunResult = z.infer<typeof runResultSchema>;
export const cloneLockPath = join(
  tmpdir(),
  `oracle-schema-pipeline-local-${process.getuid?.() ?? 'user'}.lock`,
);
export interface WorkflowOptions {
  /** Test seam; the CLI always uses the shared per-user destination lock. */
  lockPath?: string;
  root: string;
  signal?: AbortSignal;
  run?: Runner;
  destination?: (loaded: LoadedDestinationConfig) => Destination;
  log?: (message: string) => void;
}
export function cloneDatabase(options: WorkflowOptions) {
  return runCloneAttempt(options);
}
export function retryCloneDatabase(
  options: WorkflowOptions & { input: string },
) {
  return runCloneAttempt(options, options.input);
}
async function runCloneAttempt(
  options: WorkflowOptions,
  retryInput?: string,
): Promise<{ directory: string; result: RunResult }> {
  const { root, signal } = options;
  const log = options.log ?? console.log;
  const startedAt = new Date().toISOString();
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    join(
      artifacts,
      `db-clone-${retryInput === undefined ? '' : 'retry-'}${startedAt.replaceAll(/[:.]/g, '-')}-`,
    ),
  );
  const tempDir = join(directory, '.staging');
  const lock = options.lockPath ?? cloneLockPath;
  const runId = randomUUID();
  let owned = false;
  let setupDetails: string[] = [];
  const result: RunResult = {
    version: 1,
    runId,
    startedAt,
    finishedAt: startedAt,
    status: 'failed',
    lastStage: 'lock',
    destinationResetStarted: false,
  };
  const checkSignal = () => {
    if (signal?.aborted) throw new CloneError('CLONE_INTERRUPTED');
  };
  const checkLock = async () => {
    if (!owned || (await readFile(lock, 'utf8')) !== runId)
      throw new CloneError('CLONE_ALREADY_RUNNING');
  };
  async function stage<T>(
    name: string,
    code: string,
    action: () => Promise<T>,
  ): Promise<T> {
    checkSignal();
    result.lastStage = name;
    log(`Clone stage: ${name}`);
    try {
      const value = await action();
      checkSignal();
      return value;
    } catch (error) {
      if (
        error instanceof OutputError ||
        (error instanceof CloneError && error.code !== 'CLONE_STAGE_FAILED')
      )
        throw error;
      throw new CloneError(
        code,
        error instanceof CloneError ? error.childExitCode : undefined,
        error instanceof CloneError ? error.sqlDiagnostics : undefined,
      );
    }
  }
  try {
    try {
      const handle = await open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(runId);
        owned = true;
      } finally {
        await handle.close();
      }
    } catch {
      throw new CloneError('CLONE_ALREADY_RUNNING');
    }
    const snapshot =
      retryInput === undefined
        ? undefined
        : await stage('retry-input', 'CLONE_RETRY_INPUT_INVALID', () =>
            prepareRetryInput(retryInput, directory),
          );
    const normalLoaded = snapshot
      ? undefined
      : await stage('config', 'CLONE_CONFIG_INVALID', () =>
          loadCloneConfig(join(root, 'config/local/config.json')),
        );
    const loaded =
      normalLoaded ??
      (await stage('config', 'CLONE_CONFIG_INVALID', () =>
        loadRetryConfig(
          join(root, 'config/local/config.json'),
          snapshot!.target.policy,
        ),
      ));
    const { config, prerequisite } = loaded;
    if (prerequisite)
      result.prerequisite = {
        bytes: prerequisite.byteLength,
        sha256: createHash('sha256').update(prerequisite).digest('hex'),
      };
    const destination =
      options.destination?.(loaded) ??
      new ComposeDestination(root, config.destination, signal, options.run);
    result.destinationImageId = await stage(
      'preflight',
      'CLONE_DOCKER_UNAVAILABLE',
      () => destination.preflight((event) => log(formatPreflight(event))),
    );
    const path = (name: string) => join(directory, name);
    if (normalLoaded) {
      const { config, objects, policy } = normalLoaded;
      await writeJson(join(directory, 'objects.json'), objects, { tempDir });
      await writeJson(join(directory, 'policy.json'), policy, { tempDir });
      const run = options.run ?? runProcess;
      const pipeline = async (
        name: string,
        args: string[],
        extraction = false,
      ) =>
        stage(name, 'CLONE_STAGE_FAILED', async () => {
          let publicationCode: string | undefined;
          try {
            const execute = (onProgressLine?: (line: string) => void) =>
              run(
                process.execPath,
                [
                  '--import',
                  'tsx',
                  join(root, 'src/cli.ts'),
                  name,
                  ...args,
                  '--temp-dir',
                  tempDir,
                ],
                {
                  cwd: root,
                  signal,
                  env: {
                    ...childEnvironment(),
                    ...(extraction
                      ? { ORACLE_PASSWORD: config.source.password }
                      : {}),
                  },
                  onProgressLine: onProgressLine
                    ? ({ stream, line }) => {
                        if (stream === 'stderr') onProgressLine(line);
                      }
                    : undefined,
                  onLine: (line) => {
                    // Retain known publication codes without exposing filenames or raw errors.
                    publicationCode ??=
                      /^(OUTPUT_(?:EXISTS|PATH_CONFLICT|PUBLICATION_UNSUPPORTED|PUBLICATION_FAILED|INCOMPLETE)):/.exec(
                        line,
                      )?.[1];
                  },
                },
              );
            return await (extraction
              ? new CloneExtractionProgress(log).run(execute)
              : execute());
          } catch (error) {
            if (
              publicationCode &&
              error instanceof CloneError &&
              error.code !== 'CLONE_INTERRUPTED'
            )
              throw new CloneError(publicationCode, error.childExitCode);
            throw error;
          }
        });
      const connection = config.source.dsn
        ? ['--dsn', config.source.dsn]
        : [
            '--tnsnames',
            config.source.tnsnames!,
            '--tns-alias',
            config.source.tnsAlias!,
          ];
      await pipeline(
        'extract',
        [
          ...connection,
          '--user',
          config.source.user,
          '--catalog-scope',
          config.source.catalogScope,
          '--objects',
          path('objects.json'),
          '--output',
          path('source.json'),
          '--progress-json',
        ],
        true,
      );
      await pipeline('dictionary', [
        '--input',
        path('source.json'),
        '--output',
        path('data-dictionary.xlsx'),
      ]);
      await pipeline('transform', [
        '--input',
        path('source.json'),
        '--policy',
        path('policy.json'),
        '--output',
        path('target.json'),
        '--report',
        path('report.json'),
      ]);
      await stage('completion', 'CLONE_STAGE_FAILED', () =>
        verifyCompletion(path('target.json.complete.json'), [
          { role: 'target', path: path('target.json') },
          { role: 'report', path: path('report.json') },
        ]),
      );
      await pipeline('validate', ['--input', path('target.json')]);
      await pipeline('generate', [
        '--input',
        path('target.json'),
        '--output',
        path('clone.sql'),
      ]);
    }
    const { sql, target } = await stage(
      'reset-preflight',
      'CLONE_STAGE_FAILED',
      async () => {
        const sql =
          snapshot?.sql ??
          generatedReplay(await readFile(path('clone.sql'), 'utf8'));
        const target =
          snapshot?.target ??
          targetDocumentSchema.parse(
            JSON.parse(await readFile(path('target.json'), 'utf8')),
          );
        await checkLock();
        await destination.identity();
        return { sql, target };
      },
    );
    await stage('reset', 'CLONE_RESET_FAILED', async () => {
      await checkLock();
      checkSignal();
      result.destinationResetStarted = true;
      await destination.reset();
    });
    await stage('startup', 'CLONE_STARTUP_FAILED', () => destination.start());
    if (prerequisite)
      await stage('prerequisite', 'CLONE_PREREQUISITE_FAILED', () =>
        destination.sql(prerequisite.toString('utf8')),
      );
    setupDetails = setupRequirements(target).map((item) => item.detail);
    await stage('setup-verification', 'CLONE_PREREQUISITE_FAILED', () =>
      destination.sql(setupChecks(target)),
    );
    await stage('replay', 'CLONE_REPLAY_FAILED', () => destination.sql(sql));
    await stage('verification', 'CLONE_VERIFICATION_FAILED', () =>
      destination.sql(verificationChecks(target)),
    );
    result.status = 'succeeded';
    log(`Local listener: 127.0.0.1:${config.destination.port}/FREEPDB1`);
  } catch (error) {
    if (error instanceof RetryInputError)
      log(`${error.code}: ${error.guidance}`);
    if (error instanceof OutputError && error.code === 'OUTPUT_INCOMPLETE')
      log(
        'OUTPUT_INCOMPLETE: target/report completion bundle is missing or mismatched; use complete artifacts at their original paths.',
      );
    result.errorCode =
      error instanceof CloneError || error instanceof OutputError
        ? error.code
        : 'CLONE_STAGE_FAILED';
    if (error instanceof CloneError && error.sqlDiagnostics?.oracleCodes.length)
      result.oracleErrorCodes = error.sqlDiagnostics.oracleCodes;
    if (
      result.lastStage === 'setup-verification' &&
      result.errorCode === 'CLONE_PREREQUISITE_FAILED'
    ) {
      const index =
        error instanceof CloneError
          ? error.sqlDiagnostics?.setupCheckIndex
          : undefined;
      result.errorDetail =
        (index === undefined ? undefined : setupDetails[index]) ??
        'Setup verification could not complete. Check destination SQL connectivity and the reported Oracle codes; required tablespace, MAX_STRING_SIZE, schemas, and external prerequisites must match target.json policy in FREEPDB1.';
    } else if (
      result.lastStage === 'prerequisite' &&
      result.errorCode === 'CLONE_PREREQUISITE_FAILED'
    ) {
      result.errorDetail =
        'prerequisiteSql failed before setup verification. Check the reported Oracle codes and correct the prerequisite SQL for FREEPDB1.';
    }
    if (result.errorDetail) log(result.errorDetail);
    if (result.oracleErrorCodes)
      log(`Oracle errors: ${result.oracleErrorCodes.join(', ')}`);
    if (error instanceof CloneError && error.childExitCode !== undefined)
      result.childExitCode = error.childExitCode;
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await writeJson(
        join(directory, 'run-result.json'),
        runResultSchema.parse(result),
        { tempDir },
      );
    } finally {
      if (owned) {
        try {
          await checkLock();
          await unlink(lock);
        } catch {
          /* Never release another invocation's lock. */
        }
      }
    }
  }
  log(`Artifacts: ${directory}`);
  if (result.status === 'failed')
    log(
      `${result.errorCode}; ${result.destinationResetStarted ? 'destination reset began; the new database may be incomplete' : 'destination was not reset'}.`,
    );
  return { directory, result };
}
