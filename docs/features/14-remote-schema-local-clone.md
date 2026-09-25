# Feature: Remote structure extraction into a disposable local Oracle database

- Status: Implemented — verified 2026-09-25
- Date: 2026-09-25
- Request: Run one npm command to extract a configured remote Oracle structure,
  retain each run's artifacts, and replace a local Docker Oracle destination.

## Context and Scope

`npm run db:clone` becomes the operational entry point. Given a configured remote
source and explicit object selection, it extracts metadata, creates the dictionary,
transforms, validates, generates SQL, recreates the destination container and data
volume, runs optional prerequisite SQL, and loads the generated structure. A
successful destination remains running for inspection and development.

Requester decisions:

- Copy structure only, with the pipeline's current supported object types.
- Destroy the destination and its volume only after generation succeeds.
- Keep configuration together in ignored `config/local/`, using `config.json`
  rather than `.env`.
- Support an optional local prerequisite SQL file, executed on the new destination
  before generated SQL.
- Preserve each invocation's artifacts in a new subdirectory of `artifacts/`.
- Move the existing seeded Compose setup and validation scripts into test context.

Affected stages: orchestration calls extract, dictionary, transform, validate,
and generate. Their metadata semantics and supported-feature boundaries stay the
same. Source access remains read-only. Excluded: application rows, remote destination
deployment, new Oracle object support, migration of existing destination data,
automatic export of prerequisite objects, and automatic artifact retention cleanup.

## Research Findings

Verified repository facts:

- `docker-compose.yml` currently defines seeded source and destination services,
  using `container-registry.oracle.com/database/free:latest`, `FREEPDB1`, and named
  data volumes. Source seed mounts live under `docker/oracle/`.
- `scripts/clone-compose-database.ts` assumes four fixture schemas, exactly 98
  tables, and two selected views. It generates artifacts and verifies the transform
  completion manifest, but refuses an existing destination schema.
- `scripts/reset-compose-destination.ts` drops those four schemas; it does not
  remove the container or volume. `scripts/benchmark-extraction.ts` uses synthetic
  test catalog helpers and also belongs in test context.
- `test/integration/oracle-roundtrip.test.ts` and
  `.github/workflows/oracle-integration.yml` implicitly use the root Compose file.
  The suite also permits DSN overrides that can disagree with container SQL replay.
- `src/connection.ts` supports a DSN or an absolute `tnsnames.ora` path plus alias.
  `src/cli.ts` defaults to ALL catalog access, permits explicit DBA access, and
  obtains passwords through `ORACLE_PASSWORD` or a hidden prompt.
- `src/model.ts` defines strict format-v4 source/target documents, selection v2,
  and policy v1. `src/validate.ts` requires prerequisites to be acknowledged and
  requires `createSchemas=false` when policy prerequisites are supplied.
- `src/prepare.ts` otherwise creates schema owners with `NO AUTHENTICATION`.
  Acknowledging prerequisites does not provision them.
- `src/files.ts` publishes without overwriting using exclusive hard links;
  `src/completion.ts` verifies transform target/report bytes and paths.
- Feature 11 is an unimplemented destination-consistency proposal. This request
  resolves the operational destination as Compose-only and replaces its proposed
  preserve-existing-destination behavior for the new operational command.

External primary documentation, accessed 2026-09-25:

