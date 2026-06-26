/**
 * Local dev helper: `npm run dev:clean`
 *
 * Clears the .next cache and starts `next dev` with a larger Node heap. Use this
 * whenever the dev server dies with "Jest worker … child process exceptions",
 * an EBUSY lock on .next, or "Fatal process out of memory".
 *
 * Root cause: this repo lives inside OneDrive, which virtualises/locks files in
 * .next and starves the dev workers. The DURABLE fix is to move the repo outside
 * OneDrive (e.g. C:\dev\dca-dashboard). This script is the band-aid until then.
 *
 * If it still can't clear .next, close any other dev/node terminals first
 * (a stale dev server holds the lock), then re-run.
 */
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

try {
  rmSync(".next", { recursive: true, force: true });
  console.log("✓ cleared .next");
} catch (e) {
  console.warn("⚠ could not fully clear .next — close other node/dev windows and retry:", e.message);
}

process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim();
console.log("→ starting next dev with 4GB heap…");
const child = spawn("npx", ["next", "dev"], { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
