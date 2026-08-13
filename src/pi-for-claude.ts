#!/usr/bin/env node

// Entry shim. pi-for-claude runs straight from this source checkout, so a
// fresh clone — or a just-merged commit that adds a dependency — leaves
// node_modules missing a package the source imports, and every launch dies in
// module resolution before any app code runs. Catching that here turns the
// raw resolver stack into an instruction. The message is inline because the
// strings.json loader lives behind the imports that just failed.
import { dirname } from "node:path";

try {
  await import("./cli.ts");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    const home = dirname(import.meta.dirname);
    process.stderr.write(`pi-for-claude: ${error.message}\n`);
    process.stderr.write(`node_modules is out of date with the checkout at ${home} — run \`npm install\` there, then retry.\n`);
    process.exit(1);
  }
  throw error;
}
