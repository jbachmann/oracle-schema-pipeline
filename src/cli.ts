import { readFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sourceDocumentSchema, targetDocumentSchema, tableListSchema, policySchema } from './model.js';
import { transformSource, transformationReport } from './transform.js';
import { validateTarget } from './validate.js';
import { generateSql } from './generate.js';
import { writeJson, writeNewFile } from './files.js';

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }
function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing --${name}. See --help.`);
  return value;
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, dsn: { type: 'string' }, user: { type: 'string' },
    tables: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
    policy: { type: 'string' }, report: { type: 'string' },
  } });
  if (values.help || !positionals.length) {
    console.log(`Oracle schema pipeline (Node.js 22+)
  npm run schema -- extract --dsn host:1521/PDB --user EXPORT_READER --tables tables.json --output source.json
  npm run schema -- transform --input source.json --policy policy.json --output target.json
  npm run schema -- validate --input target.json [--report validation.json]
  npm run schema -- generate --input target.json --output clone.sql

Only extract connects to Oracle. Password: hidden prompt or ORACLE_PASSWORD.
Transform also writes <output>.report.json unless --report is supplied.
Validation errors use exit code 2; unsupported models never produce SQL.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Supply exactly one command.');
  const command = positionals[0];
  if (!['extract', 'transform', 'validate', 'generate'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command !== 'validate') {
    const output = requireOption(values.output, 'output');
    try { await access(output); throw new Error(`Output exists: ${output}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (command === 'extract') {
    const requestedTables = tableListSchema.parse(await readJson(requireOption(values.tables, 'tables')));
    // Driver and catalog are loaded only for extraction. Offline stages do not
    // establish a connection or require Oracle credentials or client libraries.
    const [{ default: oracle }, { OracleCatalog }, { extractSource }, { readPassword }] = await Promise.all([
      import('oracledb'), import('./catalog.js'), import('./extract.js'), import('./password.js'),
    ]);
    const connection = await oracle.getConnection({
      user: requireOption(values.user, 'user'), connectString: requireOption(values.dsn, 'dsn'), password: await readPassword(),
    });
    try {
      connection.callTimeout = 300_000;
      const source = await extractSource(new OracleCatalog(connection), requestedTables);
      await writeJson(values.output!, source);
      console.log(`Extracted ${source.tables.length} table definitions to ${values.output}.`);
    } finally { await connection.close(); }
  } else if (command === 'transform') {
    const source = sourceDocumentSchema.parse(await readJson(requireOption(values.input, 'input')));
    const policy = policySchema.parse(values.policy ? await readJson(values.policy) : {});
    const target = transformSource(source, policy);
    const report = transformationReport(target);
    await writeJson(values.output!, target);
    await writeJson(values.report ?? `${values.output}.report.json`, report);
    const errors = report.filter(item => item.severity === 'error');
    console.log(`Wrote target model and change/validation report; ${errors.length} blocking errors.`);
    if (errors.length) process.exitCode = 2;
  } else {
    const target = targetDocumentSchema.parse(await readJson(requireOption(values.input, 'input')));
    if (command === 'validate') {
      const diagnostics = validateTarget(target);
      if (values.report) await writeJson(values.report, diagnostics);
      console.log(JSON.stringify(diagnostics, null, 2));
      if (diagnostics.some(item => item.severity === 'error')) process.exitCode = 2;
    } else {
      const sql = generateSql(target); // Validates again; skipping validate is safe.
      await writeNewFile(values.output!, sql);
      console.log(`Wrote ${values.output}.`);
    }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
