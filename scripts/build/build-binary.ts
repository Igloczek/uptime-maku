#!/usr/bin/env bun
import path from "path";
import { $ } from "bun";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const outfileArg = process.argv.find((arg) => arg.startsWith("--outfile="))?.slice("--outfile=".length);
const outfile = outfileArg ? path.resolve(projectRoot, outfileArg) : path.join(projectRoot, "iglo.monitor");

process.chdir(projectRoot);

console.log("Generating kuma.db template...");
await $`bun scripts/build/generate-kuma-db.ts`;

console.log("Building frontend...");
await $`bun run build:frontend`;

console.log("Generating embedded asset manifest...");
await $`bun scripts/build/generate-embedded-assets.ts`;

const target = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);

console.log(target ? `Compiling binary (target=${target})...` : "Compiling binary...");

const result = await Bun.build({
    entrypoints: ["src/server/server.ts"],
    compile: {
        outfile,
        ...(target ? { target } : {}),
    },
    external: ["chromium-bidi/*", "deasync"],
    format: "esm",
    splitting: true,
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
    },
    minify: true,
    sourcemap: "linked",
});

if (!result.success) {
    console.error("Binary build failed:");
    for (const log of result.logs) {
        console.error(log);
    }
    process.exit(1);
}

const builtPath = result.outputs?.[0]?.path ?? outfile;
console.log(`Built ${builtPath}`);
