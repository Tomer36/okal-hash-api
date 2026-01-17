import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import config from "config";
import path from "path";
import reportRoutes from "./routes/reportRoutes.js";

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.resolve(".")));

const PORT = config.get("configs.HASH_PORT");

app.use("/reports", reportRoutes);

app.listen(PORT, () => {
  console.log(`✅ Hash microservice running on port ${PORT}`);
});
