import fs from "node:fs";
import path from "node:path";

type EmbeddedAssetMap = Record<string, string>;

const embeddedWebAssets: EmbeddedAssetMap = {};
let hasRegisteredAssets = false;

function sourceAssetPath(webPath: string) {
    return path.resolve("dist", webPath);
}

function registerEmbeddedAssets(assets: EmbeddedAssetMap) {
    for (const key of Object.keys(embeddedWebAssets)) {
        delete embeddedWebAssets[key];
    }
    Object.assign(embeddedWebAssets, assets);
    hasRegisteredAssets = true;
}

function hasEmbeddedAsset(webPath: string) {
    if (hasRegisteredAssets) {
        return Object.prototype.hasOwnProperty.call(embeddedWebAssets, webPath);
    }

    return fs.existsSync(sourceAssetPath(webPath));
}

function getEmbeddedAssetRef(webPath: string) {
    if (hasRegisteredAssets) {
        return embeddedWebAssets[webPath];
    }

    const filePath = sourceAssetPath(webPath);
    return fs.existsSync(filePath) ? filePath : undefined;
}

async function readEmbeddedAsset(webPath: string) {
    const ref = getEmbeddedAssetRef(webPath);
    if (!ref) {
        return null;
    }

    const file = Bun.file(ref);
    if (!(await file.exists())) {
        return null;
    }

    return file;
}

async function readEmbeddedAssetText(webPath: string) {
    const file = await readEmbeddedAsset(webPath);
    return file ? file.text() : null;
}

export {
    embeddedWebAssets,
    getEmbeddedAssetRef,
    hasEmbeddedAsset,
    readEmbeddedAsset,
    readEmbeddedAssetText,
    registerEmbeddedAssets,
};
