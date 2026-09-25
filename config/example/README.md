# Local clone configuration

From the repository root:

```sh
mkdir -p config/local
chmod 700 config/local
cp config/example/{config.json,objects.json,policy.json} config/local/
chmod 600 config/local/*.json
```

Edit all placeholders, choose exact catalog object names, and run `npm run db:clone`.
The destination password must differ from the source password. Configuration is
literal JSON: `$`, backticks and environment-variable names are not expanded.
`config/local/` is ignored; do not force-add it. Metadata artifacts can also be
sensitive. Never embed credentials in a DSN.

The fixed entry point is `config/local/config.json`. All referenced paths resolve
from its directory, regardless of shell working directory. Unknown fields fail.
Use `source.dsn` OR both `source.tnsnames` and `source.tnsAlias`. A relative TNS
path is supported; its filename must be `tnsnames.ora`. `catalogScope` defaults
to `all`; choose `dba` explicitly only for an authorized account.

`objects` and `policy` default to adjacent `objects.json` and `policy.json`.
`destination.port` defaults to 1522 and binds only 127.0.0.1. Startup timeout defaults
to 1200 seconds. DSN, Compose, service and volume destination
overrides are forbidden. Ambient Oracle/Compose environment overrides do not apply.

Add `"prerequisiteSql": "prerequisites.sql"` and copy/edit the optional template
when using `createSchemas=false`, external prerequisites, a non-USERS tablespace,
or EXTENDED strings. For example, declare an external sequence in policy:

```json
{
  "version": 1,
  "createSchemas": false,
  "externalPrerequisites": [
    {
      "reference": { "owner": "APP", "name": "EXTERNAL_SEQUENCE" },
      "type": "SEQUENCE"
    }
  ]
}
```

The script must create every generated owner plus that sequence and needed grants.
With `createSchemas=true`, leave generated owner creation to the generator.
Setup is trusted SQL/PLSQL in FREEPDB1. Do not use SQL*Plus connect, host, include,
exit, spool or setting commands, change containers, disable error handling, or
print secrets. Common directive mistakes are rejected, but arbitrary SQL is not
sandboxed. Automatic provisioning requiring restarts is unsupported.

The file is retained in memory before reset, never copied to artifacts. Only its
byte count and SHA-256 are recorded. Setup checks verify owners, tablespace,
string sizing and declared objects; grants and opaque source expressions can
still fail during replay.
