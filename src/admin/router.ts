import { Router, Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { prisma } from "../lib/prisma";
import {
  startOfDay,
  endOfDay,
  subDays,
  format,
  parseISO,
  isValid,
} from "date-fns";
import { bot } from "../bot/index";
import { STORAGE_PRICE_LABEL } from "../bot/monetization";
import { sendWeeklyRecap } from "../services/scheduler";

const router = Router();

// ─── HTTP Basic Auth ──────────────────────────────────────────────────────────
function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const adminUser = process.env.ADMIN_USER ?? "admin";
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    res
      .status(500)
      .send(
        "ADMIN_PASSWORD environment variable is not set. Set it to enable admin access.",
      );
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Wisa Admin"');
    res.status(401).send("Authentication required");
    return;
  }

  const credentials = Buffer.from(authHeader.slice(6), "base64")
    .toString("utf8")
    .split(":");
  const user = credentials[0];
  const pass = credentials.slice(1).join(":"); // allow colons in password

  if (user !== adminUser || pass !== adminPass) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Wisa Admin"');
    res.status(401).send("Invalid credentials");
    return;
  }

  next();
}

router.use(basicAuth);

// ─── Serve Dashboard HTML ─────────────────────────────────────────────────────
router.get("/", (_req: Request, res: Response): void => {
  // Works in dev (tsx: __dirname = src/admin) and prod (compiled: dist/admin)
  const htmlPath = path.join(__dirname, "dashboard.html");
  if (!fs.existsSync(htmlPath)) {
    res.status(500).send("dashboard.html not found — check your build.");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(htmlPath);
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function handleError(res: Response, label: string, err: unknown): void {
  console.error(`[admin] ${label}:`, err);
  res.status(500).json({ error: `Failed to fetch ${label}` });
}

// ─── /api/stats ───────────────────────────────────────────────────────────────
router.get("/api/stats", async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Grab date from URL query (if it exists) to support the Analytics Date Picker
    const dateQuery = String(req.query.date ?? "");
    let targetDate = new Date();
    if (dateQuery) {
      const parsed = parseISO(dateQuery);
      if (isValid(parsed)) targetDate = parsed;
    }

    const dayStart = startOfDay(targetDate);
    const dayEnd = endOfDay(targetDate);
    const weekStart = subDays(targetDate, 7);

    const [
      totalUsers,
      proUsers,
      onboardedUsers,
      newUsersToday,
      newUsersThisWeek,
      totalLogs,
      logsToday,
      usersLoggedTodayRaw,
      voiceLogs,
      logsThisWeek,
      activeSubs,
      expiredSubs,
      cancelledSubs,
      pendingPayments,
      approvedPayments,
      rejectedPayments,
      pendingReminders,
      sentReminders,
      snoozedReminders,
      skippedReminders,
      totalPayments,
      activePayments,
      expiredPayments,
      cancelledPayments,
      paymentsThisWeek,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isPro: true } }),
      prisma.user.count({ where: { onboardingDone: true } }),
      prisma.user.count({
        where: { createdAt: { gte: dayStart, lte: dayEnd } },
      }),
      prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.log.count(),
      prisma.log.count({
        where: { logDate: { gte: dayStart, lte: dayEnd } },
      }),
      prisma.log.groupBy({
        by: ["userId"],
        where: { logDate: { gte: dayStart, lte: dayEnd } },
      }),
      prisma.log.count({ where: { isVoice: true } }),
      prisma.log.count({ where: { logDate: { gte: weekStart } } }),
      prisma.subscription.count({ where: { status: "active" } }),
      prisma.subscription.count({ where: { status: "expired" } }),
      prisma.subscription.count({ where: { status: "cancelled" } }),
      prisma.manualPayment.count({ where: { status: "pending" } }),
      prisma.manualPayment.count({ where: { status: "approved" } }),
      prisma.manualPayment.count({ where: { status: "rejected" } }),
      prisma.reminderJob.count({ where: { status: "pending" } }),
      prisma.reminderJob.count({ where: { status: "sent" } }),
      prisma.reminderJob.count({ where: { status: "snoozed" } }),
      prisma.reminderJob.count({ where: { status: "skipped" } }),
      prisma.subscription.count(),
      prisma.subscription.count({ where: { status: "active" } }),
      prisma.subscription.count({ where: { status: "expired" } }),
      prisma.subscription.count({ where: { status: "cancelled" } }),
      prisma.subscription.count({ where: { createdAt: { gte: weekStart } } }),
    ]);

    // 2. Fetch buckets heavily filtered by the requested specific day
    const reminderBucketRows = await prisma.reminderJob.groupBy({
      by: ["bucketSent"],
      where: { 
        bucketSent: { not: null },
        scheduledFor: { gte: dayStart, lte: dayEnd } // 👈 The Daily Analytics Fix
      },
      _count: { _all: true, convertedAt: true },
      orderBy: { bucketSent: "asc" },
    });

    const byBucket = reminderBucketRows.map((row) => ({
      bucket: row.bucketSent!,
      sent: row._count._all,
      converted: row._count.convertedAt,
      conversionRate: row._count._all ? (row._count.convertedAt / row._count._all) * 100 : 0,
    }));

    res.json({
      users: {
        total: totalUsers,
        pro: proUsers,
        free: totalUsers - proUsers,
        onboarded: onboardedUsers,
        newToday: newUsersToday,
        newThisWeek: newUsersThisWeek,
      },
      logs: {
        total: totalLogs,
        today: logsToday,
        usersLoggedToday: usersLoggedTodayRaw.length,
        voice: voiceLogs,
        thisWeek: logsThisWeek,
      },
      subscriptions: {
        active: activeSubs,
        expired: expiredSubs,
        cancelled: cancelledSubs,
      },
      payments: {
        total: totalPayments,
        active: activePayments,
        expired: expiredPayments,
        cancelled: cancelledPayments,
        thisWeek: paymentsThisWeek,
        planLabel: STORAGE_PRICE_LABEL,
      },
      reminders: {
        pending: pendingReminders,
        sent: sentReminders,
        snoozed: snoozedReminders,
        skipped: skippedReminders,
        byBucket,
      },
    });
  } catch (err) {
    handleError(res, "/api/stats", err);
  }
});

