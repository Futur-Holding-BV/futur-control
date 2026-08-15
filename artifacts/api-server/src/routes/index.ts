import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reposRouter from "./repos";
import notificationsRouter from "./notifications";
import expiryRouter from "./expiry";
import actionsRouter from "./actions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reposRouter);
router.use(notificationsRouter);
router.use(expiryRouter);
router.use(actionsRouter);

export default router;
