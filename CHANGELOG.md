# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-25

### Added

- Initial release of `n8n-nodes-aidenix`.
- `Aidenix` node with the `Business Fit` operation, calling
  `POST /api/search/business-fit/run` on the Aidenix backend.
- `Aidenix API` credential with API token + configurable base URL.
- Idempotency-Key strategies:
  - `Deterministic` (default) — UUID v5 from
    `workflowId + executionId + itemIndex + query`; safe to replay.
  - `Random` — fresh UUID v4 per item.
  - `Custom` — value supplied by the user, expression-friendly.
- Automatic retry with the same idempotency key on `409 in_progress`
  and `504 timeout` responses; configurable max retries and delay.
- `Continue On Fail` support that returns `{ error, query, idempotencyKey }`.
- `X-Integration-Source: n8n` header on every outbound request.
