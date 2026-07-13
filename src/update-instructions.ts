import { dirname, resolve } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { refreshInstructions } from "./instructions.ts";

refreshInstructions(SettingsManager, resolve(dirname(import.meta.dirname)), process.cwd());
