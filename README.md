# n8n-nodes-aidenix

[![npm version](https://img.shields.io/npm/v/n8n-nodes-aidenix.svg)](https://www.npmjs.com/package/n8n-nodes-aidenix)

n8n community node for [Aidenix](https://aidenix.com) — evaluate ICP fit for any contact and generate personalized email + LinkedIn outreach in a single workflow step.

## Features

- **Business Fit** operation — pass a LinkedIn slug or email, get back a fit score, a person summary, and ready-to-send outreach copy.
- **Built-in idempotency** — uses a deterministic `Idempotency-Key` per item, so retried executions reuse the cached server response instead of re-running expensive AI calls.
- **Automatic retry** on `409 in_progress` and `504 timeout` responses, with configurable backoff.
- **Standard n8n error handling** via `NodeApiError`, plus `Continue On Fail` support.

## Installation

In your n8n instance: **Settings → Community Nodes → Install** and enter:

```
n8n-nodes-aidenix
```

Or install manually:

```bash
npm install n8n-nodes-aidenix
```

## Credentials

Create an **Aidenix API** credential:

| Field      | Value                                                |
| ---------- | ---------------------------------------------------- |
| API Token  | Your Aidenix API token (issued in the dashboard).    |
| Base URL   | `https://api.aidenix.com` (only change for dedicated tenants). |

The credential sends the token as `X-API-Token` on every request.

## Operations

### Business Fit

| Parameter | Type   | Description                                                |
| --------- | ------ | ---------------------------------------------------------- |
| Query     | string | LinkedIn slug (`jane-doe-12345`) or email (`jane@acme.com`). |

**Options**

| Option                       | Default        | Description                                                                                                                                |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Idempotency Key Strategy     | Deterministic  | `Deterministic` — UUID v5 from `workflowId + executionId + itemIndex + query`. Replays reuse the cached response. `Random` — new UUID v4 per item. |
| Max Retries (on 409 / 504)   | 10             | Number of automatic retries when the API responds with `409 in_progress` or `504 timeout`.                                                  |
| Retry Delay (ms)             | 5000           | Delay between retries in milliseconds.                                                                                                     |

**Returned fields (flat schema)**

```json
{
	"job_id": "uuid",
	"status": "completed",
	"query": "jane-doe-12345",
	"fit_score_pct": 82,
	"person_description": "Jane — CTO at a fintech startup ...",
	"email_subject": "Quick question",
	"email_message": "Hi Jane, ...",
	"linkedin_message": "Hi Jane, ...",
	"logic_explanation": ["Role matches ICP", "Company at the right stage"],
	"strategy": "Practical approach",
	"strategy_do": ["Mention the pain", "Be specific"],
	"strategy_dont": ["Don't open with generic claims"]
}
```

## Workflow example

```
Schedule Trigger ─▶ Google Sheets (read leads) ─▶ Aidenix (Business Fit) ─▶ Gmail (send if fit_score_pct ≥ 70)
```

In the Aidenix node, set `Query` to `={{ $json.email }}` (or `linkedin_slug`). Downstream, branch on `={{ $json.fit_score_pct }} >= 70` to gate sends.

## Response codes handled by the node

| Code | Behavior                                                                |
| ---- | ----------------------------------------------------------------------- |
| 200  | Success — body returned as-is.                                          |
| 409  | `in_progress` — automatic retry with the same `Idempotency-Key`.        |
| 504  | Timeout (90 s) — automatic retry with the same `Idempotency-Key`.       |
| 422  | Body mismatch on a reused key — surfaced as `NodeApiError`.             |
| 451  | Contact opted out — surfaced as `NodeApiError`.                         |
| 402  | Quota exhausted — surfaced as `NodeApiError`.                           |

## Local development

```bash
npm install
npm run build

# Link into a local n8n install
npm link
cd ~/.n8n/custom   # create if missing
npm link n8n-nodes-aidenix

# Restart n8n
n8n start
```

## Publishing

```bash
npm run build
npm publish --access public
```

After publish, verify:

```bash
npm view n8n-nodes-aidenix
```

## Verification submission

To get listed in the in-app community catalog, open an issue at
[n8n-io/n8n](https://github.com/n8n-io/n8n) titled
`Community node submission: n8n-nodes-aidenix`, including the npm URL,
README link, and contact email.

## License

[MIT](./LICENSE.md)
