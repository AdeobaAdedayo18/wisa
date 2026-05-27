import { Router } from "express";
import { dashboardCors } from "../middleware/cors";
import { requireDashboardAuth } from "../middleware/auth";
import { login } from "../controllers/authController";
import { overview } from "../controllers/overviewController";
import { users } from "../controllers/usersController";
import { logs } from "../controllers/logsController";
import { reminders } from "../controllers/remindersController";
import { payments } from "../controllers/paymentsController";
import { sessions } from "../controllers/sessionsController";
import { features } from "../controllers/featuresController";
import { campaigns } from "../controllers/campaignsController";

const router = Router();

router.use(dashboardCors);
router.post("/auth/login", login);

router.use(requireDashboardAuth);
router.get("/overview", overview);
router.get("/users", users);
router.get("/logs", logs);
router.get("/reminders", reminders);
router.get("/payments", payments);
router.get("/sessions", sessions);
router.get("/features", features);
router.get("/campaigns", campaigns);

export { router as dashboardRouter };
