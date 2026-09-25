# Repository Guidelines

## Project Structure & Module Organization

Core TypeScript lives in `src/`. The pipeline is separated by stage: `extract.ts`,
`transform.ts`, `validate.ts`, and `generate.ts`. `model.ts` defines the versioned
Zod/TypeScript document contract; `catalog.ts` contains Oracle catalog access.
Keep command parsing in `cli.ts` and focused rendering helpers in `types.ts` and
`identity.ts`.

Unit tests and fixtures live in `test/`. Oracle round-trip tests live in
`test/integration/`. Synthetic inputs and generated examples are under `examples/`.
Seeded Docker initialization belongs in `test/docker/`; seeded clone/reset and
benchmark helpers belong in `test/scripts/`. Operational helpers belong in `scripts/`. Architecture decisions and feature-request guidance live in `docs/`.

## Build, Test, and Development Commands

- `npm ci`: install the locked Node.js 22+ dependencies.
- `npm run typecheck`: check strict TypeScript without emitting files.
- `npm run build`: compile into `dist/`.
- `npm test`: run offline unit tests with Node's test runner.
- `npm run test:integration`: run the Docker-backed Oracle round-trip suite.
- `npm run schema -- --help`: show CLI usage.
- `npm run schema -- transform --input examples/source.json --output /tmp/target.json`:
  exercise the offline pipeline.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, single quotes, and
semicolons. Use `camelCase` for variables/functions, `PascalCase` for types, and
lowercase descriptive filenames. Import local modules with `.js` extensions for
NodeNext compatibility. Prefer pure stage functions and runtime Zod validation.
No formatter or linter is configured; match surrounding code and run typecheck.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `*.test.ts` and describe
observable behavior in test names. Add success, boundary, and explicit-rejection
cases. Catalog or generated-SQL changes should include integration coverage.
There is no numeric coverage threshold; protect pipeline invariants and diagnostics.

## Commit & Pull Request Guidelines

Existing history contains placeholder messages, so no established convention is
available. Use short imperative subjects, for example `Add bitmap index validation`.
Keep commits focused. Pull requests must explain behavior, compatibility impact,
affected stages, tests run, and related issue. Use `docs/feature-request.md` for new
capabilities; add an ADR when changing an invariant from ADR 0001.

## Security & Architecture Constraints

Within the core pipeline only extraction may connect to Oracle, and source access
must remain read-only. ADR 0008 authorizes the separate `scripts/` orchestration
boundary to provision, replay, and verify only the fixed local Compose destination.
Test fixtures and helpers use the explicit test Compose project; never adopt old
root-project resources.
Never place passwords in arguments, fixtures, logs, or artifacts. Generation must
fail closed on unsupported metadata, revalidate input, and never overwrite output.
