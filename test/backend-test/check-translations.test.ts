import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";

const EN_PLACEHOLDER_CONTRACT_SHA256 = "8408e1f4d0b539705cd05750122303345a6ebe8ab06a95c971053b884b48c58c";

function extractParams(value) {
    if (typeof value !== "string") {
        return new Set();
    }

    return new Set(Array.from(value.matchAll(/\{([^}]+)\}/g), (match) => match[1]));
}

describe("English translation data contract", () => {
    test("en.json translations preserve placeholder parameters", async () => {
        const enTranslations = JSON.parse(await fs.readFile("src/lang/en.json", "utf-8"));
        const contract = Object.entries(enTranslations)
            .map(([key, value]) => [key, [...extractParams(value)].sort()])
            .filter(([, params]) => params.length > 0)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(contract)).digest("hex");

        expect(digest).toBe(EN_PLACEHOLDER_CONTRACT_SHA256);
    });
});
