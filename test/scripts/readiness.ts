import oracle from 'oracledb';
/** OS-authenticated PDB health can precede TCP service registration. */
export async function waitForListener(
  connectString: string,
  password: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const connection = await oracle.getConnection({
        user: 'SYSTEM',
        password,
        connectString,
        connectTimeout: 5,
      });
      try {
        await connection.execute('SELECT 1 FROM dual');
      } finally {
        await connection.close();
      }
      return;
    } catch (error) {
      if (Date.now() >= deadline)
        throw new Error(
          `Test listener readiness timed out (${/\b(?:ORA|NJS)-\d+/.exec(String(error))?.[0] ?? 'UNKNOWN'})`,
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