// ─── /api/payments ───────────────────────────────────────────────────────────
router.get(
  "/api/payments",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const status = String(req.query.status ?? "").trim();
      const search = String(req.query.search ?? "").trim().toLowerCase();
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10)));

      const subscriptions = await prisma.subscription.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              username: true,
              telegramId: true,
              paymentEmail: true,
              isPro: true,
              storageUnlocked: true,
            },
          },
        },
      });

      const filtered = subscriptions.filter((sub) => {
        if (status && sub.status !== status) return false;

        if (!search) return true;

        const haystack = [
          sub.paystackRef,
          sub.status,
          sub.user.firstName,
          sub.user.username ?? "",
          sub.user.paymentEmail ?? "",
          sub.user.telegramId.toString(),
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(search);
      });

      const total = filtered.length;
      const skip = (page - 1) * limit;
      const pageRows = filtered.slice(skip, skip + limit);

      res.json({
        data: pageRows.map((s) => ({
          id: s.id,
          userId: s.userId,
          paystackRef: s.paystackRef,
          status: s.status,
          startDate: s.startDate,
          endDate: s.endDate,
          createdAt: s.createdAt,
          updatedAt: s.createdAt,
          paymentMethod: "Paystack",
          amountLabel: STORAGE_PRICE_LABEL,
          user: {
            id: s.user.id,
            firstName: s.user.firstName,
            username: s.user.username,
            telegramId: s.user.telegramId.toString(),
            paymentEmail: s.user.paymentEmail,
            isPro: s.user.isPro,
            storageUnlocked: s.user.storageUnlocked,
          },
        })),
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/payments", err);
    }
  },
);

