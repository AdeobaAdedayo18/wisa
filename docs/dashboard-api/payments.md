# GET /api/dashboard/payments

Returns subscription revenue analytics.

## Auth

- Authorization: Bearer <token>

## Response 200

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
