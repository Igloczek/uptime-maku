import { describe, expect, test } from "bun:test";

const lazyMonitorInputs = [
    "src/server/ping.ts",
    "src/server/radius.ts",
    "src/server/kafka.ts",
    "src/server/json-query.ts",
    "src/server/tls-cert.ts",
];
const lazyCoreHttpMonitorInputs = [
    "src/server/monitor-http.ts",
    "src/server/oauth-client-credentials.ts",
    "src/server/proxy-validation.ts",
];
const sharedCoreHttpInputs = ["src/server/http-client.ts", "src/server/http-utils.ts"];

function collectStaticInputs(metafile, outputPath, visited = new Set()) {
    if (visited.has(outputPath)) {
        return [];
    }
    visited.add(outputPath);

    const output = metafile.outputs[outputPath];
    if (!output) {
        return [];
    }

    return [
        ...Object.keys(output.inputs || {}),
        ...output.imports
            .filter((item) => item.kind !== "dynamic-import")
            .flatMap((item) => collectStaticInputs(metafile, item.path, visited)),
    ];
}

function collectOutputInputs(metafile, outputPath, visited = new Set()) {
    if (visited.has(outputPath)) {
        return [];
    }
    visited.add(outputPath);

    const output = metafile.outputs[outputPath];
    if (!output) {
        return [];
    }

    return [
        ...Object.keys(output.inputs || {}),
        ...output.imports.flatMap((item) => collectOutputInputs(metafile, item.path, visited)),
    ];
}

function collectDynamicInputs(metafile, outputPath) {
    const output = metafile.outputs[outputPath];
    return output.imports
        .filter((item) => item.kind === "dynamic-import")
        .flatMap((item) => collectOutputInputs(metafile, item.path));
}

async function expectDynamicDependency(entrypoint, dependency) {
    const result = await Bun.build({
        entrypoints: [entrypoint],
        target: "bun",
        bundle: true,
        format: "esm",
        splitting: true,
        outdir: "out",
        write: false,
        metafile: true,
    });

    expect(result.success).toBe(true);
    const [entryOutputPath] = Object.entries(result.metafile.outputs).find(
        ([, output]) => output.entryPoint === entrypoint
    );
    expect(entryOutputPath).toBeDefined();
    const eagerInputs = collectStaticInputs(result.metafile, entryOutputPath);
    const dynamicInputs = collectDynamicInputs(result.metafile, entryOutputPath);

    expect(eagerInputs.some((input) => input.includes(`node_modules/${dependency}/`))).toBe(false);
    expect(dynamicInputs.some((input) => input.includes(`node_modules/${dependency}/`))).toBe(true);
}

describe("compiled import boundaries", () => {
    test("keeps constants and logging independent from JSONata", async () => {
        const result = await Bun.build({
            entrypoints: ["src/constants.ts", "src/server/logger.ts"],
            target: "bun",
            write: false,
            metafile: true,
        });

        expect(result.success).toBe(true);
        expect(JSON.stringify(result.metafile)).not.toContain("jsonata");
    });

    test("loads optional monitor features through dynamic bundle edges", async () => {
        const result = await Bun.build({
            entrypoints: ["src/server/model/monitor.ts"],
            target: "bun",
            bundle: true,
            format: "esm",
            splitting: true,
            outdir: "out",
            write: false,
            metafile: true,
        });
        const outputs = Object.entries(result.metafile.outputs);
        const [monitorOutputPath] = outputs.find(([, output]) => output.entryPoint === "src/server/model/monitor.ts");
        expect(monitorOutputPath).toBeDefined();
        const eagerInputs = collectStaticInputs(result.metafile, monitorOutputPath);
        const dynamicInputs = collectDynamicInputs(result.metafile, monitorOutputPath);

        expect(eagerInputs).not.toEqual(expect.arrayContaining(lazyMonitorInputs));
        expect(dynamicInputs).toEqual(expect.arrayContaining(lazyMonitorInputs));
    });

    test("keeps core HTTP monitor behavior behind its runtime boundary", async () => {
        const result = await Bun.build({
            entrypoints: ["src/server/model/monitor.ts"],
            target: "bun",
            bundle: true,
            format: "esm",
            splitting: true,
            outdir: "out",
            write: false,
            metafile: true,
        });

        expect(result.success).toBe(true);
        const [monitorOutputPath] = Object.entries(result.metafile.outputs).find(
            ([, output]) => output.entryPoint === "src/server/model/monitor.ts"
        );
        expect(monitorOutputPath).toBeDefined();
        const eagerInputs = collectStaticInputs(result.metafile, monitorOutputPath);
        const dynamicInputs = collectDynamicInputs(result.metafile, monitorOutputPath);

        expect(eagerInputs).not.toEqual(expect.arrayContaining(lazyCoreHttpMonitorInputs));
        expect(eagerInputs).toEqual(expect.arrayContaining(sharedCoreHttpInputs));
        expect(dynamicInputs).toEqual(expect.arrayContaining(lazyCoreHttpMonitorInputs));
    });

    test("loads optional startup integrations through dynamic bundle edges", async () => {
        await expectDynamicDependency("src/server/webpush-vapid.ts", "web-push");
        await expectDynamicDependency(
            "src/server/socket-handlers/cloudflared-socket-handler.ts",
            "node-cloudflared-tunnel"
        );
        await expectDynamicDependency("src/server/model/domain_expiry.ts", "tldts");
        await expectDynamicDependency("src/db/schema/upgrades/001-upstream-baseline.ts", "tldts");
    });
});
