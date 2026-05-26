# GET /api/dashboard/features?category=messaging|ai-refinement|catch-up

Returns feature analytics for a given category.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
{
  "category": "messaging",
  "metrics": [
    { "label": "Prompt completion rate", "value": "68%", "trend": 4.2 }
  ],
  "insights": [
    { "title": "Best prompt window", "description": "7-9PM drives the most completed prompts." }
  ],
  "timeline": [
    { "date": "2026-05-01", "value": 42 }
  ]
}
```
