# Feature: Clone preflight progress

- Status: Implemented
- Date: 2026-09-28
- Request: Show what `npm run db:clone` has accomplished and what it is waiting
  for during preflight, including Oracle image download progress.

## Context and Scope

Given a configured clone, when local destination preflight takes time, the
operator sees completed checks, the current operation, elapsed time, and available
image download progress. The requester selected download progress in addition to
named checks and periodic elapsed-time updates.

Included: the initial `preflight` stage, plain readable console output, optional
typed observers, and safe parsing of Docker pull output. Excluded: speeding up
preflight, changing timeouts/retries, progress for other stages, persisted telemetry,
and a total clone percentage or ETA. No core pipeline stage changes.

Oracle example: no source catalog condition is required. A local cache missing the
pinned Oracle image triggers the download before any remote connection. Example
output (timings and counters illustrative):

```text
Clone stage: preflight
Preflight: Docker endpoint — starting
Preflight: Docker endpoint — complete (0.1s)
Preflight: Docker daemon — starting
Preflight: Docker daemon — complete (0.2s)
Preflight: Docker Compose — starting
Preflight: Docker Compose — complete (0.1s)
Preflight: Oracle image availability — starting
Preflight: Oracle image download — starting
Preflight: layer abcdef123456 — downloading 120 MB / 600 MB
Preflight: Oracle image download — still running (10s elapsed)
Preflight: layer abcdef123456 — download complete
Preflight: Oracle image download — complete (45s)
Preflight: Oracle image availability — complete (46s)
Preflight: Destination identity — starting
Preflight: Destination identity — complete (0.3s)
```

## Research Findings

Verified locally:

- `scripts/clone-workflow.ts` prints a stage name and then awaits
  `Destination.preflight()`. Source extraction starts afterward.
- `scripts/compose-destination.ts` resolves and validates the local Docker
  endpoint, checks the daemon and Compose, inspects/pulls the pinned image,
  inspects its identity, and checks destination resource identity. Commands
  normally have 120-second timeouts; image pull allows 1,200 seconds.
- `scripts/process.ts` captures stdout and offers `onLine` for newline-delimited
  stderr only. The destination helper does not subscribe to it. Arbitrary child
  streams are intentionally private.
- Existing tests inject runners and destinations, so delayed operations and
  download output can be exercised without contacting the source or resetting
  a real destination.

Inference: a missing image can explain a long silent preflight. The requester's
actual slow operation has not been observed; Docker checks can also stall.

