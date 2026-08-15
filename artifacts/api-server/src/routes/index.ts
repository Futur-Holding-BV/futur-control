import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reposRouter from "./repos";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reposRouter);

export default router;
