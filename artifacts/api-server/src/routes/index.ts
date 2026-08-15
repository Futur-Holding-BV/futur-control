import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import reposRouter from "./repos";
import notificationsRouter from "./notifications";
import expiryRouter from "./expiry";
import actionsRouter from "./actions";
import { requireAuth } from "../lib/auth.js";

const router: IRouter = Router();

// Public: health check and login. Everything below requireAuth needs a session.
router.use(healthRouter);
router.use(authRouter);
router.use(requireAuth);
router.use(reposRouter);
router.use(notificationsRouter);
router.use(expiryRouter);
router.use(actionsRouter);

export default router;
