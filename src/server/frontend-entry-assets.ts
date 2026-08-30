import fs from "node:fs";
import path from "node:path";

export type ViteManifestEntry = {
    css?: string[];
    file: string;
    imports?: string[];
    isEntry?: boolean;
    name?: string;
    src?: string;
};

export type ViteManifest = Record<string, ViteManifestEntry>;

export type FrontendEntryAssets = {
    mainScript: string;
    modulePreloads: string[];
    styles: string[];
};

const EMPTY_FRONTEND_ENTRY_ASSETS: FrontendEntryAssets = {
    mainScript: "",
    modulePreloads: [],
    styles: [],
};

let registeredFrontendEntryAssets: FrontendEntryAssets | null = null;

function collectFrontendEntryAssets(manifest: ViteManifest): FrontendEntryAssets {
    const entries = Object.entries(manifest);
    const appEntry =
        entries.find(([, entry]) => entry.isEntry && entry.name === "app") ??
        entries.find(([, entry]) => entry.isEntry && entry.src?.endsWith("index.html"));

    if (!appEntry) {
        throw new Error("Vite manifest does not contain the app entry.");
    }

    const [entryKey, entry] = appEntry;
    const styles = new Set<string>();
    const modulePreloads = new Set<string>();
    const visited = new Set<string>();

    const collect = (key: string, isEntry = false) => {
        if (visited.has(key)) {
            return;
        }
        visited.add(key);

        const current = manifest[key];
        if (!current) {
            throw new Error(`Vite manifest import is missing: ${key}`);
        }

        if (!isEntry) {
            modulePreloads.add(current.file);
        }
        for (const css of current.css || []) {
            styles.add(css);
        }
        for (const importKey of current.imports || []) {
            collect(importKey);
        }
    };

    collect(entryKey, true);

    return {
        mainScript: entry.file,
        styles: [...styles],
        modulePreloads: [...modulePreloads],
    };
}

function getFrontendEntryAssets(manifest?: ViteManifest): FrontendEntryAssets {
    if (manifest) {
        return collectFrontendEntryAssets(manifest);
    }

    if (registeredFrontendEntryAssets) {
        return registeredFrontendEntryAssets;
    }

    const manifestPath = path.resolve("dist/.vite/manifest.json");
    if (!fs.existsSync(manifestPath)) {
        return EMPTY_FRONTEND_ENTRY_ASSETS;
    }

    registeredFrontendEntryAssets = collectFrontendEntryAssets(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ViteManifest
    );
    return registeredFrontendEntryAssets;
}

function registerFrontendEntryAssets(assets: FrontendEntryAssets) {
    registeredFrontendEntryAssets = assets;
}

function assertFrontendEntryAssets(entryAssets: FrontendEntryAssets, webAssets: Iterable<string>) {
    const embeddedAssets = new Set(webAssets);
    for (const asset of [entryAssets.mainScript, ...entryAssets.styles, ...entryAssets.modulePreloads]) {
        if (!embeddedAssets.has(asset)) {
            throw new Error(`Frontend entry asset is missing from embedded assets: ${asset}`);
        }
    }
}

export {
    assertFrontendEntryAssets,
    getFrontendEntryAssets,
    registerFrontendEntryAssets,
};
