import { dispatchOneJob } from "../src/lib/pipeline/runner";

const POLL_INTERVAL_MS = 5000;
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

async function run() {
  console.log("ReelForge worker started.");
  while (!stopping) {
    try {
      const result = await dispatchOneJob();
      if (result.ran) {
        console.log(`[Worker] Ran job. Kind: ${result.kind}, ID: ${result.jobId}, Error: ${result.error || "none"}`);
      } else {
        await wait(POLL_INTERVAL_MS);
      }
    } catch (error) {
      console.error("[Worker] Loop error:", error instanceof Error ? error.message : String(error));
      await wait(POLL_INTERVAL_MS);
    }
  }
  console.log("ReelForge worker stopped.");
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

void run();
