// @ts-nocheck
import path from "path";
import postCssScss from "postcss-scss";
import postcssRTLCSS from "postcss-rtlcss";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { visualizer } from "rollup-plugin-visualizer";
import viteCompression from "vite-plugin-compression";

const viteCompressionFilter = /\.(js|mjs|json|css|html|svg)$/i;
const serviceWorkerEntry = path.resolve(import.meta.dirname, "../src/serviceWorker.ts");
const analyze = process.env.ANALYZE === "1" || process.env.ANALYZE === "true";

function serviceWorkerDevRoute() {
    return {
        name: "iglo-monitor-service-worker",
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                const pathname = new URL(request.url || "/", "http://localhost").pathname;
                if (pathname !== "/serviceWorker.js") {
                    next();
                    return;
                }

                try {
                    const result = await server.transformRequest("/serviceWorker.ts");
                    if (!result) {
                        next();
                        return;
                    }
                    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
                    response.end(result.code);
                } catch (error) {
                    next(error);
                }
            });
        },
    };
}

// https://vitejs.dev/config/
export default defineConfig({
    root: "src",
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "../src"),
        },
    },
    publicDir: "../public",
    server: {
        port: 3000,
    },
    define: {
        "process.env": {},
    },
    plugins: [
        vue(),
        serviceWorkerDevRoute(),
        viteCompression({
            algorithm: "brotliCompress",
            filter: viteCompressionFilter,
        }),
        ...(analyze
            ? [
                  visualizer({
                      filename: path.resolve(import.meta.dirname, "../tmp/dist-stats.html"),
                      open: false,
                  }),
              ]
            : []),
    ],
    css: {
        postcss: {
            parser: postCssScss,
            map: false,
            plugins: [postcssRTLCSS],
        },
    },
    build: {
        outDir: "../dist",
        emptyOutDir: true,
        manifest: true,
        commonjsOptions: {
            include: [/.js$/],
        },
        rollupOptions: {
            input: {
                app: path.resolve(import.meta.dirname, "../src/index.html"),
                serviceWorker: serviceWorkerEntry,
            },
            output: {
                entryFileNames(chunkInfo) {
                    return chunkInfo.name === "serviceWorker" ? "serviceWorker.js" : "assets/[name]-[hash].js";
                },
                manualChunks(id, { getModuleInfo, getModuleIds }) {},
            },
        },
    },
});
