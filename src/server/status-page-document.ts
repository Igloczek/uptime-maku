import analytics from "@/server/analytics/analytics.js";
import { getFrontendEntryAssets } from "@/server/frontend-entry-assets.js";
import { escapeHtml, escapeJsJson } from "@/util/escape.js";

type StatusPageMetadata = {
    analyticsId?: string | null;
    analyticsScriptUrl?: string | null;
    analyticsType?: string | null;
    description?: string | null;
    icon?: string | null;
    slug: string;
    title: string;
};

type StatusPageDocumentInput = {
    preloadData: unknown;
    statusPage: StatusPageMetadata;
};

type FrontendEntryAssets = Readonly<{
    mainScript: string;
    modulePreloads: readonly string[];
    styles: readonly string[];
}>;

const HTML_ENTITIES: Record<string, string> = {
    amp: "&",
    apos: "'",
    copy: "©",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    reg: "®",
};

function closingBracket(input: string, start: number, open: string, close: string) {
    let depth = 0;

    for (let index = start; index < input.length; index++) {
        if (input[index] === "\\") {
            index++;
        } else if (input[index] === open) {
            depth++;
        } else if (input[index] === close && --depth === 0) {
            return index;
        }
    }

    return -1;
}

function markdownInlineToPlainText(input: string): string {
    let output = "";

    for (let index = 0; index < input.length; index++) {
        const character = input[index];

        if (character === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(input[index + 1] ?? "")) {
            output += input[++index];
            continue;
        }

        if (character === "`") {
            const delimiterEnd = input.indexOf("`", index + 1);
            if (delimiterEnd !== -1) {
                output += input.slice(index + 1, delimiterEnd);
                index = delimiterEnd;
                continue;
            }
        }

        if (character === "<") {
            const tagEnd = input.indexOf(">", index + 1);
            if (tagEnd !== -1) {
                const tag = input.slice(index + 1, tagEnd);
                if (/^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(tag)) {
                    output += tag.replace(/^mailto:/i, "");
                } else {
                    output += " ";
                }
                index = tagEnd;
                continue;
            }
        }

        const linkStart = character === "[" ? index : character === "!" && input[index + 1] === "[" ? index + 1 : -1;
        if (linkStart !== -1) {
            const labelEnd = closingBracket(input, linkStart, "[", "]");
            if (labelEnd !== -1 && input[labelEnd + 1] === "(") {
                const destinationEnd = closingBracket(input, labelEnd + 1, "(", ")");
                if (destinationEnd !== -1) {
                    output += markdownInlineToPlainText(input.slice(linkStart + 1, labelEnd));
                    index = destinationEnd;
                    continue;
                }
            }
        }

        if (character === "*" || character === "_" || character === "~") {
            continue;
        }

        output += character;
    }

    return output;
}

/**
 * Produces a short, non-HTML summary for status-page metadata. This is a small
 * deterministic transform rather than a Markdown renderer: it only removes
 * presentation syntax while preserving the text users see in the editor.
 */
function markdownToPlainText(markdown: string | null | undefined) {
    const lines = String(markdown ?? "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .split("\n");
    const withoutBlocks: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const nextLine = lines[index + 1];

        if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) {
            const fence = line.match(/`{3,}|~{3,}/)?.[0];
            while (
                ++index < lines.length &&
                !new RegExp(`^\\s{0,3}${fence?.[0]}{${fence?.length},}\\s*$`).test(lines[index])
            ) {
                withoutBlocks.push(lines[index]);
            }
            continue;
        }

        if (nextLine && /^\s*(?:=+|-+)\s*$/.test(nextLine) && line.trim()) {
            withoutBlocks.push(line);
            index++;
            continue;
        }

        if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
            continue;
        }

        withoutBlocks.push(line.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/, ""));
    }

    const withoutMarkdown = markdownInlineToPlainText(withoutBlocks.join("\n"));

    return withoutMarkdown
        .replace(/&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);/gi, (_match, hex, decimal, named) => {
            const codePoint = hex ? Number.parseInt(hex, 16) : decimal ? Number.parseInt(decimal, 10) : null;
            if (codePoint !== null) {
                return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
            }
            return HTML_ENTITIES[named.toLowerCase()] || "";
        })
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 155);
}

function assetPath(path: string) {
    return `/${path}`;
}

function renderIconLinks(icon: string | null | undefined) {
    if (icon) {
        return `<link rel="icon" href="${escapeHtml(icon)}" />`;
    }

    return [
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
        '<link rel="icon" type="image/svg+xml" href="/icon.svg" />',
    ].join("\n    ");
}

function renderAnalytics(statusPage: StatusPageMetadata) {
    if (!analytics.isValidAnalyticsConfig(statusPage)) {
        return "";
    }

    // Analytics builders own their escaped, provider-specific script fragments.
    return analytics.getAnalyticsScript(statusPage) || "";
}

function renderPreloadData(preloadData: unknown) {
    const json = escapeJsJson(preloadData, { isScriptContext: true });
    return `<script id="preload-data" data-json="{}">window.preloadData = ${json};</script>`;
}

function renderAppShell(assets: FrontendEntryAssets) {
    const modulePreloads = assets.modulePreloads
        .map((path) => `<link rel="modulepreload" crossorigin href="${escapeHtml(assetPath(path))}" />`)
        .join("\n    ");
    const styles = assets.styles
        .map((path) => `<link rel="stylesheet" crossorigin href="${escapeHtml(assetPath(path))}" />`)
        .join("\n    ");
    const mainScript = `<script type="module" crossorigin src="${escapeHtml(assetPath(assets.mainScript))}"></script>`;
    const assetsInHead = [mainScript, modulePreloads, styles].filter(Boolean).join("\n    ");

    return {
        assetsInHead,
        body: `<noscript>
    <div class="noscript-message">
        Sorry, you don't seem to have JavaScript enabled or your browser
        doesn't support it.<br />This website requires JavaScript to function.
        Please enable JavaScript in your browser settings to continue.
    </div>
</noscript>
<div id="app"></div>`,
    };
}

function renderHead({ statusPage, description, preloadData }: StatusPageDocumentInput & { description: string }) {
    const analyticsScripts = renderAnalytics(statusPage);
    const appShell = renderAppShell(getFrontendEntryAssets());
    const manifestPath = `/api/status-page/${encodeURIComponent(statusPage.slug)}/manifest.json`;

    return `<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    ${renderIconLinks(statusPage.icon)}
    <link rel="manifest" href="${escapeHtml(manifestPath)}" />
    <meta name="theme-color" id="theme-color" content="" />
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:title" content="${escapeHtml(statusPage.title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <title>${escapeHtml(statusPage.title)}</title>
    <style>
        .noscript-message {
            font-size: 20px;
            text-align: center;
            padding: 10px;
            max-width: 500px;
            margin: 0 auto;
        }
    </style>
    ${analyticsScripts}
    ${renderPreloadData(preloadData)}
    ${appShell.assetsInHead}
</head>`;
}

async function renderStatusPageDocument({ statusPage, preloadData }: StatusPageDocumentInput) {
    const description = markdownToPlainText(statusPage.description);
    const head = renderHead({ statusPage, preloadData, description });
    const { body } = renderAppShell(getFrontendEntryAssets());

    return `<!DOCTYPE html>
<html lang="en">
${head}
<body>
${body}
</body>
</html>`;
}

export {
    renderAnalytics,
    renderAppShell,
    renderHead,
    renderIconLinks,
    renderPreloadData,
    renderStatusPageDocument,
    markdownToPlainText,
};
