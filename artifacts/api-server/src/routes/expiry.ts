import { Router, type IRouter } from "express";
import { ListExpiryItemsResponse } from "@workspace/api-zod";
import { listExpiryItems } from "../lib/expiry";

const router: IRouter = Router();

router.get("/expiry", async (req, res): Promise<void> => {
  const bypass = req.query["refresh"] === "true";
  try {
    const items = await listExpiryItems(bypass);
    res.json(ListExpiryItemsResponse.parse(items));
  } catch (err) {
    req.log.error({ err }, "Ophalen van verloopdata mislukt");
    res.status(502).json({
      error: "Kon de verloopdata niet ophalen. Probeer het zo opnieuw.",
    });
  }
});

export default router;
