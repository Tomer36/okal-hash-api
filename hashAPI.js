import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import config from "config";
import reportRoutes from "./routes/reportRoutes.js";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = config.get("configs.HASH_PORT");

app.use("/reports", reportRoutes);

app.listen(PORT, () => {
  console.log(`✅ Hash microservice running on port ${PORT}`);
});