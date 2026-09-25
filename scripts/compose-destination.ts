import { join } from 'node:path';
import type { TargetDocument } from '../src/model.js';
import type { LoadedConfig } from './clone-config.js';
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
      '-- Generated from oracle-schema-pipeline format 4. No source DDL was replayed.',
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
function countCheck(from: string, expected: number): string {
  return `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${from}; IF n != ${expected} THEN RAISE_APPLICATION_ERROR(-20001, 'Clone condition failed'); END IF; END;\n/\n`;
}
export function setupChecks(target: TargetDocument): string {
  const owners = [
    ...new Set(
      [...target.tables, ...target.views].map(
        (object) => object.reference.owner,
      ),
    ),
  ];
  return (
    countCheck(
      `dba_tablespaces WHERE tablespace_name=${literal(target.policy.defaultTablespace)} AND status='ONLINE'`,
      1,
    ) +
    countCheck(
      `v$parameter WHERE name='max_string_size' AND upper(value)=${literal(target.policy.maxStringSize)}`,
      1,
    ) +
    owners
      .map((owner) =>
        countCheck(
          `dba_users WHERE username=${literal(owner)}`,
          target.policy.createSchemas ? 0 : 1,
        ),
      )
      .join('') +
    target.policy.externalPrerequisites
      .map((item) =>
        countCheck(
          `dba_objects WHERE owner=${literal(item.reference.owner)} AND object_name=${literal(item.reference.name)} AND object_type=${literal(item.type)} AND status='VALID'`,
          1,
        ),
      )
      .join('')
  );
}
export function verificationChecks(target: TargetDocument): string {
  return [
    ...target.tables.map((object) => ({ ...object.reference, type: 'TABLE' })),
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
    .join('');
}
export interface Destination {
  preflight(): Promise<string>;
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
    private config: LoadedConfig['config']['destination'],
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
  ): Promise<string> {
    const env = args[0] === 'compose' ? this.env : childEnvironment();
    return this.run(
      'docker',
      [...(this.endpoint ? ['--host', this.endpoint] : []), ...args],
      { env, cwd: this.root, signal: this.signal, input, timeoutMs },
    );
  }
  private compose(args: string[], input?: string, timeoutMs?: number) {
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
    );
  }
  async preflight(): Promise<string> {
    try {
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
      await this.docker(['info', '--format', '{{.ID}}']);
      await this.compose(['version']);
      try {
        await this.docker(['image', 'inspect', image]);
      } catch {
        await this.docker(['pull', image], undefined, 1_200_000);
      }
      const images = JSON.parse(await this.docker(['image', 'inspect', image]));
      await this.identity();
      return images[0].Id;
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
    const output = await this.compose(
      ['exec', '-T', service, 'sqlplus', '-s', '/ as sysdba'],
      sqlSession(sql),
    );
    if (/\b(?:ORA-\d{5}|SP2-\d{4})\b/.test(output))
      throw new CloneError('CLONE_STAGE_FAILED');
  }
}