// ─── /api/users ───────────────────────────────────────────────────────────────
router.get("/api/users", async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10)));
    const search = String(req.query.search ?? "").trim();
    const sortBy = String(req.query.sortBy ?? "createdAt");
    const sortOrder = String(req.query.sortOrder ?? "desc") === "asc" ? "asc" : "desc";
    const skip = (page - 1) * limit;

    const where = search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { username: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    let orderBy: any = { createdAt: "desc" };
    if (sortBy === "logs") {
      orderBy = { logs: { _count: sortOrder } };
    } else if (sortBy === "firstName") {
      orderBy = { firstName: sortOrder };
    } else {
      orderBy = { createdAt: sortOrder };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          subscription: { select: { status: true, endDate: true } },
          _count: { select: { logs: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      data: users.map((u) => ({
        id: u.id,
        telegramId: u.telegramId.toString(),
        firstName: u.firstName,
        username: u.username,
        isPro: u.isPro,
        storageUnlocked: u.storageUnlocked,
        nextRenewalDate: u.nextRenewalDate,
        paymentEmail: u.paymentEmail,
        onboardingDone: u.onboardingDone,
        logFrequency: u.logFrequency,
        timezone: u.timezone,
        freeAiRefinements: u.freeAiRefinements,
        freeVoiceLogs: u.freeVoiceLogs,
        createdAt: u.createdAt,
        logCount: u.logCount,
        subscription: u.subscription
          ? { status: u.subscription.status, endDate: u.subscription.endDate }
          : null,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    handleError(res, "/api/users", err);
  }
});

// ─── /api/users/:id/logs ─────────────────────────────────────────────────────
router.get(
  "/api/users/:id/logs",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = parseInt(String(req.params.id), 10);
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = 10;
      const skip = (page - 1) * limit;

      const [logs, total, user] = await Promise.all([
        prisma.log.findMany({
          where: { userId },
          skip,
          take: limit,
          orderBy: { logDate: "desc" },
        }),
        prisma.log.count({ where: { userId } }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { firstName: true, username: true, telegramId: true },
        }),
      ]);

      res.json({
        user: user
          ? { ...user, telegramId: user.telegramId.toString() }
          : null,
        data: logs,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/users/:id/logs", err);
    }
  },
);

// ─── /api/logs/today ─────────────────────────────────────────────────────────
router.get(
  "/api/logs/today",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const todayStart = startOfDay(now);
      const todayEnd = endOfDay(now);

      const logs = await prisma.log.findMany({
        where: { logDate: { gte: todayStart, lte: todayEnd } },
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { firstName: true, username: true } },
        },
      });

      res.json({ data: logs, count: logs.length });
    } catch (err) {
      handleError(res, "/api/logs/today", err);
    }
  },
);

// ─── /api/logs ────────────────────────────────────────────────────────────────
router.get("/api/logs", async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const skip = (page - 1) * limit;

    const dateStr = String(req.query.date ?? "");
    const userIdStr = String(req.query.userId ?? "");

    const where: Record<string, unknown> = {};
    if (dateStr) {
      const d = parseISO(dateStr);
      if (isValid(d)) {
        where["logDate"] = { gte: startOfDay(d), lte: endOfDay(d) };
      }
    }
    if (userIdStr) {
      const uid = parseInt(userIdStr, 10);
      if (!isNaN(uid)) where["userId"] = uid;
    }

    const [logs, total] = await Promise.all([
      prisma.log.findMany({
        where,
        skip,
        take: limit,
        orderBy: { logDate: "desc" },
        include: {
          user: { select: { id: true, firstName: true, username: true } },
        },
      }),
      prisma.log.count({ where }),
    ]);

    res.json({ data: logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    handleError(res, "/api/logs", err);
  }
});

