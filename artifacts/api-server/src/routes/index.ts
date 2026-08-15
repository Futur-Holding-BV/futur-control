import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reposRouter from "./repos";
import notificationsRouter from "./notifications";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reposRouter);
router.use(notificationsRouter);

export default router;
