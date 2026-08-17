import { Router, type IRouter } from "express";
import {
  ListReposResponse,
  GetRepoDetailResponse,
  GetRepoSettingsResponse,
  UpdateRepoSettingsResponse,
} from "@workspace/api-zod";
import {
  listMonitoredRepos,
  repoSummary,
  repoDetail,
  GitHubError,
  invalidateRepoCache,
} from "../lib/github";
import { getRepoThresholds, saveRepoThresholds } from "../lib/staleness";

const router: IRouter = Router();

router.get("/repos", async (req, res): Promise<void> => {
  const bypass = req.query["refresh"] === "true";
  try {
    const repos = await listMonitoredRepos();
    const summaries = await Promise.all(repos.map((name) => repoSummary(name, bypass)));
    res.json(ListReposResponse.parse(summaries));
  } catch (err) {
    req.log.error({ err }, "Ophalen van repositories mislukt");
    const status = err instanceof GitHubError ? 502 : 502;
    res.status(status).json({
      error:
        "Kon de gegevens niet ophalen bij GitHub. Controleer het token en probeer het opnieuw.",
    });
  }
});

router.get("/repos/:name/detail", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name)
    ? req.params.name[0]
    : req.params.name;

  const bypass = req.query["refresh"] === "true";
  try {
    const repos = await listMonitoredRepos();
    const name = repos.find((r) => r === raw);
    if (!name) {
      res.status(404).json({ error: "Deze codebase wordt niet bewaakt." });
      return;
    }

    const detail = await repoDetail(name, bypass);
    res.json(GetRepoDetailResponse.parse(detail));
  } catch (err) {
    req.log.error({ err, repo: raw }, "Ophalen van repositorydetail mislukt");
    res.status(502).json({
      error:
        "Kon de details niet ophalen bij GitHub. Probeer het zo opnieuw.",
    });
  }
});

function repoParam(req: { params: { name: string | string[] } }): string {
  return Array.isArray(req.params.name) ? req.params.name[0]! : req.params.name;
}

router.get("/repos/:name/settings", async (req, res): Promise<void> => {
  const raw = repoParam(req);
  try {
    const repos = await listMonitoredRepos();
    if (!repos.includes(raw)) {
      res.status(404).json({ error: "Deze codebase wordt niet bewaakt." });
      return;
    }
    const thresholds = await getRepoThresholds(raw);
    res.json(GetRepoSettingsResponse.parse({ repo: raw, ...thresholds }));
  } catch (err) {
    req.log.error({ err, repo: raw }, "Ophalen van instellingen mislukt");
    res.status(502).json({ error: "Kon de instellingen niet ophalen. Probeer het zo opnieuw." });
  }
});

router.put("/repos/:name/settings", async (req, res): Promise<void> => {
  const raw = repoParam(req);
  const body = req.body as { staleYellowDays?: unknown; staleRedDays?: unknown };
  const yellow = Number(body?.staleYellowDays);
  const red = Number(body?.staleRedDays);

  if (
    !Number.isInteger(yellow) ||
    !Number.isInteger(red) ||
    yellow < 1 ||
    red < 1 ||
    yellow > 3650 ||
    red > 3650
  ) {
    res.status(400).json({
      error: "Vul hele aantallen dagen in (minimaal 1, maximaal 3650).",
    });
    return;
  }
  if (red <= yellow) {
    res.status(400).json({
      error: "De rode drempel moet groter zijn dan de gele drempel.",
    });
    return;
  }

  try {
    const repos = await listMonitoredRepos();
    if (!repos.includes(raw)) {
      res.status(404).json({ error: "Deze codebase wordt niet bewaakt." });
      return;
    }
    await saveRepoThresholds(raw, { staleYellowDays: yellow, staleRedDays: red });
    invalidateRepoCache(raw);
    res.json(
      UpdateRepoSettingsResponse.parse({
        repo: raw,
        staleYellowDays: yellow,
        staleRedDays: red,
      }),
    );
  } catch (err) {
    req.log.error({ err, repo: raw }, "Opslaan van instellingen mislukt");
    res.status(502).json({ error: "Kon de instellingen niet opslaan. Probeer het zo opnieuw." });
  }
});

export default router;
