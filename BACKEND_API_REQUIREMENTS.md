# Wisa Admin Dashboard - Backend API Requirements

This document lists the frontend data needs inferred from src/api and src/hooks. It is a contract checklist for the backend.

## Global
- Base URL: configured via env (see axios instance).
- Auth: Bearer token in Authorization header (if available).
- Content-Type: application/json.

## 1) Overview
**Query key:** overview (refetch every 5 minutes)

**Endpoint:** GET /overview

**Response shape:**
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
      "subtitle": "optional"
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

Notes:
- `trend` is "up" | "down" | "neutral".
- `value` is rendered as a string for display.

## 2) Users
**Query key:** users

**Endpoint:** GET /users

**Response shape:**
```json
[
  {
    "id": "user-1",
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
        "id": "log-1",
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

Notes:
- `plan` is "free" | "pro".
- `recentLogs` is used in the user detail modal (10 latest entries).

## 3) Logs
**Query key:** logs (refetch every 60 seconds)

**Endpoint:** GET /logs

**Response shape:**
```json
[
  {
    "id": "log-1",
    "userId": "user-1",
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

Notes:
- Used for both Today Logs and All Logs.
- `submittedFor` is used to flag catch-up logs when different from `createdAt`.

## 4) Reminders
**Query key:** reminders

**Endpoint:** GET /reminders

**Response shape:**
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

Notes:
- `status` is "sent" | "skipped" | "snoozed" | "converted".

## 5) Payments
**Query key:** payments

**Endpoint:** GET /payments

**Response shape:**
```json
{
  "revenue": {
    "totalRevenue": 8240000,
    "revenueThisMonth": 740000,
    "revenueThisMonthChange": 12.4,
    "revenueThisWeek": 182000,
    "revenueThisWeekChange": 6.2,
    "avgDaysToFirstPayment": 9.4
  },
  "mrr": [
    { "month": "May 2026", "value": 120000 },
    { "month": "Jun 2026", "value": 129600, "projected": true }
  ],
  "churnRate": 4.8,
  "churnedUsers": [
    {
      "id": "churn-1",
      "userName": "User 1",
      "username": "user_1",
      "planEndDate": "2026-05-10",
      "logsBeforeChurn": 18,
      "proDays": 60
    }
  ],
  "transactions": [
    {
      "id": "txn-1",
      "userName": "User 1",
      "username": "user_1",
      "amount": 3500,
      "method": "paystack",
      "date": "2026-05-20",
      "status": "active"
    }
  ]
}
```

Notes:
- `method` is "paystack" | "bank-transfer".
- `status` is "active" | "expired" | "cancelled".

## 6) Sessions (Session Replay)
**Query key:** sessions

**Endpoint:** GET /sessions

**Response shape:**
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

Notes:
- `sender` is "user" | "assistant".

## 7) Feature Analytics
**Query key:** features + category

**Endpoint:** GET /features?category=messaging|ai-refinement|catch-up

**Response shape:**
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

## 8) Campaigns
**Query key:** campaigns

**Endpoint:** GET /campaigns

**Response shape:**
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

Notes:
- `segment` is "inactive-1-2" | "inactive-2-4" | "inactive-4-plus" | "hit-paywall" | "custom".
- `status` is "draft" | "scheduled" | "sent".
