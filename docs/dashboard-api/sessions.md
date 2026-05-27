# GET /api/dashboard/sessions

Returns session replay summaries with full message lists.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
[
  {
    "summary": {
      "id": "session-1",
      "userName": "User 1",
      "username": "user_1",
      "lastActive": "2026-05-20T18:00:00Z",
      "totalMessages": 18,
      "highlights": "Mentioned a tough day and asked for encouragement."
    },
    "messages": [
      {
        "id": "msg-1",
        "sender": "user",
        "content": "I am trying to keep the streak going but today felt heavy.",
        "timestamp": "2026-05-20T18:10:00Z"
      }
    ]
  }
]
```