- [Compose down](https://docs.docker.com/reference/cli/docker/compose/down/):
  `--volumes` removes declared named volumes; external volumes are not removed.
- [Compose project names](https://docs.docker.com/compose/how-tos/project-name/):
  project names isolate resources; explicit `-p` takes precedence over environment
  and file defaults.
- [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/):
  ordinary recreation preserves mounted volumes; `--wait` and `--wait-timeout`
  provide bounded readiness waiting.

Design inference: use separate explicit Compose projects and remove the operational
named volume, rather than relying on container recreation to clear data. A policy
and generated SQL can pass validation while relying on absent prerequisites, so
the orchestrator must check prerequisite configuration before destruction.

## Decisions and Boundaries

### Configuration contract

Add tracked templates under `config/example/`, plus a short setup guide. Ignore
all of `config/local/`. The operator copies templates once and edits local files;
subsequent runs require only `npm run db:clone`. No `.env` is required or generated.

Add a strict Zod schema in proposed `scripts/clone-config.ts`:

| Field                               | Contract                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                           | Required literal `1`; independent of pipeline document versions.                                                                               |
| `source.user`                       | Required nonempty Oracle username.                                                                                                             |
| `source.password`                   | Required nonempty secret string, held only in local config and process memory/environment.                                                     |
| `source.dsn`                        | Nonempty connection string; mutually exclusive with both TNS fields. Credentials must be separate, not embedded.                               |
| `source.tnsnames`                   | Path to `tnsnames.ora`; required with `source.tnsAlias`. Resolve relative to the config directory before using existing connection resolution. |
| `source.tnsAlias`                   | Nonempty alias; required with `source.tnsnames`.                                                                                               |
| `source.catalogScope`               | `all` by default, or explicit `dba`; never silently escalate privileges.                                                                       |
| `objects`                           | Path relative to the config directory, default `objects.json`; parse with existing selection v2 schema.                                        |
| `policy`                            | Path relative to the config directory, default `policy.json`; parse with existing policy v1 schema.                                            |
| `prerequisiteSql`                   | Optional path relative to the config directory; readable UTF-8 SQL*Plus script.                                                                |
| `destination.password`              | Required nonempty bootstrap secret, distinct from the source password. No development password fallback.                                       |
| `destination.port`                  | Integer 1–65535, default `1522`; bind the published listener to `127.0.0.1`.                                                                   |
| `destination.startupTimeoutSeconds` | Positive integer, default `1200`; bounded Compose/PDB readiness.                                                                               |

Reject unknown fields, including destination DSNs, service overrides, external
volumes, and Compose-file overrides. Resolve paths from the config directory,
independent of shell working directory. Use the repository's fixed
`config/local/config.json` entry point for this version. Credentials in templates
are obvious placeholders; reject unchanged placeholders before extraction.
Document restrictive local file permissions. Never serialize the effective config,
copy it into artifacts, or print validation input values.

JSON values are literal: do not perform shell interpolation or environment-variable
expansion. Existing source/destination environment overrides do not override this
command's configuration. Pass a deliberately constructed child environment: source
credentials only to extraction, destination bootstrap credentials only to Compose.
Prevent ambient `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, and implicit `.env` loading
from redirecting the workflow. Do not mount `config/local/` into the container.

### Prerequisite SQL

The file is operator-authored, trusted destination setup code, not an export of
unsupported source objects. Execute it explicitly once, after the destination PDB
is healthy and before `clone.sql`. Do not use a recurring startup mount.

Read and retain its bytes in memory before destructive work. Require a file when
the policy uses `createSchemas=false`, acknowledges external prerequisites, selects
a non-default tablespace, or requires EXTENDED string sizing. Without one, return
`CLONE_PREREQUISITE_REQUIRED` before destruction. A file's presence cannot prove
its adequacy; check destination tablespace, string-size setting, schema owners,
and acknowledged prerequisite object existence before generated replay where the
metadata permits. Grants and opaque SQL behavior may still fail during replay.

When policy prerequisites require `createSchemas=false`, the setup script must
create all generated owners as well as prerequisite objects/grants. With
`createSchemas=true`, it must avoid creating owners that generation will create.
The default template uses `createSchemas=true`, `USERS`, `STANDARD`, and no external
prerequisites. Do not silently rewrite policy or relax existing diagnostics.

Scripts must remain in `FREEPDB1`, use SQL/PLSQL rather than SQL*Plus connection,
host, include, or exit commands, and must not disable failure handling or introduce
secrets into output. This is a trusted-code contract, not a claim that arbitrary
SQL is sandboxed. Keep the script outside artifacts; record only its byte length
and SHA-256. Do not persist raw SQL*Plus output, which could expose script content.

### Compatibility and invariants

No change to format v4, selection v2, policy v1, completion manifests, catalog
selection rules, or deterministic SQL rendering. Existing standalone CLI commands
remain available. No output is overwritten or removed as rollback.

Move the old clone/reset commands to explicitly named test commands. Reusing
`db:clone` for the new destructive destination workflow is an intentional behavior
change and must be prominent in README migration notes. Remove the old
`db:reset-destination` alias; the new command incorporates the complete reset.
Never automatically adopt or delete resources from the old root Compose project.

Add ADR 0008 during implementation to explicitly narrow ADR 0001's
"only extraction connects to Oracle" invariant to the core pipeline and authorize
the separate destination orchestration boundary for setup, replay, and read-only
checks. This does not authorize writes to the source. Update `AGENTS.md` to describe
test-local fixtures/helpers and this destination boundary. This clarification is
required rather than silently redefining the invariant.

## Proposed Design

### Files and commands

Proposed paths below are new or moved paths, not existing implementation:

| Existing path or command                           | Planned location or behavior                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Root `docker-compose.yml`                          | New destination-only operational Compose definition.                                                                |
| Existing Compose definition                        | `test/docker/docker-compose.yml`, explicit project `oracle-schema-pipeline-test`.                                   |
| `docker/oracle/source-init/` and `source-startup/` | `test/docker/oracle/source-init/` and `source-startup/`; fix relative mounts.                                       |
| Existing clone/reset scripts                       | `test/scripts/clone-compose-database.ts` and `test/scripts/reset-compose-destination.ts`; repair imports.           |
| `scripts/benchmark-extraction.ts`                  | `test/scripts/benchmark-extraction.ts`; repair imports and retain `benchmark:extraction` command.                   |
| `db:clone`                                         | New `scripts/clone-database.ts`.                                                                                    |
| Seeded clone/reset npm commands                    | `test:db:clone` and `test:db:reset-destination`.                                                                    |
| Operational helpers                                | `scripts/clone-config.ts`, `scripts/clone-workflow.ts`, `scripts/compose-destination.ts`, and `scripts/process.ts`. |

Use explicit absolute Compose paths and `-p` on every invocation. Operational
project: `oracle-schema-pipeline-local`; service: `oracle-destination`; data volume:
project-scoped `oracle-destination-data`. No source service or seed mounts in the
root file. Keep the currently used Oracle Free image family and `FREEPDB1` behavior;
validate and record the actual image ID/version in live testing. Pin a tested image
digest in implementation if the registry supports the required platform; do not
invent a version tag from documentation. Reuse the PDB-level health check.

Resolve the Docker endpoint once and require a local daemon endpoint for this
local-destination workflow. Reject remote Docker endpoints and destination identity
overrides. Check existing resource Compose labels and expected volume mounts before
destruction; refuse conflicting resources instead of broadly pruning. Use the same
resolved project/service/container identity for readiness, replay, and verification.
Test helpers must likewise use their explicit test Compose file and reject DSN
overrides that could disagree with replay. Integration source fixture ports remain
configurable, and their documented test-only environment variables remain separate.

### Run sequence

1. Resolve repository paths and exclusively allocate a private
   `artifacts/db-clone-<UTC timestamp>-<random suffix>/` directory. Even failed
   attempts retain their own directory when the filesystem is writable. Acquire
   an exclusive local lock for this fixed destination; concurrent runs fail before
   extraction/reset. Release only the invocation's own lock. A stale lock fails
   closed with documented operator recovery after checking no run remains active.
2. Parse configuration, objects, and policy; read optional prerequisite SQL;
   preflight Docker availability, Compose support, and resource identity. Ensure
   the required destination image is locally available before reset. Publish
   canonical `objects.json` and `policy.json` snapshots using existing exclusive
   artifact publication. These contain metadata, never connection credentials.
3. Run extraction against the configured remote source to `source.json`. Enable
   existing safe progress events for user-visible activity. Source errors must
   never trigger destination reset.
4. Create `data-dictionary.xlsx`; transform into `target.json` and `report.json`;
   verify `target.json.complete.json`; validate; generate `clone.sql`. Pass a
   run-local staging directory via `--temp-dir` so publication stays on the same
   filesystem. Every nonzero stage exit aborts before destruction.
5. Read the generated SQL successfully and complete all possible setup preflight
   checks. Recheck destination identity and lock ownership. Only now invoke the
   fixed destination-only project's `down --volumes`. Confirm the expected data
   volume is absent; a removal failure stops the run instead of reusing stale data.
6. Invoke `up -d --wait --wait-timeout <configured seconds>`, then check readiness
   of `FREEPDB1` in that same service. This applies whether the old database was
   running, stopped, or absent.
7. Execute optional prerequisite SQL through `docker compose exec -T` and SQL*Plus
   stdin using container-local OS authentication. Establish fail-on-SQL/OS-error
   behavior, disable substitution and echo, and explicitly select `FREEPDB1`.
   Use a fixed nonzero SQL error exit status rather than `SQL.SQLCODE`, whose
   process-exit truncation can lose a failure. Check required setup conditions.
8. Execute the retained `clone.sql` bytes with the same session safeguards. Keep
   trusted source SQL fragments opaque. Check expected modeled tables/views exist
   and modeled objects are valid using destination catalog reads. Report replay
   completion only after these checks; this is bounded verification, not a promise
   of complete semantic equivalence. Comprehensive comparison stays in tests.
9. Publish `run-result.json` once, print the artifact directory and local listener
   address, and leave the destination running. Failure publishes a failure result
   where possible and preserves artifacts and any partial new destination. Do not
   retry setup/replay into a partial database; the next invocation starts anew.

The result contract is strict version 1: `runId`, `startedAt`, `finishedAt`,
`status` (`succeeded` or `failed`), `lastStage`, `destinationResetStarted` (boolean),
and optional `errorCode`, `childExitCode`, `prerequisite` (`bytes`, `sha256`), and
`destinationImageId`. Exclude configuration, passwords, DSNs, raw errors, SQL text,
and subprocess environments. Missing result means interrupted/incomplete, not
success. On SIGINT/SIGTERM, stop dependent work and terminate active children;
best-effort publish failure and release the owned lock. SIGKILL cannot guarantee
either action. Never overwrite a published result.

### Failure behavior

Stable orchestration codes: `CLONE_CONFIG_INVALID`, `CLONE_ALREADY_RUNNING`,
`CLONE_PREREQUISITE_REQUIRED`, `CLONE_DESTINATION_MISMATCH`,
`CLONE_DOCKER_UNAVAILABLE`, `CLONE_STAGE_FAILED`, `CLONE_RESET_FAILED`,
`CLONE_STARTUP_FAILED`, `CLONE_PREREQUISITE_FAILED`, `CLONE_REPLAY_FAILED`,
`CLONE_VERIFICATION_FAILED`, and `CLONE_INTERRUPTED`. Include field paths, stage
names, and safe Oracle error codes where useful, but never offending secret values.
Preserve existing pipeline diagnostic codes and publication errors. The npm
workflow exits zero only on verified success; operational failures exit 1, with
the child stage exit recorded separately. Never claim success after a nonzero
child exit or signal.

After destruction there is no rollback to the old volume. A failure during setup,
startup, or replay leaves the new destination incomplete and reports that fact.
Do not dump raw subprocess streams or interpolate secrets into shell commands.

## Implementation Plan

1. Add ADR 0008 and update repository guidance; link this plan from feature 11 and
   the architecture roadmap, recording the operational policy it supersedes.
2. Move the seeded Compose definition, SQL/startup fixtures, and three scripts into
   test context. Update imports, npm commands, integration Compose calls, CI, and
   README paths. Preserve seeded clone/reset behavior under the new test names.
3. Add the strict JSON configuration loader, ignored local directory, tracked
   templates (`config.json`, `objects.json`, `policy.json`, optional commented
   `prerequisites.sql`) and configuration tests.
4. Add destination-only root Compose configuration and reusable subprocess and
   destination helpers. Implement explicit identity, local Docker endpoint checks,
   bounded readiness, volume removal verification, and SQL*Plus failure handling.
5. Implement the workflow state transitions, run allocation/locking, immutable
   snapshots/results, existing CLI calls, completion verification, setup/replay,
   and destination checks. Wire `npm run db:clone` to this workflow.
6. Add mocked orchestration tests and a disposable live workflow test. Update CI
   so both test and operational fixture resources are explicitly cleaned up.
7. Update README with one-time setup, config fields, prerequisite policy examples,
   artifact layout, destructive timing, failure recovery, schema access behavior,
   and migration from old npm commands/resources. Run the checks below.

## Test Plan

- New `test/clone-config.test.ts`: DSN/TNS alternatives, relative paths, unknown
  fields/versions, missing secrets, unchanged placeholders, JSON literal password
  characters, unsupported destination overrides, and secret-free diagnostics.
- New `test/clone-workflow.test.ts`: inject process/filesystem/destination seams;
  cover full success with/without setup, ordering of every stage, each pre-reset
  failure preserving the prior destination, failed volume removal blocking startup,
  setup failure blocking replay, replay/verification failure, signals, locking,
  timestamp collisions, and non-overwriting artifacts. Assert child argv, output,
  result documents, and non-extraction environments exclude source credentials.
- New `test/compose-destination.test.ts`: fixed identity for every operation,
  conflicting labels/mounts, remote Docker endpoint rejection, ambient Compose
  overrides, readiness timeout, and SQL*Plus fixed-error-status propagation.
- Extend existing integration coverage through proposed
  `test/integration/local-clone.test.ts`: use the test source as the remote endpoint
  and the isolated operational destination. Use a temporary checkout/config fixture
  rather than touching an operator's real `config/local/`. Exercise two runs,
  insert a destination-only sentinel between runs, and assert the sentinel and old
  volume are gone after replacement while source facts remain unchanged. Verify
  structures independently, including keys/comments/views and invalid-object
  rejection, and verify modeled source application rows were not copied.
- Cover a prerequisite sequence/default with explicit policy acknowledgement and
  owner provisioning, setup SQL failure, and a generate failure that preserves the
  first successful destination. Keep prerequisite scripts secret-free fixtures.
- Confirm test and operational projects cannot reset each other's volumes and that
  the migrated seeded round-trip suite still passes.

Existing verification commands: `npm run typecheck`, `npm test`, `npm run build`,
and `npm run test:integration`. Integration changes are mandatory here because
orchestration now deliberately destroys and rebuilds a database. Planned smoke
commands: `npm run test:db:clone`, `npm run test:db:reset-destination`, and
`npm run db:clone` with fixture configuration. `benchmark:extraction` must still
work after its move. Never run destructive smoke checks against an operator's
existing destination without isolating the test environment.

## Acceptance Criteria

- [x] One `npm run db:clone` uses only the configured remote source and produces a
      running Docker destination containing the supported selected structure.
- [x] Configuration uses ignored `config/local/config.json` with adjacent selection,
      policy, optional TNS, and optional prerequisite SQL; no `.env` is needed.
- [x] Every run has a unique artifact directory; successful runs contain selection,
      policy, source, dictionary, target/report/completion, SQL, and run result files.
- [x] Extraction, transformation, validation, generation, and preflight failures
      leave the previous destination container and volume intact.
- [x] After successful generation, old destination storage is removed before a
      fresh database is created, including when the old container is stopped.
- [x] Setup executes before generated SQL and failure stops loading immediately.
- [x] Missing prerequisites and unsupported metadata fail explicitly; policy
      acknowledgement never masquerades as successful provisioning.
- [x] Success requires destination verification; failed or interrupted runs cannot
      be mistaken for success and never overwrite earlier artifacts.
- [x] Source access remains read-only; no application rows are copied; offline
      stages remain offline; model versions and deterministic SQL remain unchanged.
- [x] Credentials never enter argv, logs, snapshots, generated artifacts, or results.
- [x] Seeded fixtures, scripts, integration tests, and CI use explicit test context;
      operational reset never touches those resources or old-project resources.
- [x] Unit and disposable integration checks pass; README and ADR changes document
      the destination-write boundary and changed npm-command behavior.

## Risks and Open Questions

No unresolved requester scope decisions. Implementation must confirm the tested
Oracle Free image/platform combination and document its concrete version/digest.
Current `latest` is mutable, and compatibility with an arbitrary source release
is not guaranteed by this orchestration feature.

Prerequisite SQL is trusted administrative code and may need version-specific
setup or restarts; automatic multi-phase database provisioning is out of scope.
Source expressions can refer to dependencies not fully represented by catalog
prerequisite facts; replay can fail after reset despite successful generation.
Oracle DDL is not transactionally reversible, so failures after reset lose the old
destination and may leave partial new structure. This is the approved disposable
destination behavior.

Local configuration contains secrets, and metadata artifacts can themselves be
sensitive. Gitignore prevents ordinary commits, not filesystem access or forced
adds. Snapshot consistency of a concurrently changing remote source remains the
existing extraction limitation described in feature 12; no snapshot guarantee is
introduced here. A killed process can leave a stale run lock or staging directory;
document explicit recovery without adopting or overwriting prior run artifacts.

## Implementation verification

Implemented the operational workflow, strict config/templates, immutable run
artifacts, shared per-user destination lock, endpoint/resource checks, prerequisite
setup and bounded destination verification. Seeded fixtures and helpers now use
`test/docker/` and `test/scripts/`; ADR 0008 records the destination-write boundary.

Verified with typecheck, build, 204 offline tests and all five live integration tests.
The renamed `test:db:reset-destination` and `test:db:clone` smoke checks pass,
and `benchmark:extraction -- 32` still completes all four workloads after its move.
The disposable clone suite exercises the actual npm entry point in a temporary
checkout, repeated volume replacement, source row preservation, empty destination
tables, independent keys/comments/views, invalid-view rejection, SQL error exit
status 1, a generation publication failure preserving the existing destination,
and prerequisite success/failure. The original seeded reconstruction, restricted
catalog access and batching comparisons also pass in the explicit test project.

Live image: Oracle `23.26.3.0.0`, Linux amd64,
`sha256:cdf2f86bedfa41904dfd7dbf27defe90d46a2fb8b34d85ad1c279f2bda839420`.
Both Compose definitions pin registry digest
`sha256:f988b0c04c4c386cd306a2a914c0d7a9702d83acc31b064a28ad8eb6278a8fba`.
Testing used a macOS x64 Node process and a Docker VM with approximately 5.8 GiB
available, keeping two Oracle databases active at a time. PDB health requires
READ WRITE, and test listener registration has a separate bounded readiness check.
The cold-database batching comparison has a ten-minute test timeout.

The orchestrator adapts only the exact generated SQL*Plus preamble, replacing its
client error/echo settings while preserving the generated SQL body. It preserves
known publication error codes without forwarding raw child errors. The destination
lock lives under the system temporary directory and is shared across checkouts;
its location and stale-lock recovery are documented in README.