// ─── /api/at-risk-users ───────────────────────────────────────────────────────
router.get(
  "/api/at-risk-users",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const cutoff = subDays(startOfDay(new Date()), 3);

      // Users who are onboarded but have no log in the last 3 days
      const usersWithRecentLog = await prisma.log.groupBy({
        by: ["userId"],
        where: { logDate: { gte: cutoff } },
      });
      const recentUserIds = new Set(usersWithRecentLog.map((r) => r.userId));

      const atRiskUsers = await prisma.user.findMany({
        where: {
          onboardingDone: true,
          id: { notIn: [...recentUserIds] },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          logs: {
            orderBy: { logDate: "desc" },
            take: 1,
            select: { logDate: true },
          },
          _count: { select: { logs: true } },
        },
      });

      res.json({
        data: atRiskUsers.map((u) => ({
          id: u.id,
          telegramId: u.telegramId.toString(),
          firstName: u.firstName,
          username: u.username,
          isPro: u.isPro,
          logFrequency: u.logFrequency,
          logCount: u._count.logs,
          lastLogDate: u.logs[0]?.logDate ?? null,
          createdAt: u.createdAt,
        })),
      });
    } catch (err) {
      handleError(res, "/api/at-risk-users", err);
    }
  },
);

// ─── /api/chart/daily-logs ────────────────────────────────────────────────────
router.get(
  "/api/chart/daily-logs",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const days: Array<{ label: string; start: Date; end: Date }> = [];

      for (let i = 13; i >= 0; i--) {
        const d = subDays(now, i);
        days.push({
          label: format(d, "MMM d"),
          start: startOfDay(d),
          end: endOfDay(d),
        });
      }

      const counts = await Promise.all(
        days.map((d) =>
          prisma.log.count({ where: { logDate: { gte: d.start, lte: d.end } } }),
        ),
      );

      res.json({
        labels: days.map((d) => d.label),
        values: counts,
      });
    } catch (err) {
      handleError(res, "/api/chart/daily-logs", err);
    }
  },
);

// ─── /api/chart/user-growth ───────────────────────────────────────────────────
router.get(
  "/api/chart/user-growth",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const days: Array<{ label: string; start: Date; end: Date }> = [];

      for (let i = 13; i >= 0; i--) {
        const d = subDays(now, i);
        days.push({
          label: format(d, "MMM d"),
          start: startOfDay(d),
          end: endOfDay(d),
        });
      }

      const counts = await Promise.all(
        days.map((d) =>
          prisma.user.count({
            where: { createdAt: { gte: d.start, lte: d.end } },
          }),
        ),
      );

      res.json({
        labels: days.map((d) => d.label),
        values: counts,
      });
    } catch (err) {
      handleError(res, "/api/chart/user-growth", err);
    }
  },
);

// ─── /api/manual-payments ─────────────────────────────────────────────────────
router.get(
  "/api/manual-payments",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const status = String(req.query.status ?? "");
      const where = status ? { status } : {};

      const payments = await prisma.manualPayment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              username: true,
              telegramId: true,
              isPro: true,
            },
          },
        },
      });

      res.json({
        data: payments.map((p) => ({
          ...p,
          user: { ...p.user, telegramId: p.user.telegramId.toString() },
        })),
      });
    } catch (err) {
      handleError(res, "/api/manual-payments", err);
    }
  },
);

// ─── POST /api/manual-payments/:id/approve ───────────────────────────────────
router.post(
  "/api/manual-payments/:id/approve",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid payment ID" });
        return;
      }

      const payment = await prisma.manualPayment.findUnique({
        where: { id },
        include: { user: true },
      });

      if (!payment) {
        res.status(404).json({ error: "Payment not found" });
        return;
      }

      if (payment.status !== "pending") {
        res
          .status(409)
          .json({ error: `Payment is already ${payment.status}` });
        return;
      }

      await prisma.$transaction([
        prisma.manualPayment.update({
          where: { id },
          data: { status: "approved" },
        }),
        prisma.user.update({
          where: { id: payment.userId },
          data: {
            isPro: true,
            storageUnlocked: true,
            nextRenewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        }),
      ]);

      console.log(
        `[admin] Manual payment #${id} approved. User ${payment.userId} => isPro=true`,
      );
      res.json({ success: true, message: "Payment approved and user upgraded to Pro." });
    } catch (err) {
      handleError(res, "/api/manual-payments/:id/approve", err);
    }
  },
);

