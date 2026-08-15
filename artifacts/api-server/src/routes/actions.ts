import { Router, type IRouter } from "express";
import {
  ListActionLogResponse,
  ListProposalsResponse,
  ExecuteProposalResponse,
} from "@workspace/api-zod";
import { listRecentActions } from "../lib/actionlog";
import { listProposals, executeProposal } from "../lib/proposals";

const router: IRouter = Router();

router.get("/actions/log", async (req, res): Promise<void> => {
  try {
    const rows = await listRecentActions();
    const entries = rows.map((r) => ({
      id: r.id,
      action: r.action,
      repo: r.repo,
      reason: r.reason,
      outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json(ListActionLogResponse.parse(entries));
  } catch (err) {
    req.log.error({ err }, "Ophalen van logboek mislukt");
    res.status(502).json({ error: "Kon het logboek niet ophalen." });
  }
});

router.get("/actions/proposals", async (req, res): Promise<void> => {
  try {
    const proposals = await listProposals();
    res.json(ListProposalsResponse.parse(proposals));
  } catch (err) {
    req.log.error({ err }, "Ophalen van voorstellen mislukt");
    res.status(502).json({ error: "Kon de voorstellen niet ophalen bij GitHub." });
  }
});

router.post("/actions/proposals/:id/execute", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const result = await executeProposal(String(raw));
    if (result.status === 200) {
      res.json(
        ExecuteProposalResponse.parse({ success: true, message: result.message }),
      );
    } else {
      res.status(result.status).json({ error: result.message });
    }
  } catch (err) {
    req.log.error({ err, proposal: raw }, "Uitvoeren van voorstel mislukt");
    res.status(502).json({ error: "Het uitvoeren is niet gelukt. Probeer het zo opnieuw." });
  }
});

export default router;
