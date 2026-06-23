# n8n Auto-Publishing Workflows

AutoEdit AI can send `render.completed` events to a connected n8n webhook after each rendered output is uploaded to S3.

This document focuses on practical starter workflows. It does not require Claude, paid AI, or public S3 buckets.

## Render Completed Payload

The publishing-ready payload includes:

```json
{
  "eventType": "render.completed",
  "projectId": "project-id",
  "userId": "user-id",
  "renderId": "render-id",
  "renderFormat": "short",
  "outputS3Key": "renders/project-id/render-id-short.mp4",
  "renderUrl": "https://presigned-s3-download-url",
  "renderUrlExpiresAt": "2026-06-23T12:00:00.000Z",
  "expiresInSeconds": 3600,
  "projectTitle": "Launch video",
  "createdAt": "2026-06-23T11:00:00.000Z",
  "timestamp": "2026-06-23T11:00:00.000Z",
  "metadata": {
    "outputS3Key": "renders/project-id/render-id-short.mp4"
  }
}
```

`renderUrl` is a presigned S3 URL. The bucket stays private. The URL expires according to `S3_PRESIGN_TTL`, so n8n workflows should download or forward the render soon after receiving the event.

If a signing secret is configured, AutoEdit sends:

```text
X-AutoEdit-Signature: <hmac-sha256>
```

The signature is calculated over the raw JSON request body.

## Template 1: Discord Notification

Workflow:

```text
Webhook -> IF eventType equals render.completed -> Discord -> Respond to Webhook
```

Discord message:

```text
AutoEdit render completed
Title: {{$json.projectTitle}}
Format: {{$json.renderFormat}}
Download: {{$json.renderUrl}}
Expires: {{$json.renderUrlExpiresAt}}
```

You can also use an HTTP Request node to call a Discord webhook URL.

## Template 2: Google Drive Save

Workflow:

```text
Webhook -> IF eventType equals render.completed -> HTTP Request download renderUrl -> Google Drive upload -> Respond to Webhook
```

HTTP Request node:

- Method: `GET`
- URL: `{{$json.renderUrl}}`
- Response format: file/binary data

Google Drive node:

- Operation: upload
- File name: `{{$json.projectTitle}}-{{$json.renderFormat}}.mp4`

Google Drive requires Google OAuth credentials configured inside n8n.

## Template 3: Google Sheets Log

Workflow:

```text
Webhook -> IF eventType equals render.completed -> Google Sheets append row -> Respond to Webhook
```

Suggested columns:

- `projectTitle`: `{{$json.projectTitle}}`
- `renderFormat`: `{{$json.renderFormat}}`
- `renderUrl`: `{{$json.renderUrl}}`
- `renderUrlExpiresAt`: `{{$json.renderUrlExpiresAt}}`
- `outputS3Key`: `{{$json.outputS3Key}}`
- `timestamp`: `{{$json.timestamp}}`

Google Sheets requires Google OAuth credentials configured inside n8n.

## Template 4: Telegram Notification

Workflow:

```text
Webhook -> IF eventType equals render.completed -> Telegram send message -> Respond to Webhook
```

Telegram message:

```text
AutoEdit render ready: {{$json.projectTitle}}
Format: {{$json.renderFormat}}
Download: {{$json.renderUrl}}
```

Telegram requires a bot token configured inside n8n.

## Template 5: YouTube Publishing Notes

Workflow:

```text
Webhook -> IF eventType equals render.completed -> HTTP Request download renderUrl -> YouTube upload -> Respond to Webhook
```

YouTube publishing requires Google OAuth/API credentials inside n8n and a channel with upload permissions.

Recommended first test:

1. Download `renderUrl` with an HTTP Request node.
2. Confirm binary data is present.
3. Upload as an unlisted/private test video.

## Platform Caveats

- YouTube requires Google OAuth/API credentials inside n8n.
- TikTok and Instagram publishing may require platform API access, app review, or business account approvals.
- Discord, Telegram, and Google Sheets are easier first workflows.
- Presigned URLs expire, so workflows should download quickly.
- Store `outputS3Key` in logs when you need a durable backend reference.

## Local Webhook Test

Use a simple n8n workflow:

```text
Webhook -> Respond to Webhook
```

Then connect the webhook through AutoEdit's n8n connector and run a render. Confirm n8n receives:

- `eventType`
- `projectId`
- `renderId`
- `renderFormat`
- `outputS3Key`
- `renderUrl`
- `timestamp`
- `X-AutoEdit-Signature` when a signing secret is configured
