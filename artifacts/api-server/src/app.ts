import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { startMonitor } from "./lib/monitor";
import { ensureTablesExist } from "@workspace/db";
import { cleanupExpiredLoginAttempts } from "./lib/auth";
import { startWatchdog } from "./lib/watchdog";
import { startDailyReportScheduler } from "./lib/findings";

const app: Express = express();

// Trust the single reverse-proxy hop in front of this server (Replit's router)
// so that req.ip resolves to the originating client IP via X-Forwarded-For.
app.set("trust proxy", 1);

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

// Only the published production service may send operational messages.
// Preview workflows and isolated task-agent environments use separate
// databases, so allowing their timers to run would duplicate every email.
const backgroundJobsEnabled = process.env.NODE_ENV === "production";

if (backgroundJobsEnabled) {
  // Starts independently of database migration so a DB outage can still be
  // reported directly through Graph mail.
  startWatchdog();
} else {
  logger.info(
    "Achtergrondbewaking uitgeschakeld buiten productie — voorkomt dubbele meldingen",
  );
}

// Run idempotent startup migration then start the background monitor.
// Both steps are non-blocking so the HTTP server comes up immediately.
ensureTablesExist()
  .then(() => {
    logger.info("Databaseschema geverifieerd");
    if (backgroundJobsEnabled) {
      startMonitor();
      startDailyReportScheduler();
    }
    // Periodically purge expired login-attempt rows (every 10 minutes).
    setInterval(() => {
      cleanupExpiredLoginAttempts().catch((err: unknown) => {
        logger.warn({ err }, "Periodieke login-opschoning mislukt");
      });
    }, 10 * 60 * 1000).unref();
  })
  .catch((err: unknown) => {
    logger.error({ err }, "Startmigratie mislukt — achtergrondmonitor niet gestart");
  });

export default app;
