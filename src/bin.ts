#!/usr/bin/env node
import { run } from "./cli.js";

// A reader that stops early, such as `head`, closes the pipe: the rest of the output is not wanted.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

run(process.argv.slice(2)).then(
  (output) => process.stdout.write(output),
  (error: unknown) => {
    process.stderr.write(`token-impact: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
