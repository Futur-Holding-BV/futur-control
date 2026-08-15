import { Router, type IRouter } from "express";
import { ListReposResponse, GetRepoDetailResponse } from "@workspace/api-zod";
import {
  listMonitoredRepos,
  repoSummary,
  repoDetail,
  GitHubError,
} from "../lib/github";

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

export default router;
