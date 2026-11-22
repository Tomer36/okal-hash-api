import express from "express";
import bodyParser from "body-parser";
import config from "config";
import reportRoutes from "./routes/reportRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";
import { PROVIDER_HOST, RESILIENCE_LIMITS, postStartupLog } from "./services/reportService.js";
import { readCommit, reportStartup } from "./services/startupReport.mjs";
import { listenLocal } from "./services/listenLocal.mjs";

// An API only: the reports page and the template updates live in Rivo, which calls this service
// through the gateway (reports) and auth-service (templates), both on this server. No files are
// served, so config/default.json (which holds the provider token) is never reachable.
const app = express();
app.use(bodyParser.json());

const PORT = config.get("configs.HASH_PORT");

app.use("/reports", reportRoutes);
app.use("/templates", templateRoutes);

listenLocal(app, PORT).then((servers) => {
  const addresses = servers.map((server) => server.address().address).join(", ");
  console.log(`✅ Hash microservice running on port ${PORT} (${addresses} only), Hashavshevet server: ${PROVIDER_HOST}`);
  console.log(`Upstream limits: ${JSON.stringify(RESILIENCE_LIMITS)}`);
  reportStartup({ post: postStartupLog, details: { provider: PROVIDER_HOST, limits: RESILIENCE_LIMITS, version: readCommit() } });
}).catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
