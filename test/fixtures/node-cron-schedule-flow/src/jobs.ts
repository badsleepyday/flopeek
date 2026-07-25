import cron from "node-cron";
import { persistSnapshot } from "./store";

export function refreshSnapshot() {
  return persistSnapshot();
}

cron.schedule("0 * * * *", refreshSnapshot);
cron.schedule("not a cron expression", refreshSnapshot);
cron.schedule("0 * * * *", () => refreshSnapshot());
