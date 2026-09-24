import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import oracle from 'oracledb';

const schemas = ['IAM', 'CATALOG', 'COMMERCE', 'FINANCE'];
const selectedViews = [{ owner: 'FINANCE', name: 'OPEN_ORDER_FINANCE' }, { owner: 'CATALOG', name: 'Product Availability' }];
const password = process.env.ORACLE_PWD ?? 'OracleDev123';

async function command(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) :
      reject(new Error(`${file} ${args.join(' ')} exited ${code}`)));
    child.stdin.end(options.input);
  });
}

async function compose(args: string[], input?: string) {
  return await command('docker', ['compose', ...args], { input });
}

async function publishedDsn(service: string): Promise<string> {
  const { stdout } = await command('docker', ['compose', 'port', service, '1521']);
  const port = /:(\d+)\s*$/.exec(stdout)?.[1];
  if (!port) throw new Error(`Cannot determine ${service} listener port from: ${stdout}`);
  return `127.0.0.1:${port}/FREEPDB1`;
}

async function applicationTables(dsn: string): Promise<Array<{ owner: string; name: string }>> {
  const connection = await oracle.getConnection({ user: 'SYSTEM', password, connectString: dsn });
  try {
    const result = await connection.execute<{ OWNER: string; TABLE_NAME: string }>(`
      SELECT owner, table_name FROM dba_tables
       WHERE owner IN (${schemas.map((_, index) => `:s${index}`).join(',')})
       ORDER BY owner, table_name`, Object.fromEntries(schemas.map((schema, index) => [`s${index}`, schema])),
      { outFormat: oracle.OUT_FORMAT_OBJECT });
    return (result.rows ?? []).map(row => ({ owner: row.OWNER, name: row.TABLE_NAME }));
  } finally { await connection.close(); }
}

async function destinationSchemaCount(dsn: string): Promise<number> {
  const connection = await oracle.getConnection({ user: 'SYSTEM', password, connectString: dsn });
  try {
    const result = await connection.execute<{ SCHEMA_COUNT: number }>(`
      SELECT COUNT(*) AS schema_count FROM dba_users
       WHERE username IN (${schemas.map((_, index) => `:s${index}`).join(',')})`,
      Object.fromEntries(schemas.map((schema, index) => [`s${index}`, schema])),
      { outFormat: oracle.OUT_FORMAT_OBJECT });
    return result.rows?.[0]?.SCHEMA_COUNT ?? 0;
  } finally { await connection.close(); }
}

async function pipeline(args: string[]): Promise<void> {
  await command(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    env: { ...process.env, ORACLE_PASSWORD: password },
  });
}

async function main(): Promise<void> {
  console.log('Starting Oracle source and destination...');
  await compose(['up', '-d', '--wait']);

  const sourceDsn = process.env.ORACLE_SOURCE_DSN ?? await publishedDsn('oracle-source');
  const destinationDsn = process.env.ORACLE_DESTINATION_DSN ?? await publishedDsn('oracle-destination');
  const existingSchemas = await destinationSchemaCount(destinationDsn);
  if (existingSchemas !== 0) {
    throw new Error(`Destination contains ${existingSchemas} managed schema(s). Refusing to overwrite or drop them.`);
  }

  const tables = await applicationTables(sourceDsn);
  if (tables.length !== 98) throw new Error(`Expected 98 seeded source tables; found ${tables.length}.`);

  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const directory = join('artifacts', `db-clone-${timestamp}`);
  await mkdir(directory, { recursive: true });
  const objectFile = join(directory, 'objects.json');
  const sourceFile = join(directory, 'source.json');
  const targetFile = join(directory, 'target.json');
  const reportFile = join(directory, 'report.json');
  const sqlFile = join(directory, 'clone.sql');
  await writeFile(objectFile, JSON.stringify({ version: 2, tables, views: selectedViews }, null, 2) + '\n');

  console.log(`Writing pipeline artifacts to ${directory}`);
  await pipeline(['extract', '--dsn', sourceDsn, '--user', 'SYSTEM', '--objects', objectFile, '--output', sourceFile]);
  await pipeline(['transform', '--input', sourceFile, '--output', targetFile, '--report', reportFile]);
  await pipeline(['validate', '--input', targetFile]);
  await pipeline(['generate', '--input', targetFile, '--output', sqlFile]);

  const generatedSql = await readFile(sqlFile, 'utf8');
  const replay = `WHENEVER SQLERROR EXIT SQL.SQLCODE\nWHENEVER OSERROR EXIT FAILURE\nALTER SESSION SET CONTAINER=FREEPDB1;\n${generatedSql}\nEXIT SUCCESS\n`;
  console.log('Loading generated SQL into destination...');
  await compose(['exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/ as sysdba'], replay);
  console.log(`Clone complete. Containers remain running. Artifacts: ${directory}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
