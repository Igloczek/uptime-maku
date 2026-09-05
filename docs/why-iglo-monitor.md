# Why iglo.monitor exists

Uptime monitoring is conceptually simple: run checks on a schedule, record the results, alert when something changes, and present the data clearly. The application implementing that idea should be understandable and dependable too.

Uptime Kuma delivers a capable monitoring product with an approachable interface and a large integration ecosystem. iglo.monitor exists because the architecture underneath that product has become much more complicated than the problem requires.

This is not about changing JavaScript runtimes for its own sake. It is about building the product on foundations that are easier to reason about, test, operate, and evolve.

## The problems

### Too much behavior lives in too few places

Core modules combine unrelated responsibilities such as scheduling, persistence, networking, validation, notifications, authorization, and UI state. Some backend modules and Vue views span thousands of lines.

Large files are not automatically bad, but mixed ownership is. A small change can cross several unrelated concerns, and extracting one feature often means untangling assumptions from the entire application.

### Important state is hidden

Models and services frequently reach into global registries, shared singletons, process-wide caches, and implicitly configured database behavior. That makes dependencies invisible at the call site.

Hidden state makes startup order matter, encourages circular dependencies, complicates tests, and makes it difficult to run two isolated application instances in one process. Code should receive the state it owns or uses explicitly.

### Compatibility layers became permanent architecture

Supporting several runtimes, module systems, transports, database engines, deployment styles, and generations of internal APIs left layers of adapters and fallback paths throughout the codebase.

Compatibility has a real cost. Every supported path expands the number of states that must be understood and tested. iglo.monitor deliberately supports a narrower platform so obsolete branches can be removed instead of carried forever.

### The dependency graph is much larger than the product needs

Some dependencies provide only a tiny piece of behavior. Others remain because a barrel import or compatibility path loads them indirectly. Optional integrations can become part of startup even when they are never configured.

Each dependency adds code, transitive packages, security surface, memory pressure, and maintenance work. iglo.monitor uses built-in platform APIs or small focused implementations when they are genuinely simpler, and loads optional features only when needed.

### Barrel files hide coupling

Broad utility entrypoints make imports look convenient while obscuring where symbols come from and what evaluating an import will load. They encourage unrelated code to grow behind one generic name and make dependency cycles harder to see.

iglo.monitor imports from the module that owns a symbol. Shared code is kept focused instead of being collected into another catch-all utility layer.

### Persistence relies on too much magic

The inherited data layer mixes active-record-style models, global registration, implicit field conversion, legacy schema patches, migration systems, and branches for database engines that iglo.monitor does not support.

That makes ordinary data changes difficult to trace and transaction ownership easy to get wrong. iglo.monitor keeps SQLite, makes store ownership explicit, and moves persistence behavior into visible mappings and transaction boundaries.

### Internal contracts are weak

Dynamic socket payloads, model shapes, callbacks, and service return values are often defined only by convention across distant call sites. TypeScript annotations cannot help much when entire modules opt out of checking or replace unknown contracts with broad `any` types.

The rewrite defines contracts at real boundaries and removes type-checking exceptions incrementally. The goal is not a cosmetic conversion to TypeScript; it is making invalid states and accidental coupling harder to create.

### The frontend repeats the same structural problems

Global mixins, root-instance state, and oversized screens make data ownership unclear and turn routine UI changes into cross-application work. Monitor configuration is especially difficult because every monitor type and advanced option competes inside one large editor.

iglo.monitor moves state into explicit stores and composables, and splits screens by behavior rather than by arbitrary file size.

### Architectural ambiguity causes correctness bugs

These are not purely aesthetic complaints. Unclear ownership has produced real problems around authentication, resource isolation, maintenance schedules, monitor cancellation, provider timeouts, transaction rollback, proxy handling, and cleanup during shutdown.

Tests can characterize those behaviors, but tests alone cannot make tangled ownership safe. The implementation also needs boundaries that make the correct behavior the natural behavior.

## The approach

iglo.monitor follows a few strict rules:

- one runtime, one package manager, one application database, and one release artifact;
- explicit dependencies and locally owned state instead of service locators and globals;
- focused modules and direct imports instead of god modules and barrels;
- automatic import at the SQLite database boundary, not compatibility aliases throughout the runtime;
- optional integrations loaded only when used;
- typed contracts introduced alongside the boundaries they describe;
- measured changes for performance-sensitive work;
- incremental replacement backed by tests rather than an all-at-once greenfield rewrite.

Bun is useful where its built-in server, WebSocket, SQLite, process, and build APIs remove machinery. It is not a target to optimize for at the expense of a clear design.

## Scope

iglo.monitor does not aim to mirror every Uptime Kuma feature, database, deployment method, or internal design choice. Features are kept when they are valuable and can be supported well. The only compatibility path is the automatic importer for supported Uptime Kuma SQLite databases; configuration, payload, and protocol names follow iglo.monitor directly.

The result should remain recognizable as a self-hosted uptime monitor while becoming substantially smaller, clearer, and easier to maintain.

## Credit and independence

iglo.monitor would not exist without Uptime Kuma. Louis Lam and the Uptime Kuma contributors created the product model, dashboard, monitor types, notification providers, status pages, translations, and years of practical behavior that form the starting point for this work.

That contribution deserves clear credit. The architectural criticism in this document explains why iglo.monitor takes a different direction; it does not erase the value of the product or the work behind it.

iglo.monitor is independently maintained, is not an official Uptime Kuma edition, and does not ask Uptime Kuma maintainers to support its design or migration decisions.
