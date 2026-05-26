# GET /api/dashboard/campaigns

Returns the campaign list.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
[
  {
    "id": "campaign-1",
    "name": "Re-engagement 1",
    "segment": "inactive-1-2",
    "scheduledFor": "2026-05-30",
    "status": "scheduled",
    "sentCount": 120
  }
]
```
