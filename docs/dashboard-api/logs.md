# GET /api/dashboard/logs

Returns all logs with user metadata.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
[
  {
    "id": "log-1",
    "userId": "1",
    "userName": "User 1",
    "username": "user_1",
    "telegramId": "TG-120000",
    "createdAt": "2026-05-20",
    "submittedFor": "2026-05-16",
    "type": "voice",
    "preview": "Today felt like a reset...",
    "refined": true,
    "originalContent": "Full original content...",
    "refinedContent": "Full refined content..."
  }
]
```
