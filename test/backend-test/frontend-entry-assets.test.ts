import { describe, expect, test } from "bun:test";
import {
    assertFrontendEntryAssets,
    getFrontendEntryAssets,
    type ViteManifest,
} from "@/server/frontend-entry-assets.js";

const manifest: ViteManifest = {
    "entry.html": {
        file: "assets/app.js",
        isEntry: true,
        name: "app",
        imports: ["a", "b"],
        css: ["assets/app.css"],
    },
    a: {
        file: "assets/a.js",
        imports: ["b"],
        css: ["assets/a.css"],
    },
    b: {
        file: "assets/b.js",
        imports: ["entry.html"],
        css: ["assets/b.css"],
    },
};

describe("frontend entry assets", () => {
    test("collects transitive assets once in manifest order, including a cycle", () => {
        expect(getFrontendEntryAssets(manifest)).toEqual({
            mainScript: "assets/app.js",
            styles: ["assets/app.css", "assets/a.css", "assets/b.css"],
            modulePreloads: ["assets/a.js", "assets/b.js"],
        });
    });

    test("does not depend on manifest object key order", () => {
        const reorderedManifest: ViteManifest = {
            b: manifest.b,
            "entry.html": manifest["entry.html"],
            a: manifest.a,
        };

        expect(getFrontendEntryAssets(reorderedManifest)).toEqual(getFrontendEntryAssets(manifest));
    });

    test("fails for a missing transitive import or an asset absent from the embedded map", () => {
        expect(() =>
            getFrontendEntryAssets({
                "entry.html": { file: "assets/app.js", isEntry: true, name: "app", imports: ["missing"] },
            })
        ).toThrow("Vite manifest import is missing: missing");

        expect(() =>
            assertFrontendEntryAssets(
                { mainScript: "assets/app.js", styles: ["assets/app.css"], modulePreloads: ["assets/a.js"] },
                ["assets/app.js", "assets/app.css"]
            )
        ).toThrow("Frontend entry asset is missing from embedded assets: assets/a.js");
    });
});
