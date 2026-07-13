import "dotenv/config";
import { runPoller } from "./poller";
import { runClusterer } from "./runClusterer";
import { runSummarizer } from "./runSummarizer";
import { printRunReport } from "./stats";

async function runPipeline() {
  console.log(`\n=== Pipeline run started at ${new Date().toISOString()} ===`);

  console.log("\n[1/3] Polling RSS feeds...");
  const pollStats = await runPoller();

  console.log("\n[2/3] Clustering...");
  const clusterStats = await runClusterer();

  console.log("\n[3/3] Summarizing...");
  const summaryStats = await runSummarizer();

  printRunReport(pollStats, clusterStats, summaryStats);

  console.log(`=== Pipeline run finished at ${new Date().toISOString()} ===`);
}

runPipeline()
  .then(() => {
    // NOT process.exit(0). process.exit() terminates immediately and can
    // truncate buffered stdout — and in a job whose entire observability is
    // the RUN REPORT printed at the very end, losing the tail of stdout is a
    // uniquely unfortunate way to go blind. Setting exitCode lets Node drain
    // its streams and exit on its own.
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("Pipeline run failed:", err);
    process.exitCode = 1;
  });