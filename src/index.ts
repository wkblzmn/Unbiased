import "dotenv/config";
import { runPoller } from "./poller";
import { runClusterer } from "./runClusterer";
import { runSummarizer } from "./runSummarizer";

async function runPipeline() {
  console.log(`\n=== Pipeline run started at ${new Date().toISOString()} ===`);

  console.log("\n[1/3] Polling RSS feeds...");
  await runPoller();

  console.log("\n[2/3] Clustering...");
  await runClusterer();

  console.log("\n[3/3] Summarizing...");
  await runSummarizer();

  console.log(`\n=== Pipeline run finished at ${new Date().toISOString()} ===`);
}

runPipeline()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Pipeline run failed:", err);
    process.exit(1);
  });