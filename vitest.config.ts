import { defineConfig } from "vitest/config";

// Only this checkout's tests: other checkouts nested inside it have their own.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
