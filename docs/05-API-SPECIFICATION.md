# 05 — API Specification

Base path: `/api/v1`. JSON request/response unless noted. Use a consistent envelope and stable error codes.

## Authentication

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/refresh`
- `GET /auth/me`
  Use secure, HttpOnly, SameSite cookies where applicable. Add CSRF protection for cookie-authenticated state changes.

## Workspaces

- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/:workspaceId`
- `PATCH /workspaces/:workspaceId`

## Projects

- `GET /workspaces/:workspaceId/projects`
- `POST /workspaces/:workspaceId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`
- `DELETE /projects/:projectId`
- `POST /projects/:projectId/duplicate`
- `POST /projects/:projectId/versions`

## Segments

- `POST /projects/:projectId/segments`
- `PATCH /segments/:segmentId`
- `DELETE /segments/:segmentId`
- `POST /projects/:projectId/segments/reorder`
- `POST /segments/:segmentId/preview`
- `POST /segments/:segmentId/render`

## Engine and voice catalog

- `GET /engines`
- `GET /engines/:engineId`
- `GET /voices?locale=en-US&engineId=espeak`
- `GET /voices/:voiceId`
- `GET /voices/:voiceId/capabilities`
- `GET /voices/:voiceId/sample` (only if a real approved sample exists)

## Presets and pronunciation

- `GET /presets`
- `POST /presets`
- `PATCH /presets/:presetId`
- `DELETE /presets/:presetId`
- `GET /pronunciation-entries`
- `POST /pronunciation-entries`
- `PATCH /pronunciation-entries/:entryId`
- `DELETE /pronunciation-entries/:entryId`
- `POST /pronunciation-entries/import`
- `GET /pronunciation-entries/export`

## Render and assets

- `POST /projects/:projectId/render`
- `GET /render-jobs/:jobId`
- `POST /render-jobs/:jobId/retry`
- `POST /render-jobs/:jobId/cancel`
- `GET /assets/:assetId`
- `GET /assets/:assetId/download`
- `POST /projects/:projectId/export`

## Events

- `GET /events/render-jobs` via SSE, authorized per user/workspace.
  Events: `job.queued`, `job.started`, `job.progress`, `job.succeeded`, `job.failed`, `job.cancelled`.

## Example preview request

```json
{
  "text": "Hello, welcome to VoxStudio.",
  "locale": "en",
  "engineId": "espeak",
  "voiceId": "validated-voice-id",
  "settings": {
    "speed": 1,
    "pitch": 1,
    "volume": 1
  },
  "output": { "format": "wav", "sampleRate": 22050 }
}
```

## Example render request

```json
{
  "revision": 12,
  "outputProfile": {
    "format": "wav",
    "sampleRate": 44100,
    "channels": 1,
    "bitDepth": 16
  }
}
```

## Response conventions

Success:

```json
{ "data": {}, "meta": { "requestId": "..." } }
```

Error:

```json
{
  "error": {
    "code": "VOICE_LOCALE_UNSUPPORTED",
    "message": "The selected voice does not support this locale.",
    "details": {}
  },
  "meta": { "requestId": "..." }
}
```

## Validation and behavior

- Validate DTOs on server; client validation is supplementary.
- Reject unknown settings and out-of-range values.
- Return 409 on stale revision where appropriate.
- Return 413 for oversized payloads.
- Return 429 for rate/queue limits.
- Do not return filesystem paths or internal command output.
- Downloads must verify ownership and use safe content disposition.
- All resource IDs must be authorized, not merely syntactically valid.
- Preview endpoints need strict text length, concurrency, and timeout limits.
