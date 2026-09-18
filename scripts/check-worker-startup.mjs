import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const server = createServer();
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("Could not allocate a port for Wrangler");
}
const port = address.port;
await new Promise((resolveClose, reject) =>
  server.close((error) => (error === undefined ? resolveClose() : reject(error)))
);

const executable = resolve(
  "node_modules/.bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler"
);
const wrangler = spawn(
  executable,
  ["dev", "--ip", "127.0.0.1", "--port", String(port), "--log-level", "error"],
  { stdio: ["ignore", "pipe", "pipe"] }
);
wrangler.stdout.pipe(process.stdout);
wrangler.stderr.pipe(process.stderr);

let exitResult;
const exited = new Promise((resolveExit) => {
  wrangler.once("exit", (code, signal) => {
    exitResult = { code, signal };
    resolveExit();
  });
});

try {
  const deadline = Date.now() + 20_000;
  let started = false;
  while (Date.now() < deadline) {
    if (exitResult !== undefined) {
      throw new Error(
        `Wrangler exited before the Worker started (code ${exitResult.code}, signal ${exitResult.signal})`
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.body?.cancel();
      process.stdout.write("Worker started successfully.\n");
      started = true;
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }

  if (!started) {
    throw new Error("Timed out waiting for the Worker to start");
  }
} finally {
  if (exitResult === undefined) wrangler.kill("SIGTERM");
  await exited;
}