// ─── POST /api/manual-payments/:id/reject ────────────────────────────────────
router.post(
  "/api/manual-payments/:id/reject",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid payment ID" });
        return;
      }

      const payment = await prisma.manualPayment.findUnique({ where: { id } });

      if (!payment) {
        res.status(404).json({ error: "Payment not found" });
        return;
      }

      if (payment.status !== "pending") {
        res
          .status(409)
          .json({ error: `Payment is already ${payment.status}` });
        return;
      }

      await prisma.manualPayment.update({
        where: { id },
        data: { status: "rejected" },
      });

      console.log(`[admin] Manual payment #${id} rejected.`);
      res.json({ success: true, message: "Payment rejected." });
    } catch (err) {
      handleError(res, "/api/manual-payments/:id/reject", err);
    }
  },
);

// ─── /api/reminders ───────────────────────────────────────────────────────────
router.get(
  "/api/reminders",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = 25;
      const skip = (page - 1) * limit;
      const status = String(req.query.status ?? "");
      const where = status ? { status } : {};

      const [jobs, total] = await Promise.all([
        prisma.reminderJob.findMany({
          where,
          skip,
          take: limit,
          orderBy: { scheduledFor: "desc" },
        }),
        prisma.reminderJob.count({ where }),
      ]);

      // Attach user first names in bulk
      const userIds = [...new Set(jobs.map((j) => j.userId))];
      const usersMap = await prisma.user
        .findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, username: true },
        })
        .then((users) =>
          Object.fromEntries(users.map((u) => [u.id, u])),
        );

      res.json({
        data: jobs.map((j) => ({
          ...j,
          telegramId: j.telegramId.toString(),
          user: usersMap[j.userId] ?? null,
        })),
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/reminders", err);
    }
  },
);

