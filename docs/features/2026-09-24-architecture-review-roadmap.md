# Architecture review: feature request roadmap

- Date: 2026-09-24
- Status: Draft requests captured; implementation not started

Retain the four-stage pipeline, strict versioned models, pure transformation,
offline generation, and SourceCatalog seam. The linked requests capture all eight
review recommendations. Proposed interfaces and compatibility choices are not
requester-approved; each request identifies decisions needed before implementation.

| Order | Request | Priority | Dependency / sequencing |
| --- | --- | --- | --- |
| 1 | [Authoritative semantic validation](2026-09-24-authoritative-semantic-validation.md) | High | Establish shared semantic analysis first. |
| 2 | [Strict catalog decoding and faithful view metadata](2026-09-24-strict-catalog-decoding.md) | High | Coordinate view contracts and ADR with semantic validation. |
| 3 | [Atomic artifact publication and completion tracking](2026-09-24-atomic-artifact-publication.md) | High | Can proceed independently after publication contract decisions. |
| 4 | [Independent reconstruction verification](2026-09-24-independent-reconstruction-verification.md) | High | Add regression coverage alongside each correctness change. |
| 5 | [Generation preflight diagnostics](2026-09-24-generation-preflight-diagnostics.md) | Medium | Build on shared semantic analysis. |
| 6 | [Extraction observability and measured performance](2026-09-24-extraction-observability-and-performance.md) | Medium | Instrument first; batch only after baseline measurement. |
| 7 | [Consistent destination orchestration](2026-09-24-consistent-destination-orchestration.md) | Medium | Can proceed independently after destination policy decision. |
| 8 | [Extraction consistency and provenance](2026-09-24-extraction-consistency-and-provenance.md) | Medium | Research change indicators first; coordinate model version with catalog work. |

Recommended delivery sequence: validation/catalog correctness and independent
regression coverage; artifact and destination safety; generation preflight;
observability and measured optimization. Research consistency/provenance in parallel
with contract work, without promising snapshot guarantees.

The organizational changes belong to their behavior requests: catalog transport/
decoding/assembly separation, a shared semantic graph, reusable operational helpers,
and a view ADR superseding ADR 0001's view exclusion. Avoid a broad directory or
framework rewrite. Artifact migrations, workbook streaming, and connection
concurrency are deferred until a concrete compatibility or measured performance
need justifies them.

Review evidence: all production modules and operational scripts inspected; 32
offline tests and TypeScript checking passed; six in-memory validation probes
identified five accepted invalid/inconsistent models and one late render failure.
Live Oracle integration was inspected, not run. These documentation changes do not
implement the recommendations.
