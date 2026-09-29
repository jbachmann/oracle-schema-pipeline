import { isIncluded } from '../src/dependencies.js';
import { catalogUnitType } from '../src/program-sql.js';
import { schemaOwners } from '../src/schema-owners.js';
import { indexRequirements } from '../src/index-grants.js';
import { join } from 'node:path';
import { PreflightProgress, type PreflightObserver } from './clone-progress.js';
import type { CommandOptions } from './process.js';
import type { TargetDocument } from '../src/model.js';
import type { DestinationSettings } from './clone-config.js';
import {
  childEnvironment,
  CloneError,
  runProcess,
  type Runner,
} from './process.js';

export const project = 'oracle-schema-pipeline-local';
export const service = 'oracle-destination';
export const volume = `${project}_oracle-destination-data`;
export const image =
  'container-registry.oracle.com/database/free@sha256:f988b0c04c4c386cd306a2a914c0d7a9702d83acc31b064a28ad8eb6278a8fba';
export function assertLocalEndpoint(endpoint: string): void {
  if (!/^unix:\/\/\//.test(endpoint) && !/^npipe:\/\//.test(endpoint))
    throw new CloneError('CLONE_DESTINATION_MISMATCH');
}
/** Adapt only the exact generated client preamble; source SQL remains opaque. */
export function generatedReplay(sql: string): string {
  const prefix =
    [
      '-- Generated from oracle-schema-pipeline format 6. Includes metadata-derived program DDL.',
      'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
      'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
      'SET DEFINE OFF',
      'SET SQLBLANKLINES ON',
      'SET ECHO ON',
    ].join('\n\n') + '\n\n';
  if (!sql.startsWith(prefix)) throw new CloneError('CLONE_STAGE_FAILED');
  return 'SET SQLBLANKLINES ON\n' + sql.slice(prefix.length);
}
export function sqlSession(sql: string): string {
  return `WHENEVER SQLERROR EXIT 1 ROLLBACK\nWHENEVER OSERROR EXIT 1 ROLLBACK\nSET DEFINE OFF ECHO OFF VERIFY OFF HEADING OFF FEEDBACK OFF PAGESIZE 0 SQLBLANKLINES ON\nALTER SESSION SET CONTAINER=FREEPDB1;\n${sql}\nEXIT SUCCESS\n`;
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function countCheck(
  from: string,
  expected: number,
  message = 'Clone condition failed',
): string {
  return `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${from}; IF n != ${expected} THEN RAISE_APPLICATION_ERROR(-20001, ${literal(message)}); END IF; END;\n/\n`;
}
/** Messages come from the target contract, never from SQL client output. */
export function setupRequirements(target: TargetDocument) {
  const label = (value: string) => JSON.stringify(value);
  return [
    {
      from: `dba_tablespaces WHERE tablespace_name=${literal(target.policy.defaultTablespace)} AND status='ONLINE'`,
      expected: 1,
      detail: `Tablespace ${label(target.policy.defaultTablespace)} is missing or not ONLINE. Create or bring it online in FREEPDB1 using prerequisiteSql, or change defaultTablespace.`,
    },
    {
      from: `v$parameter WHERE name='max_string_size' AND upper(value)=${literal(target.policy.maxStringSize)}`,
      expected: 1,
      detail: `MAX_STRING_SIZE does not match ${label(target.policy.maxStringSize)}. Set the policy maxStringSize to match the destination, or configure the destination before replay.`,
    },
    ...(target.policy.createSchemas ? [] : schemaOwners(target)).map(
      (owner) => ({
        from: `dba_users WHERE username=${literal(owner)}`,
        expected: 1,
        detail: `Schema ${label(owner)} is missing, but createSchemas=false requires it to exist. Create it in FREEPDB1 using prerequisiteSql.`,
      }),
    ),
    ...target.policy.externalPrerequisites
      .filter((item) => !isIncluded(target, item))
      .map((item) => ({
        from: `dba_objects WHERE owner=${literal(item.reference.owner)} AND object_name=${literal(item.reference.name)} AND object_type=${literal(item.type)} AND status='VALID'`,
        expected: 1,
        detail: `External prerequisite ${item.type} ${label(item.reference.owner)}.${label(item.reference.name)} is missing or not VALID. Create or repair it in FREEPDB1 using prerequisiteSql.`,
      })),
  ];
}
export function setupChecks(target: TargetDocument): string {
  return setupRequirements(target)
    .map((item, index) =>
      countCheck(item.from, item.expected, `OSP_SETUP_CHECK_${index}`),
    )
    .join('');
}
export function verificationChecks(target: TargetDocument): string {
  return (
    [
      ...target.tables.map((object) => ({
        ...object.reference,
        type: 'TABLE',
      })),
      ...target.sequences.map((object) => ({
        ...object.reference,
        type: 'SEQUENCE',
      })),
      ...target.programs.flatMap((object) =>
        object.units.map((unit) => ({
          ...object.reference,
          type: catalogUnitType(unit.type),
        })),
      ),
      ...target.views.map((object) => ({ ...object.reference, type: 'VIEW' })),
      ...target.tables.flatMap((table) =>
        table.indexes.map((index) => ({ ...index.reference, type: 'INDEX' })),
      ),
    ]
      .map((object) =>
        countCheck(
          `dba_objects WHERE owner=${literal(object.owner)} AND object_name=${literal(object.name)} AND object_type=${literal(object.type)} AND status='VALID'`,
          1,
        ),
      )
      .join('') +
    target.programs
      .filter((program) => program.kind === 'PACKAGE')
      .map((program) =>
        countCheck(
          `dba_objects WHERE owner=${literal(program.reference.owner)} AND object_name=${literal(program.reference.name)} AND object_type='PACKAGE BODY'`,
          program.units.some((unit) => unit.type === 'PACKAGE_BODY') ? 1 : 0,
        ),
      )
      .join('') +
    target.tables
      .flatMap((table) => [
        ...table.indexes.map((index) =>
          countCheck(
            `dba_indexes WHERE owner=${literal(index.reference.owner)} AND index_name=${literal(index.reference.name)} AND table_owner=${literal(table.reference.owner)} AND table_name=${literal(table.reference.name)} AND status='VALID'`,
            1,
          ),
        ),
        ...table.constraints.flatMap((constraint) =>
          (constraint.kind === 'primary-key' || constraint.kind === 'unique') &&
          constraint.backingIndex
            ? [
                countCheck(
                  `dba_constraints WHERE owner=${literal(table.reference.owner)} AND table_name=${literal(table.reference.name)} AND constraint_name=${literal(constraint.name)} AND index_owner=${literal(constraint.backingIndex.owner)} AND index_name=${literal(constraint.backingIndex.name)}`,
                  1,
                ),
              ]
            : [],
        ),
      ])
      .join('') +
    indexRequirements(target)
      .grants.map((grant) =>
        countCheck(
          `dual WHERE EXISTS (SELECT 1 FROM dba_tab_privs WHERE owner=${literal(grant.reference.owner)} AND table_name=${literal(grant.reference.name)} AND grantee=${literal(grant.grantee)} AND privilege=${literal(grant.privilege)})`,
          1,
        ),
      )
      .join('')
  );
}
export interface Destination {
  preflight(observer?: PreflightObserver): Promise<string>;
  identity(): Promise<void>;
  reset(): Promise<void>;
  start(): Promise<void>;
  sql(sql: string): Promise<void>;
}
export class ComposeDestination implements Destination {
  private endpoint = '';
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    private root: string,
    private config: DestinationSettings,
    private signal?: AbortSignal,
    private run: Runner = runProcess,
  ) {
    this.env = {
      ...childEnvironment(),
      COMPOSE_DISABLE_ENV_FILE: '1',
      CLONE_DESTINATION_PASSWORD: config.password,
      CLONE_DESTINATION_PORT: String(config.port),
    };
  }
  private async docker(
    args: string[],
    input?: string,
    timeoutMs = 120_000,
    onProgressLine?: CommandOptions['onProgressLine'],
  ): Promise<string> {
    const env = args[0] === 'compose' ? this.env : childEnvironment();
    return this.run(
      'docker',
      [...(this.endpoint ? ['--host', this.endpoint] : []), ...args],
      {
        env,
        cwd: this.root,
        signal: this.signal,
        input,
        timeoutMs,
        onProgressLine,
      },
    );
  }
  private compose(
    args: string[],
    input?: string,
    timeoutMs?: number,
    onProgressLine?: CommandOptions['onProgressLine'],
  ) {
    return this.docker(
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-p',
        project,
        '-f',
        join(this.root, 'docker-compose.yml'),
        ...args,
      ],
      input,
      timeoutMs,
      onProgressLine,
    );
  }
  async preflight(observer?: PreflightObserver): Promise<string> {
    const progress = new PreflightProgress(observer);
    try {
      await progress.operation('endpoint', async () => {
        if (process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT)
          this.endpoint = process.env.DOCKER_HOST;
        else {
          const args = [
            'context',
            'inspect',
            ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []),
          ];
          const contexts = JSON.parse(await this.docker(args));
          this.endpoint = contexts[0].Endpoints.docker.Host;
        }
        assertLocalEndpoint(this.endpoint);
      });
      await progress.operation('daemon', () =>
        this.docker(['info', '--format', '{{.ID}}']),
      );
      await progress.operation('compose', () => this.compose(['version']));
      const imageId = await progress.operation('image', async () => {
        try {
          await this.docker(['image', 'inspect', image]);
        } catch (error) {
          if (error instanceof CloneError && error.code === 'CLONE_INTERRUPTED')
            throw error;
          await progress.pull((onLine) =>
            this.docker(['pull', image], undefined, 1_200_000, ({ line }) =>
              onLine(line),
            ),
          );
        }
        const images = JSON.parse(
          await this.docker(['image', 'inspect', image]),
        );
        return images[0].Id as string;
      });
      await progress.operation('identity', () => this.identity());
      return imageId;
    } catch (error) {
      if (
        error instanceof CloneError &&
        ['CLONE_DESTINATION_MISMATCH', 'CLONE_INTERRUPTED'].includes(error.code)
      )
        throw error;
      throw new CloneError('CLONE_DOCKER_UNAVAILABLE');
    }
  }
  async identity(): Promise<void> {
    const ids = (
      await this.docker([
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const named = (
      await this.docker([
        'ps',
        '-aq',
        '--filter',
        `name=^/${project}-${service}-1$`,
      ])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const all = [...new Set([...ids, ...named])];
    if (all.length > 1) throw new CloneError('CLONE_DESTINATION_MISMATCH');
    for (const id of all) {
      const [container] = JSON.parse(await this.docker(['inspect', id]));
      const labels = container.Config.Labels;
      if (
        labels?.['com.docker.compose.project'] !== project ||
        labels?.['com.docker.compose.service'] !== service ||
        container.Name !== `/${project}-${service}-1` ||
        container.Mounts.length !== 1 ||
        container.Mounts[0].Type !== 'volume' ||
        container.Mounts[0].Name !== volume ||
        container.Mounts[0].Destination !== '/opt/oracle/oradata'
      )
        throw new CloneError('CLONE_DESTINATION_MISMATCH');
    }
    const consumers = (
      await this.docker(['ps', '-aq', '--filter', `volume=${volume}`])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (consumers.some((id) => !all.includes(id)))
      throw new CloneError('CLONE_DESTINATION_MISMATCH');
    const volumes = (await this.docker(['volume', 'ls', '-q']))
      .trim()
      .split(/\s+/);
    if (volumes.includes(volume)) {
      const [resource] = JSON.parse(
        await this.docker(['volume', 'inspect', volume]),
      );
      if (
        resource.Labels?.['com.docker.compose.project'] !== project ||
        resource.Labels?.['com.docker.compose.volume'] !==
          'oracle-destination-data'
      )
        throw new CloneError('CLONE_DESTINATION_MISMATCH');
    }
    const networks = (
      await this.docker(['network', 'ls', '--format', '{{.Name}}'])
    )
      .trim()
      .split(/\s+/);
    if (networks.includes(`${project}_default`)) {
      const [network] = JSON.parse(
        await this.docker(['network', 'inspect', `${project}_default`]),
      );
      if (
        network.Labels?.['com.docker.compose.project'] !== project ||
        network.Labels?.['com.docker.compose.network'] !== 'default'
      )
        throw new CloneError('CLONE_DESTINATION_MISMATCH');
    }
  }
  async reset(): Promise<void> {
    await this.compose(['down', '--volumes']);
    if (
      (await this.docker(['volume', 'ls', '-q']))
        .trim()
        .split(/\s+/)
        .includes(volume)
    )
      throw new CloneError('CLONE_RESET_FAILED');
  }
  async start(): Promise<void> {
    await this.compose(
      [
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        String(this.config.startupTimeoutSeconds),
        '--pull',
        'never',
      ],
      undefined,
      (this.config.startupTimeoutSeconds + 30) * 1000,
    );
    await this.identity();
    await this.sql(
      countCheck("v$pdbs WHERE name='FREEPDB1' AND open_mode='READ WRITE'", 1),
    );
  }
  async sql(sql: string): Promise<void> {
    const diagnostics: { oracleCodes: string[]; setupCheckIndex?: number } = {
      oracleCodes: [],
    };
    const inspect = (line: string) => {
      for (const code of line.match(/\b(?:ORA-\d{5}|SP2-\d{4})\b/g) ?? []) {
        if (
          !diagnostics.oracleCodes.includes(code) &&
          diagnostics.oracleCodes.length < 20
        )
          diagnostics.oracleCodes.push(code);
      }
      const check = /^ORA-20001: OSP_SETUP_CHECK_(\d+)\s*$/.exec(line.trim());
      if (check && diagnostics.setupCheckIndex === undefined)
        diagnostics.setupCheckIndex = Number(check[1]);
    };
    try {
      const output = await this.compose(
        [
          'exec',
          '-T',
          '-e',
          'NLS_LANG=.AL32UTF8',
          service,
          'sqlplus',
          '-s',
          '/ as sysdba',
        ],
        sqlSession(sql),
        undefined,
        ({ line }) => inspect(line),
      );
      output.split(/\r?\n/).forEach(inspect);
      if (diagnostics.oracleCodes.length)
        throw new CloneError('CLONE_STAGE_FAILED');
    } catch (error) {
      if (error instanceof CloneError && error.code === 'CLONE_STAGE_FAILED')
        throw new CloneError(error.code, error.childExitCode, diagnostics);
      throw error;
    }
  }
}
