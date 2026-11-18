import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import config from "config";
import path from "path";
import reportRoutes from "./routes/reportRoutes.js";
import { PROVIDER_HOST, RESILIENCE_LIMITS, postStartupLog } from "./services/reportService.js";
import { readCommit, reportStartup } from "./services/startupReport.mjs";

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.resolve(".")));

const PORT = config.get("configs.HASH_PORT");

app.use("/reports", reportRoutes);

app.listen(PORT, () => {
  console.log(`✅ Hash microservice running on port ${PORT}, Hashavshevet server: ${PROVIDER_HOST}`);
  console.log(`Upstream limits: ${JSON.stringify(RESILIENCE_LIMITS)}`);
  reportStartup({ post: postStartupLog, details: { provider: PROVIDER_HOST, limits: RESILIENCE_LIMITS, version: readCommit() } });
});
