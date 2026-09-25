# ADR 0008: Disposable local destination orchestration

- Status: Accepted
- Date: 2026-09-25

## Context

[Feature 14](../features/14-remote-schema-local-clone.md) requires one command
that reads a remote schema and replaces a disposable local Oracle database.
ADR 0001's extraction-only connection rule did not distinguish the core pipeline
from administrative destination orchestration.

## Decision

Within the core pipeline, only extraction connects to Oracle and all source access
remains read-only. A separate `scripts/` orchestration boundary may provision,
replay SQL into, and query the fixed local Compose destination. Offline stages and
model versions remain unchanged. No source credentials reach destination children.

The operational project is `oracle-schema-pipeline-local`; the seeded test project
is `oracle-schema-pipeline-test`. Every Compose invocation supplies its file and
project explicitly. Existing legacy resources are never adopted or deleted.
Only local Docker socket endpoints are accepted.

Generation, completion verification, image availability and identity checks must
succeed before `down --volumes`. Volume absence must be confirmed before startup.
The previous database is then irrecoverable; failures preserve artifacts and the
partial new destination. Trusted prerequisite SQL runs once before replay.
Acknowledging a dependency is not provisioning it.

Each invocation exclusively allocates private artifacts and a destination lock.
Results are immutable, secret-free summaries. Missing results indicate interruption,
not success. SQL*Plus uses fixed nonzero failure statuses; orchestration adapts only
the exact generated client preamble, leaving source SQL fragments opaque.

## Consequences

`db:clone` deliberately becomes destructive after generation. The former seeded
commands move to `test:db:clone` and `test:db:reset-destination`. The preservation
policy proposed in feature 11 is superseded for this operational workflow.
No rollback, row copying, complete semantic comparison, or automatic stale-lock
recovery is promised. This boundary authorizes destination writes only.
