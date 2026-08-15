import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { startMonitor } from "./lib/monitor";
import { ensureTablesExist } from "@workspace/db";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Run idempotent startup migration then start the background monitor.
// Both steps are non-blocking so the HTTP server comes up immediately.
ensureTablesExist()
  .then(() => {
    logger.info("Databaseschema geverifieerd");
    startMonitor();
  })
  .catch((err: unknown) => {
    logger.error({ err }, "Startmigratie mislukt — achtergrondmonitor niet gestart");
  });

export default app;
