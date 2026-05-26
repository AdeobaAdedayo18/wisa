# GET /api/dashboard/reminders

Returns reminder stats and the reminder list.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
{
  "stats": {
    "sent": 1200,
    "skipped": 210,
    "snoozed": 134,
    "converted": 480
  },
  "timeEffectiveness": [
    { "time": "6PM", "conversionRate": 24 }
  ],
  "reminders": [
    {
      "id": "reminder-1",
      "userName": "User 1",
      "username": "user_1",
      "reminderTime": "8PM",
      "status": "converted",
      "snoozeCount": 1,
      "date": "2026-05-20"
    }
  ]
}
```
