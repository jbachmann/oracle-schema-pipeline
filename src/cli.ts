import { readFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  sourceDocumentSchema,
  targetDocumentSchema,
  selectionSchema,
  policySchema,
} from './model.js';
import { transformSource, transformationReport } from './transform.js';
import { validateTarget } from './validate.js';
import { generateSql } from './generate.js';
import { writeJson, writeNewBuffer, writeNewFile } from './files.js';
import { resolveConnectionOptions } from './connection.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing --${name}. See --help.`);
  return value;
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      dsn: { type: 'string' },
      user: { type: 'string' },
      tnsnames: { type: 'string' },
      'tns-alias': { type: 'string' },
      'catalog-scope': { type: 'string' },
      objects: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      policy: { type: 'string' },
      report: { type: 'string' },
    },
  });
  if (values.help || !positionals.length) {
    console.log(`Oracle schema pipeline (Node.js 22+)
  npm run schema -- extract --dsn host:1521/PDB --user EXPORT_READER --objects objects.json --output source.json
  npm run schema -- extract --dsn '(DESCRIPTION=...)' --catalog-scope dba --user ADMIN --objects objects.json --output source.json
  npm run schema -- extract --tnsnames /etc/oracle/tnsnames.ora --tns-alias SALES --user EXPORT_READER --objects objects.json --output source.json
  npm run schema -- transform --input source.json --policy policy.json --output target.json
  npm run schema -- validate --input target.json [--report validation.json]
  npm run schema -- generate --input target.json --output clone.sql
  npm run schema -- dictionary --input source.json --output dictionary.xlsx

Only extract connects to Oracle. Catalog scope: all (default) or dba.
Connection arguments may be visible to local processes; never include passwords.
Password: hidden prompt or ORACLE_PASSWORD.
Transform also writes <output>.report.json unless --report is supplied.
Validation errors use exit code 2; unsupported models never produce SQL.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Supply exactly one command.');
  const command = positionals[0];
  if (
    !['extract', 'transform', 'validate', 'generate', 'dictionary'].includes(
      command,
    )
  )
    throw new Error(`Unknown command: ${command}`);
  if (command !== 'validate') {
    const output = requireOption(values.output, 'output');
    try {
      await access(output);
      throw new Error(`Output exists: ${output}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (command === 'extract') {
    const scope = values['catalog-scope'] ?? 'all';
    if (scope !== 'all' && scope !== 'dba')
      throw new Error('--catalog-scope must be all or dba.');
    const { default: oracle } = await import('oracledb');
    const resolvedConnection = await resolveConnectionOptions(
      {
        dsn: values.dsn,
        tnsnames: values.tnsnames,
        tnsAlias: values['tns-alias'],
      },
      (configDir) => oracle.getNetworkServiceNames(configDir),
    );
    const selection = selectionSchema.parse(
      await readJson(requireOption(values.objects, 'objects')),
    );
    // Driver and catalog are loaded only for extraction. Offline stages do not
    // establish a connection or require Oracle credentials or client libraries.
    const [{ OracleCatalog }, { extractSource }, { readPassword }] =
      await Promise.all([
        import('./catalog.js'),
        import('./extract.js'),
        import('./password.js'),
      ]);
    const connection = await oracle.getConnection({
      user: requireOption(values.user, 'user'),
      ...resolvedConnection,
      password: await readPassword(),
    });
    try {
      connection.callTimeout = 300_000;
      const source = await extractSource(
        new OracleCatalog(connection, scope),
        selection,
      );
      await writeJson(values.output!, source);
      console.log(
        `Extracted ${source.tables.length} table definitions to ${values.output}.`,
      );
    } finally {
      await connection.close();
    }
  } else if (command === 'dictionary') {
    const source = sourceDocumentSchema.parse(
      await readJson(requireOption(values.input, 'input')),
    );
    const { createDictionaryBuffer } = await import('./dictionary.js');
    await writeNewBuffer(values.output!, await createDictionaryBuffer(source));
    console.log(`Wrote ${values.output}.`);
  } else if (command === 'transform') {
    const source = sourceDocumentSchema.parse(
      await readJson(requireOption(values.input, 'input')),
    );
    const policy = policySchema.parse(
      values.policy ? await readJson(values.policy) : {},
    );
    const target = transformSource(source, policy);
    const report = transformationReport(target);
    await writeJson(values.output!, target);
    await writeJson(values.report ?? `${values.output}.report.json`, report);
    const errors = report.filter((item) => item.severity === 'error');
    console.log(
      `Wrote target model and change/validation report; ${errors.length} blocking errors.`,
    );
    if (errors.length) process.exitCode = 2;
  } else {
    const target = targetDocumentSchema.parse(
      await readJson(requireOption(values.input, 'input')),
    );
    if (command === 'validate') {
      const diagnostics = validateTarget(target);
      if (values.report) await writeJson(values.report, diagnostics);
      console.log(JSON.stringify(diagnostics, null, 2));
      if (diagnostics.some((item) => item.severity === 'error'))
        process.exitCode = 2;
    } else {
      const sql = generateSql(target); // Validates again; skipping validate is safe.
      await writeNewFile(values.output!, sql);
      console.log(`Wrote ${values.output}.`);
    }
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
