import { dirname, resolve } from "node:path";

import { refreshInstructions } from "./instructions.ts";

refreshInstructions(resolve(dirname(import.meta.dirname)), process.cwd());
