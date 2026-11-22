import express from "express";
import bodyParser from "body-parser";
import config from "config";
import reportRoutes from "./routes/reportRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";
import { PROVIDER_HOST, RESILIENCE_LIMITS, TEMPLATE_BACKUP_DIR, TEMPLATE_DIR, postStartupLog, templates } from "./services/reportService.js";
import { createTemplateBackup } from "./services/templateBackup.mjs";
import { migrateReportNumbers } from "./services/reportNumberMigration.mjs";
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

// Once: the report-templates folder moves from the number in a report's name to its מזהה.
try {
  migrateReportNumbers({ dir: TEMPLATE_DIR, backupDir: TEMPLATE_BACKUP_DIR });
} catch (error) {
  console.error(`❌ Moving report numbers to their מזהה failed (a copy of the folder was kept first): ${error.message}`);
}

listenLocal(app, PORT).then((servers) => {
  const addresses = servers.map((server) => server.address().address).join(", ");
  console.log(`✅ Hash microservice running on port ${PORT} (${addresses} only), Hashavshevet server: ${PROVIDER_HOST}`);
  console.log(`Upstream limits: ${JSON.stringify(RESILIENCE_LIMITS)}`);
  reportStartup({ post: postStartupLog, details: { provider: PROVIDER_HOST, limits: RESILIENCE_LIMITS, version: readCommit() } });
  // The report-templates folder is outside git: copied at start and then daily; after each copy,
  // checked versions never turned on are removed after 30 days (the newest 5 per report stay).
  createTemplateBackup({
    sourceDir: TEMPLATE_DIR,
    backupDir: TEMPLATE_BACKUP_DIR,
    afterRun: () => {
      const removed = templates.pruneVersions();
      if (removed.length) console.log(`[templates] removed ${removed.length} checked versions never used: ${removed.join(", ")}`);
    }
  }).start();
}).catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
