import { Router, type IRouter } from "express";
import { ListReposResponse, GetRepoDetailResponse } from "@workspace/api-zod";
import {
  MONITORED_REPOS,
  repoSummary,
  repoDetail,
  GitHubError,
} from "../lib/github";

const router: IRouter = Router();

router.get("/repos", async (req, res): Promise<void> => {
  try {
    const summaries = await Promise.all(
      MONITORED_REPOS.map((name) => repoSummary(name)),
    );
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
  const name = MONITORED_REPOS.find((r) => r === raw);
  if (!name) {
    res.status(404).json({ error: "Deze codebase wordt niet bewaakt." });
    return;
  }

  try {
    const detail = await repoDetail(name);
    res.json(GetRepoDetailResponse.parse(detail));
  } catch (err) {
    req.log.error({ err, repo: name }, "Ophalen van repositorydetail mislukt");
    res.status(502).json({
      error:
        "Kon de details niet ophalen bij GitHub. Probeer het zo opnieuw.",
    });
  }
});

export default router;