// ─── /api/replay/sessions — list all user sessions ────────────────────────
router.get(
  "/api/replay/sessions",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10)));
      const search = String(req.query.search ?? "").trim();
      const offset = (page - 1) * limit;

      // Step 1: Get latest event per user (subquery-style via raw SQL for performance)
      const sessionsRaw: Array<{
        telegramId: bigint;
        latestTimestamp: Date;
        eventCount: bigint;
        errorCount: bigint;
      }> = await prisma.$queryRaw`
        SELECT
          "telegramId",
          MAX("timestamp") AS "latestTimestamp",
          COUNT(*)::bigint AS "eventCount",
          COUNT(*) FILTER (WHERE "eventType" = 'error')::bigint AS "errorCount"
        FROM "ReplayEvent"
        GROUP BY "telegramId"
        ORDER BY MAX("timestamp") DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      // Step 2: Enrich with user info
      const telegramIds = sessionsRaw.map((s) => s.telegramId);
      const users = await prisma.user.findMany({
        where: { telegramId: { in: telegramIds } },
        select: {
          telegramId: true,
          firstName: true,
          username: true,
          isPro: true,
        },
      });
      const userMap = new Map(users.map((u) => [u.telegramId.toString(), u]));

      // Step 3: Get the latest message preview for each user
      const previews = await Promise.all(
        telegramIds.map(async (tid) => {
          const latest = await prisma.replayEvent.findFirst({
            where: { telegramId: tid },
            orderBy: { timestamp: "desc" },
            select: { eventType: true, payload: true },
          });
          if (!latest) return { tid: tid.toString(), preview: "" };

          try {
            const p = JSON.parse(latest.payload);
            let preview = "";
            switch (latest.eventType) {
              case "user_message":
                preview = p.text?.slice(0, 80) ?? "";
                break;
              case "bot_message":
                preview = p.text?.slice(0, 80) ?? "";
                break;
              case "user_callback":
                preview = `Tapped: ${p.buttonLabel ?? p.data}`;
                break;
              case "error":
                preview = `⚠️ ${p.errorMessage?.slice(0, 60)}`;
                break;
              default:
                preview = latest.eventType;
            }
            return { tid: tid.toString(), preview };
          } catch {
            return { tid: tid.toString(), preview: latest.eventType };
          }
        }),
      );
      const previewMap = new Map(previews.map((p) => [p.tid, p.preview]));

      // Step 4: Get total count for pagination
      const totalRaw: Array<{ count: bigint }> = await prisma.$queryRaw`
        SELECT COUNT(DISTINCT "telegramId")::bigint AS count FROM "ReplayEvent"
      `;
      const total = Number(totalRaw[0]?.count ?? 0);

      // Step 5: Build response
      const data = sessionsRaw.map((s) => {
        const user = userMap.get(s.telegramId.toString());
        return {
          telegramId: s.telegramId.toString(),
          firstName: user?.firstName ?? "Unknown",
          username: user?.username ?? null,
          isPro: user?.isPro ?? false,
          lastActivity: s.latestTimestamp,
          eventCount: Number(s.eventCount),
          errorCount: Number(s.errorCount),
          preview: previewMap.get(s.telegramId.toString()) ?? "",
        };
      });

      // Optional: filter by search term (post-query — fine for <10k users)
      const filtered = search
        ? data.filter(
            (d) =>
              d.firstName.toLowerCase().includes(search.toLowerCase()) ||
              (d.username?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
              d.telegramId.includes(search),
          )
        : data;

      res.json({
        data: filtered,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/replay/sessions", err);
    }
  },
);

// ─── /api/replay/events/:telegramId — get events for replay ──────────────
router.get(
  "/api/replay/events/:telegramId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const telegramId = BigInt(String(req.params.telegramId));
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10)));
      const skip = (page - 1) * limit;
      const order = req.query.order === "desc" ? "desc" : "asc";

      // Optional date range filter
      const afterStr = String(req.query.after ?? "");
      const beforeStr = String(req.query.before ?? "");
      const where: Record<string, unknown> = { telegramId };

      if (afterStr || beforeStr) {
        const timestampFilter: Record<string, Date> = {};
        if (afterStr) timestampFilter.gte = new Date(afterStr);
        if (beforeStr) timestampFilter.lte = new Date(beforeStr);
        where.timestamp = timestampFilter;
      }

      // Optional event type filter
      const eventType = String(req.query.eventType ?? "");
      if (eventType) {
        where.eventType = eventType;
      }

      const [events, total] = await Promise.all([
        prisma.replayEvent.findMany({
          where,
          skip,
          take: limit,
          orderBy: { timestamp: order as "asc" | "desc" },
        }),
        prisma.replayEvent.count({ where }),
      ]);

      // Get user info
      const user = await prisma.user.findUnique({
        where: { telegramId },
        select: {
          firstName: true,
          username: true,
          isPro: true,
          createdAt: true,
          logFrequency: true,
          timezone: true,
        },
      });

      res.json({
        user: user
          ? { ...user, telegramId: telegramId.toString() }
          : { telegramId: telegramId.toString() },
        data: events.map((e) => {
          let parsedPayload: unknown;
          try {
            parsedPayload = JSON.parse(e.payload);
          } catch {
            parsedPayload = { raw: e.payload };
          }
          return {
            id: e.id,
            eventType: e.eventType,
            direction: e.direction,
            payload: parsedPayload,
            timestamp: e.timestamp,
          };
        }),
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/replay/events/:telegramId", err);
    }
  },
);

// ─── /api/replay/stats — replay system stats ─────────────────────────────
router.get(
  "/api/replay/stats",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const todayStart = startOfDay(now);

      const [totalEvents, totalSessions, eventsToday, errorsToday] = await Promise.all([
        prisma.replayEvent.count(),
        prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(DISTINCT "telegramId")::bigint AS count FROM "ReplayEvent"
        `.then((r) => Number(r[0]?.count ?? 0)),
        prisma.replayEvent.count({
          where: { timestamp: { gte: todayStart } },
        }),
        prisma.replayEvent.count({
          where: { eventType: "error", timestamp: { gte: todayStart } },
        }),
      ]);

      res.json({
        totalEvents,
        totalSessions,
        eventsToday,
        errorsToday,
      });
    } catch (err) {
      handleError(res, "/api/replay/stats", err);
    }
  },
);

// ─── POST /api/trigger-recap — manually fire the Saturday weekly recap ──────
// Useful for testing or if the server was down when the cron fired.
router.post(
  "/api/trigger-recap",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await sendWeeklyRecap(bot);
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, "trigger-recap", err);
    }
  },
);

export { router as adminRouter };