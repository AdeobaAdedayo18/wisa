# GET /api/dashboard/users

Returns the user list with recent logs and reminder stats.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
[
  {
    "id": "1",
    "name": "User 1",
    "username": "user_1",
    "telegramId": "TG-100000",
    "plan": "free",
    "logs": 12,
    "onboarded": true,
    "lastActive": "2026-05-20",
    "joined": "2026-02-14",
    "hitPaywall": false,
    "reminderStats": { "received": 24, "skipped": 3, "actedOn": 8 },
    "recentLogs": [
      {
        "id": "10",
        "date": "2026-05-20",
        "type": "text",
        "preview": "Today I focused on momentum...",
        "refined": true,
        "content": "Full log content..."
      }
    ]
  }
]
```
