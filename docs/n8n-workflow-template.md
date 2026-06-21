# n8n Workflow Template for AutoEdit AI

This document shows how to receive AutoEdit AI backend events in n8n. The integration is backend-only: connect a webhook URL with `POST /api/integrations/n8n/connect`, then AutoEdit sends best-effort event payloads after project, upload, transcript, and render events.

## Minimal Workflow

Create a two-node n8n workflow:

1. Webhook
2. Respond to Webhook

Webhook node:

- Method: `POST`
- Path: `autoedit-events`
- Response mode: `Using Respond to Webhook node`

Respond to Webhook node:

- Status code: `200`
- Body:

```json
{
  "ok": true
}
```

Connect AutoEdit to the webhook URL:

```json
{
  "webhookUrl": "http://localhost:5678/webhook/autoedit-events",
  "workflowName": "AutoEdit events",
  "signingSecret": "local-development-secret"
}
```

Do not commit real signing secrets.

## Event Payload

AutoEdit sends one consistent JSON object:

```json
{
  "eventType": "render.completed",
  "projectId": "project-id",
  "userId": "user-id",
  "assetId": "asset-id",
  "renderId": "render-id",
  "renderFormat": "short",
  "renderUrl": "https://signed-output-url",
  "projectTitle": "Launch video",
  "timestamp": "2026-06-21T12:00:00.000Z",
  "metadata": {}
}
```

Supported events:

- `project.created`
- `upload.completed`
- `transcript.completed`
- `render.completed`
- `render.failed`

If a signing secret is configured, AutoEdit sends:

```text
X-AutoEdit-Signature: <hmac-sha256>
```

The signature is HMAC SHA-256 of the raw JSON request body using the connected signing secret.

## Example 1: Render Completed Notification

Goal: send a Discord or Telegram message when a render finishes.

Workflow:

```text
Webhook -> IF eventType equals render.completed -> Discord/Telegram -> Respond to Webhook
```

Message example:

```text
AutoEdit render completed
Title: {{$json.projectTitle}}
Format: {{$json.renderFormat}}
URL: {{$json.renderUrl}}
```

For a free local test, replace Discord/Telegram with a Set node and inspect the execution output.

## Example 2: Save Render Link to Google Sheets

Goal: append completed render metadata to a spreadsheet.

Workflow:

```text
Webhook -> IF eventType equals render.completed -> Google Sheets Append Row -> Respond to Webhook
```

Suggested columns:

- `timestamp`
- `projectTitle`
- `projectId`
- `renderId`
- `renderFormat`
- `renderUrl`

For a no-paid-service test, use a local file, a Set node, or n8n execution data instead of Google Sheets.

## Example 3: Upload Metadata to Notion

Goal: create a Notion page for each completed render.

Workflow:

```text
Webhook -> IF eventType equals render.completed -> Notion Create Page -> Respond to Webhook
```

Suggested page fields:

- Name: `{{$json.projectTitle}}`
- Status: `Rendered`
- Format: `{{$json.renderFormat}}`
- Video URL: `{{$json.renderUrl}}`

For a free test, use the n8n Manual Trigger or Set node to confirm the mapping before connecting Notion.

## Example 4: Render Failed Alert

Goal: alert immediately when rendering fails.

Workflow:

```text
Webhook -> IF eventType equals render.failed -> Discord/Telegram/Email -> Respond to Webhook
```

Message example:

```text
AutoEdit render failed
Title: {{$json.projectTitle}}
Project: {{$json.projectId}}
Render: {{$json.renderId}}
Error: {{$json.metadata.error}}
```

AutoEdit dispatch is best-effort. A failed n8n workflow is logged but does not fail the main video pipeline.

## Local Test Command

After connecting n8n for a user, run:

```powershell
cd apps/api
npm run test:n8n-webhook
```

Optional user filter:

```powershell
$env:N8N_TEST_USER_EMAIL="user@example.com"
npm run test:n8n-webhook
```

The command prints event status and response code only. It does not print webhook secrets or signing secrets.

