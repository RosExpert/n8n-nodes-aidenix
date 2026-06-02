# n8n-nodes-aidenix

[![npm version](https://img.shields.io/npm/v/n8n-nodes-aidenix.svg)](https://www.npmjs.com/package/n8n-nodes-aidenix)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-aidenix.svg)](https://www.npmjs.com/package/n8n-nodes-aidenix)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE.md)

An [n8n](https://n8n.io) community node for [Aidenix](https://aidenix.com) — score how well a lead matches your Ideal Customer Profile and generate personalized email + LinkedIn outreach in a single workflow step.

Drop a LinkedIn slug or an email address into the node, get back a fit score, an enriched person summary, and ready-to-send copy — no separate enrichment / scoring / copywriting steps needed.

![Aidenix node — input parameters and the flat output it produces](./docs/screenshot1.png)

---

## Table of contents

- [Why Aidenix](#why-aidenix)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Credentials](#credentials)
- [Quick start](#quick-start)
- [Operations](#operations)
- [Response schema](#response-schema)
- [Common workflow patterns](#common-workflow-patterns)
- [Error handling](#error-handling)
- [Idempotency & retries](#idempotency--retries)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)
- [Resources & support](#resources--support)
- [License](#license)

---

## Why Aidenix

Most outbound workflows in n8n stitch together 3–5 separate services: enrichment (Apollo / Clearbit), scoring (custom LLM step), copywriting (another LLM step), then a sender. Each step is a moving part — keys, rate limits, prompt tuning, retries.

The Aidenix node collapses all of that into one call:

- **Input**: `jane@acme.com` or `jane-doe-12345`
- **Output**: fit score, person/company context, subject line, email body, LinkedIn DM, plus reasoning and Do/Don't guidance

Use it when you need to qualify and personalize at the same time — typical lead-routing, SDR enablement, and event-triggered outreach flows.

## Features

- **Business Fit** operation — pass a LinkedIn slug or email, get an ICP fit score (0–100), a person summary, and ready-to-send email + LinkedIn copy.
- **Built-in idempotency** — deterministic `Idempotency-Key` per item, so retried executions reuse the cached server response instead of paying for a duplicate AI run.
- **Automatic retry** on `409 in_progress` (still computing) and `504 timeout`, with configurable backoff.
- **Standard n8n error handling** via `NodeApiError`, with full **Continue On Fail** support.
- **HTTPS-only by default**, with a runtime warning if a non-loopback Base URL is configured over plain HTTP.

## Prerequisites

- An n8n instance (Cloud or self-hosted), **n8n v1.0+ recommended**.
- An Aidenix account and API token — sign up at [aidenix.com](https://aidenix.com), then create a token from the dashboard.
- For self-hosted n8n: Node.js **18.10+** (this matches n8n's own engine requirement).

## Installation

### n8n Cloud / self-hosted UI

1. Open **Settings → Community Nodes**.
2. Click **Install a community node**.
3. Enter the package name:
   ```
   n8n-nodes-aidenix
   ```
4. Accept the risk prompt and click **Install**.

The Aidenix node appears in the node picker as **Aidenix**.

### Manual install (self-hosted, advanced)

```bash
cd ~/.n8n/custom   # create if missing
npm install n8n-nodes-aidenix
# restart n8n
```

## Credentials

Create an **Aidenix API** credential in n8n:

| Field      | Required | Default                  | Description                                                                                   |
| ---------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| API Token  | Yes      | —                        | Token issued in the Aidenix dashboard. Stored encrypted by n8n; sent as `X-API-Token` header. |
| Base URL   | No       | `https://api.aidenix.com` | Override only for dedicated tenants or self-hosted Aidenix.                                   |

> **Security note:** the node refuses to log the token and warns if Base URL is plain HTTP to a non-loopback host. Keep Base URL on `https://` in all real environments.

## Quick start

A minimal "score-and-send" workflow:

1. Add a **Schedule Trigger** (or any trigger producing leads).
2. Add a **Google Sheets / Airtable** node to read a list of leads — each row should have an `email` (or `linkedin_slug`) column.
3. Add the **Aidenix** node:
   - **Operation**: `Business Fit`
   - **Query**: `={{ $json.email }}`
   - Leave **Options** at their defaults.
4. Add an **IF** node:
   - Condition: `={{ $json.fit_score_pct }}` ≥ `70`
5. On the `true` branch, add **Gmail / Outlook** with:
   - Subject: `={{ $json.email_subject }}`
   - Body: `={{ $json.email_message }}`

That's the whole pipeline. Idempotency is on by default — re-running the workflow on the same row will reuse the cached Aidenix response instead of charging you twice.

## Operations

### Business Fit

Evaluates ICP fit for a contact and generates personalized outreach.

| Parameter | Type   | Required | Description                                                                  |
| --------- | ------ | -------- | ---------------------------------------------------------------------------- |
| Query     | string | Yes      | LinkedIn slug (`jane-doe-12345`) **or** email (`jane@acme.com`). Auto-detected. |

#### Options

| Option                   | Default        | Description                                                                                                                                |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Idempotency Key Strategy | Deterministic  | `Deterministic` — UUID v5 from `workflowId + executionId + itemIndex + query`. Replays reuse the cached response. `Random` — new UUID v4 per item. `Custom` — supply your own. |
| Idempotency Key          | —              | Only used when strategy is `Custom`. Useful when the key comes from an upstream node, e.g. `={{ $json.idempotency_key }}`.                  |
| Max Retries (409 / 504)  | 10             | Retries when the API responds with `409 in_progress` or `504 timeout`.                                                                     |
| Retry Delay (Ms)         | 5000           | Delay between retries.                                                                                                                     |

## Response schema

The node returns a flat JSON object per input item:

```json
{
  "job_id": "9f1c…",
  "status": "completed",
  "query": "jane-doe-12345",
  "fit_score_pct": 82,
  "person_description": "Jane — CTO at a fintech startup, ~50 engineers, recently raised Series B.",
  "email_subject": "Quick question about your payment flow",
  "email_message": "Hi Jane, …",
  "linkedin_message": "Hi Jane, …",
  "logic_explanation": [
    "Role matches ICP (technical decision-maker)",
    "Company at the right stage (post-Series B)"
  ],
  "strategy": "Practical, problem-first approach",
  "strategy_do": ["Mention the specific pain", "Be concrete about ROI"],
  "strategy_dont": ["Don't open with generic claims", "Don't reference unrelated case studies"]
}
```

All fields are safe to reference directly in downstream nodes via `={{ $json.field_name }}`.

## Common workflow patterns

### 1. Trigger → Score → Conditional send

![Workflow: Execute → Aidenix → IF → Gmail / No-op](./docs/screenshot2.png)

```
Trigger ─▶ Aidenix (Business Fit) ─▶ IF (fit_score_pct ≥ 70) ─▶ Gmail (send)
                                                                  └▶ No-op (skip)
```

Score every lead, send only to those above your threshold, drop the rest. Swap the manual trigger for a Schedule or Webhook in production.

### 2. Webhook → Real-time enrichment for CRM

```
Webhook (CRM "new lead") ─▶ Aidenix ─▶ HTTP Request (PATCH /crm/leads/{{id}})
```

Push fit score and personalized copy back into HubSpot / Pipedrive in seconds.

### 3. LinkedIn slug enrichment from form fills

```
Typeform Trigger ─▶ Aidenix (Query = ={{ $json.linkedin_url | extractSlug }}) ─▶ Slack (#sales)
```

Notify sales the moment a high-fit lead fills out a form.

## Error handling

The node maps Aidenix's HTTP responses into n8n's standard error flow:

| Code | Meaning                              | Node behavior                                                                  |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------ |
| 200  | Success                              | Body returned as-is.                                                           |
| 409  | `in_progress` — still computing      | **Auto-retry** with the same `Idempotency-Key`.                                |
| 504  | Timeout                              | **Auto-retry** with the same `Idempotency-Key`.                                |
| 422  | Body mismatch on a reused key        | Raised as `NodeApiError`.                                                       |
| 451  | Contact opted out / unavailable      | Raised as `NodeApiError`.                                                       |
| 402  | Quota exhausted                      | Raised as `NodeApiError`. Top up in the Aidenix dashboard.                      |
| 401  | Invalid or revoked token             | Raised as `NodeApiError`. Re-issue the token.                                   |

Enable **Continue On Fail** on the node to push errored items into the success branch as `{ error, query, idempotencyKey }` — useful for partial-success batch workflows.

## Idempotency & retries

The Aidenix API uses `Idempotency-Key` to deduplicate expensive AI runs. By default this node generates a deterministic key from `workflowId:executionId:itemIndex:query`, which means:

- **Re-running a failed execution** reuses the previously-computed result for free.
- **Running the same workflow on the same lead in a new execution** generates a *new* key — you'll get a fresh computation. This is usually what you want, since context (your ICP definition) may have changed.

To force a single deterministic key across executions (e.g. "score this lead once per day, regardless of how many times the workflow fires"), switch the strategy to **Custom** and supply your own:

```
={{ $json.email + ':' + $now.format('yyyy-MM-dd') }}
```

## Troubleshooting

**The node returns `409 in_progress` even after all retries.**
Increase **Max Retries** or **Retry Delay** in the node options. Large batches can occasionally exceed the default 10×5s window during peak load.

**`402 quota_exhausted`.**
Your plan has run out of credits — top up in the Aidenix dashboard. The node will surface this immediately rather than silently degrading.

**`401 unauthorized` after rotating the token.**
n8n credentials cache. Re-open the credential in n8n, paste the new token, save.

**The score looks wrong / outreach feels generic.**
Open a ticket at [aidenix.com](https://aidenix.com) — fit scoring is tied to your account's ICP definition, which is configured outside n8n.

**Base URL warning in execution logs.**
You've set Base URL to a non-loopback `http://` host. Switch to `https://` — the warning means the API token is being sent in cleartext.

## Compatibility

- **n8n**: tested on 1.x. Uses the v1 `INodeType` API.
- **Node.js**: 18.10+ (matches n8n's `engines` requirement).
- **Aidenix API**: this package is maintained alongside the API by the Aidenix team — versions are kept compatible.

## Resources & support

- **Aidenix** — [aidenix.com](https://aidenix.com)
- **API docs** — [aidenix.com/api](https://aidenix.com/api)
- **n8n community nodes guide** — [docs.n8n.io/integrations/community-nodes](https://docs.n8n.io/integrations/community-nodes/)
- **Issues & feature requests** — [GitHub issues](https://github.com/RosExpert/n8n-nodes-aidenix/issues)
- **Email** — [info@aidenix.com](mailto:info@aidenix.com)

## License

[MIT](./LICENSE.md) © Aidenix
