#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionStart } from "../scripts/config.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/findbrief.mjs");

function sessionDirectory() {
  try {
    return JSON.parse(readFileSync(0, "utf8")).cwd || process.cwd();
  } catch {
    return process.cwd();
  }
}

const result = spawnSync(process.execPath, [cli, sessionStart.command], { cwd: sessionDirectory(), encoding: "utf8" });
if (result.status === 0 && result.stdout) {
  process.stdout.write(`${sessionStart.heading}\n\n${result.stdout}`);
}
