# GET /api/dashboard/overview

Returns the overview analytics block.

## Auth

- Authorization: Bearer <token>

## Response 200

```json
{
  "funnel": [
    { "label": "Joined", "count": 12042 },
    { "label": "Onboarded", "count": 8620 },
    { "label": "Wrote first log", "count": 6015 },
    { "label": "Logged this week", "count": 3211 },
    { "label": "Paying", "count": 682 }
  ],
  "stats": [
    {
      "title": "Total Users",
      "value": "12,042",
      "todayDelta": "+214 today",
      "weekDelta": "+1,122 this week",
      "trend": "up",
      "trendValue": 8.4,
      "sparklineData": [{ "index": 0, "value": 60 }],
      "tooltip": "Total registered users in Wisa.",
      "subtitle": ""
    }
  ],
  "userGrowth": [{ "date": "2026-05-01", "value": 120 }],
  "logsWritten": [{ "date": "2026-05-01", "value": 360 }],
  "insights": {
    "paretoShare": 68,
    "avgLogsPerUser": 9.6,
    "avgTimeToFirstLogHours": 31,
    "avgTimeToFirstLogTrend": -4.2,
    "inactiveBreakdown": {
      "oneToTwoWeeks": 721,
      "twoToFourWeeks": 418,
      "fourPlusWeeks": 305
    },
    "paywallNonPaymentRate": 74,
    "paywallNonPaymentCount": 432
  }
}
```