External reference: [Docker image pull documentation](https://docs.docker.com/reference/cli/docker/image/pull/)
(accessed 2026-09-28) documents layer status output and reuse of cached layers.
It does not promise a stable structured progress interface for this CLI command.
Treat textual parsing as best-effort and preserve elapsed-time reporting when
byte counters are unavailable.

## Decisions and Boundaries

- Enable progress by default for `db:clone`, through its existing log sink.
  Use append-only lines in both terminals and redirected output.
- Show start, completion, and failure for named operations. Emit a heartbeat
  every 10 seconds for the active operation using a monotonic elapsed clock.
- Show download/extraction byte counters only when Docker supplies recognized
  values. Show recognized layer statuses otherwise. Never invent overall
  percentage, total layer count, transfer speed, or remaining time.
- Throttle repeated download updates to at most one summary per second; summarize
  latest per-layer states and flush final pending statuses when the pull ends.
- Keep credentials, endpoint paths, configuration, SQL, arbitrary registry output,
  and raw errors out of progress. Only fixed labels, validated layer identifiers,
  allowlisted statuses, numeric counters/units, and elapsed times are rendered.

## Proposed Design

Add `scripts/clone-progress.ts` for the internal typed event contract, safe pull
parser, timing wrapper, and formatter. Events use a fixed operation union
(`endpoint`, `daemon`, `compose`, `image`, `image-pull`, `identity`), a fixed event
union (`start`, `complete`, `failure`, `heartbeat`, `layer`), and nonnegative
`elapsedMs`. Layer events additionally carry validated hexadecimal `layerId`, an
allowlisted status, and optional finite nonnegative `currentBytes`/`totalBytes`.
These are internal callbacks, not a new public JSON or artifact schema.

Allow `Destination.preflight` to accept an optional observer, preserving existing
no-argument callers and test doubles. Wrap existing operations in
`ComposeDestination.preflight` without changing command order, arguments, endpoint
validation, image pinning, or resource checks. Nest `image-pull` within image
availability when needed; heartbeat only the innermost active operation. A cached
image completes availability without any download event. Inspection fallback is
part of availability, not a falsely reported terminal preflight failure.

Extend `CommandOptions` with an optional separate progress-line observer receiving
both stdout and stderr records with stream identity. Preserve existing `onLine`
behavior and returned stdout. Frame the new observer's input across chunk
boundaries, CR/LF delimiters, and final unterminated records. Bound pending buffers;
discard oversized records rather than rendering their truncated tails. Only the
pull invocation subscribes to this observer. Parse recognized Docker layer lines,
strip terminal controls for parsing, reject invalid counters, and drop all unknown
text. Do not forward raw lines to the workflow logger.

The workflow formats events through `options.log`. Observer failures are
best-effort and must not alter orchestration. Clear timing/throttle resources on
success, rejection, timeout, and interruption; no output may continue after the
operation settles. No additional Docker polling or Oracle queries are needed.

No model/version, completion manifest, configuration, or `run-result.json` changes.
Preserve existing failure codes, exit statuses, cancellation, non-overwriting
publication, and reset ordering. Failure output names the failed operation without
exposing its raw exception. Unsupported progress text cannot fail a valid clone or
turn a failed pull into success. Image availability completes only after successful
final inspection; preflight completes only after identity validation.

Invariant check: no conflict with ADR 0001 or ADR 0008. ADR 0007's extraction event
contract remains unchanged; these timers belong to orchestration. No new ADR needed.

## Implementation Plan

1. Add internal events, parser, formatter, and scoped timing/throttling helpers in
   `scripts/clone-progress.ts`, with deterministic clock/timer test seams.
2. Add the opt-in dual-stream observer to `scripts/process.ts`, retaining existing
   extraction stderr handling and bounded stdout capture.
3. Instrument `scripts/compose-destination.ts` and connect the observer through
   `scripts/clone-workflow.ts` to its log sink.
4. Add the tests below and document preflight's local purpose, progress, image
   caching, and missing-counter fallback in `README.md`.
5. Run `npm run typecheck`, `npm test`, and `npm run build`.

## Test Plan

- New `test/clone-progress.test.ts`: controlled elapsed time, no heartbeat for fast
  checks, slow-operation heartbeat, nested operation timing, throttle/flush,
  callback exceptions, timer cleanup, safe statuses and counters, malformed and
  unknown records, and secret-bearing raw text rejection.
- Extend `test/clone-process.test.ts`: stdout and stderr framing, split records,
  CR/LF, final partial record, oversized records, independent legacy `onLine`,
  unchanged captured stdout, observer failure, timeout and cancellation cleanup.
- Extend `test/compose-destination.test.ts`: cached image, missing image with
  successful download, pull failure, silent pull, final inspection failure,
  identity rejection, and interruption. Assert event ordering and unchanged
  commands/timeouts; failure must not report completion.
- Extend `test/clone-workflow.test.ts`: formatted events reach the injected logger,
  credentials and raw errors stay private, preflight failure blocks extraction
  and reset, and existing result schema remains unchanged.
- No catalog or generated SQL behavior changes; no new Oracle round-trip cases
  are required. During implementation, validate parsing against an available
  Docker CLI's piped pull output without deleting cached images or resetting a
  destination solely to exercise progress. Record the tested CLI version/output
  variants; fall back gracefully on other variants.

## Acceptance Criteria

- [x] Each preflight check visibly starts and completes or fails.
- [x] A silent long-running operation reports its name and elapsed time every
      10 seconds; completed work remains readable in the log.
- [x] A missing image shows recognized layer statuses and available byte counters.
- [x] A cached image produces no fictitious download progress.
- [x] Unknown Docker output retains heartbeat visibility without exposing raw text.
- [x] Progress is bounded, throttled, and stops after failure or interruption.
- [x] Existing failure codes, artifacts, source read-only access, offline stages,
      generated SQL, and destination protection remain unchanged.
- [x] Focused regression tests, typecheck, unit suite, and build pass.

## Risks and Open Questions

Docker CLI output varies by version and terminal mode; counters may not be emitted
through pipes. Status-only output plus elapsed time is the required fallback.
An elapsed-time heartbeat proves the orchestrator is waiting, not that Docker is
making forward progress. No unresolved requester scope decisions.

## Implementation Validation

Implemented 2026-09-28. `npm run typecheck`, `npm test` (308 tests), and
`npm run build` pass. Focused tests cover operation timing, nested heartbeats,
layer coalescing and final flush, bounded dual-stream framing, observer exceptions,
timeout/interruption cleanup, cached and missing images, inspection/pull/identity
failures, and workflow logging and failure boundaries.

Docker CLI 29.8.0 was checked with a piped pull of the already-cached pinned Oracle
image. Its output contained the image reference, `Pulling from database/free`, a
digest, and an image-up-to-date status; there were no layer records or byte
counters. Those summary records are deliberately excluded from progress. No cached
images were deleted and no destination was reset. Downloading/extracting counters,
terminal controls, and layer status variants were validated with synthetic records;
a fresh live image download was not exercised. Other unrecognized variants retain
elapsed-time reporting.
