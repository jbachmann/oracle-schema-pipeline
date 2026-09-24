import { spawn } from 'node:child_process';

const schemas = ['FINANCE', 'COMMERCE', 'CATALOG', 'IAM'];

async function command(file: string, args: string[], input?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() :
      reject(new Error(`${file} ${args.join(' ')} exited ${code}`)));
    child.stdin.end(input);
  });
}

async function main(): Promise<void> {
  console.log('Starting Oracle destination...');
  await command('docker', ['compose', 'up', '-d', '--wait', 'oracle-destination']);

  const dropBlocks = schemas.map(schema => `
  BEGIN
    EXECUTE IMMEDIATE 'DROP USER ${schema} CASCADE';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLCODE != -1918 THEN RAISE; END IF;
  END;`).join('');
  const sql = `WHENEVER SQLERROR EXIT SQL.SQLCODE
WHENEVER OSERROR EXIT FAILURE
ALTER SESSION SET CONTAINER=FREEPDB1;
BEGIN${dropBlocks}
END;
/
DECLARE
  remaining NUMBER;
BEGIN
  SELECT COUNT(*) INTO remaining FROM dba_users
   WHERE username IN ('IAM', 'CATALOG', 'COMMERCE', 'FINANCE');
  IF remaining != 0 THEN
    RAISE_APPLICATION_ERROR(-20001, 'Managed destination schemas remain: ' || remaining);
  END IF;
END;
/
EXIT SUCCESS
`;

  console.log('Dropping managed schemas from destination...');
  await command('docker', ['compose', 'exec', '-T', 'oracle-destination', 'sqlplus', '-s', '/ as sysdba'], sql);
  console.log('Destination cleared. Container and data volume remain running.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
