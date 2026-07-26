import "dotenv/config";
import { getGlobalDispatcher } from "undici";
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
  .then(async () => {
    process.exitCode = 0;
    await getGlobalDispatcher().close();
  })
  .catch(async (err) => {
    console.error("Pipeline run failed:", err);
    process.exitCode = 1;
    await getGlobalDispatcher().close();
  });












// runPipeline()
//   .then(() => {
//     // TEMPORARY DIAGNOSTIC — remove once the hang is fixed.
//     // Lists whatever's still keeping the event loop alive at this point.
//     console.log(
//       "ACTIVE HANDLES:",
//       (process as any)._getActiveHandles().map((h: any) => h.constructor.name)
//     );

//     // NOT process.exit(0). process.exit() terminates immediately and can
//     // truncate buffered stdout — and in a job whose entire observability is
//     // the RUN REPORT printed at the very end, losing the tail of stdout is a
//     // uniquely unfortunate way to go blind. Setting exitCode lets Node drain
//     // its streams and exit on its own.
//     process.exitCode = 0;
//   })
//   .catch((err) => {
//     console.error("Pipeline run failed:", err);
//     process.exitCode = 1;
//   });