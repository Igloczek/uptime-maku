# Standalone real-browser binary

## Finding and fix

At baseline `b80411ad`, `scripts/build/build-binary.ts` marked `playwright-core` external. Compiled lifecycle tests ran
with the repository as their working directory, so Bun silently resolved the package from `node_modules`; this did
not prove the documented single-executable deployment.

The new regression physically copies the executable into an otherwise empty temporary directory, removes
`NODE_PATH` and `BUN_INSTALL`, and starts it with that directory as `cwd`. The baseline then failed at `testChrome`
with:

```text
playwright-core is required for real-browser monitors: Cannot find package 'playwright-core' from '/$bunfs/root/server.js'
```

The release build now embeds `playwright-core`. The two optional `chromium-bidi/*` imports in Playwright 1.61's
prebuilt `coreBundle.js` remain external because that package is not shipped by Playwright and Bun otherwise rejects
the build. iglo.monitor uses Playwright's Chromium CDP launch/connect paths, not the BiDi mapper.

## Measurements

Both arm64 binaries were built with Bun 1.3.14 on the same host. Startup samples use five fresh isolated directories
and databases; RSS is sampled immediately after `/api/entry-page` becomes ready.

| Measurement            | External baseline | Embedded Playwright |                    Change |
| ---------------------- | ----------------: | ------------------: | ------------------------: |
| Binary size            |  91,400,930 bytes |    98,187,362 bytes | +6,786,432 bytes (+7.42%) |
| Median fresh startup   |          1,982 ms |            2,150 ms |          +168 ms (+8.48%) |
| Median ready RSS       |       195,552 KiB |         211,328 KiB |      +15,776 KiB (+8.07%) |
| Real-browser lifecycle |       8,122.57 ms |  8,056.24 ms median |        -66.33 ms (-0.82%) |

The baseline browser timing requires repository `node_modules`; its isolated copy cannot launch a browser. The
embedded timing is the median of three fresh standalone processes after the host's first Chrome warm-up.

## Verification

- Baseline isolated copy: `0 pass / 1 fail`, missing `playwright-core` from `/$bunfs/root/server.js`.
- Fixed standalone copy: three fresh processes, each `1 pass / 0 fail / 22 assertions`; each exercised
  `testChrome`, a loopback real-browser heartbeat, PNG serving, active-navigation pause, resume, delete, and SIGTERM.
- Source and normal compiled lifecycle: `1/1` each with the same 22 assertions.
- Compiled SMTP production socket flow: `1 pass / 6 assertions`.
- Compiled auth/security: `13 pass / 424 assertions`.
- No Chrome profile or iglo.monitor browser-supervisor process remained after the repeated standalone runs.

One first post-build macOS Chrome launch exceeded the existing five-second acquisition cap; the next standalone run
and the required three-run fresh-process repeat passed. Linux release validation should retain the same standalone
test with its system Chromium executable.
