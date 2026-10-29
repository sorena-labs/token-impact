#!/usr/bin/env node
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (output) => process.stdout.write(output),
  (error: unknown) => {
    process.stderr.write(`token-impact: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
