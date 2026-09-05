# Auth, API key, and metrics security benchmark

Date: 2026-07-13 (Europe/Warsaw)

## Scope

This is a local, source-runtime security benchmark for authenticated `/metrics` rendering. It verifies that the
Prometheus response is filtered by the authenticated user and that monitor URL credentials/query secrets are not
published. It also records the small local timing, response-size, and RSS measurements produced by the same harness.

No public network, LXC, Docker, SSH, or remote service was used. The monitor URLs use `example.invalid`; only the
local push endpoint is called.

## Revisions

- Before runtime: `209259b1010fe9e7d4680c66393b228638885e7a`
- Previous runtime implementation commit: `0859db97ef4a5125828366e2794334b0dd7cd66d`
- Previous security-fix tree measured: `6151edc5baf375138b96c2b0c1296ee42d63c4d9`
- Final runtime tree measured: `db63e91246284d513154e32bd95026b5788f8c9a`
- Final test coverage commit: `5558d3924f67c8b8e9c999b588674f904b6c6feb`

The final measured tree preserves partial exact credential penalties through bounded-LRU churn. This report commit
follows the measured code commit; the reported SHA is the exact runtime tree used for the samples.

Both measured revisions used Bun `1.3.14` on macOS arm64 and the same installed dependencies. The baseline was a
detached local worktree. Each sample used a fresh temporary SQLite database and a fresh server process.

## Repo-native harness

The deterministic harness is [scripts/benchmark/auth-security-api-metrics.ts](../../scripts/benchmark/auth-security-api-metrics.ts).
For each sample it boots once to create the SQLite schema, inserts exactly two Argon2id users and two active `push`
monitors owned by different users, boots again, sends one real local `/api/push/:token` sample per monitor, warms each
authenticated metrics request once, then measures one concurrent pair of full-body `GET /metrics` responses. It records
ownership booleans, response bytes, per-user latency, pair latency, and RSS before/after the measured pair.

Baseline preparation and identical runs:

```bash
git worktree add --detach /tmp/iglo-monitor-baseline-auth 209259b1010fe9e7d4680c66393b228638885e7a
ln -s "$PWD/node_modules" /tmp/iglo-monitor-baseline-auth/node_modules
(cd /tmp/iglo-monitor-baseline-auth && bun run build:frontend)
bun scripts/benchmark/auth-security-api-metrics.ts \
  --repo=/tmp/iglo-monitor-baseline-auth --samples=3 \
  > /tmp/iglo-monitor-auth-metrics-before.jsonl
bun scripts/benchmark/auth-security-api-metrics.ts \
  --repo="$PWD" --samples=3 --expect-isolated=1 \
  > /tmp/iglo-monitor-auth-metrics-after.jsonl
```

`--expect-isolated=1` makes the final run fail if either user sees the other user's monitor or if the URL secret is
present. The baseline is deliberately run without that assertion so its failure is captured as data.

## Median summary

| Runtime revision | owner A (ms) | owner B (ms) | pair (ms) | response bytes | RSS before/after (KiB) | ownership   | URL secrets  |
| ---------------- | -----------: | -----------: | --------: | -------------: | ---------------------: | ----------- | ------------ |
| Before `209259b` |       70.075 |       82.188 |    82.247 |          1,622 |      154,848 / 220,560 | both leaked | both present |
| After `db63e912` |       96.407 |       96.297 |    96.432 |          1,118 |      157,296 / 255,808 | isolated    | absent       |

The median response body is 504 bytes smaller after filtering/redaction. Timing and RSS are intentionally reported as
local microbenchmark observations, not capacity claims; the endpoint includes password verification and process-level
allocation noise.

## Raw samples

Before:

```json
{"revision":"209259b1010fe9e7d4680c66393b228638885e7a","sample":1,"users":2,"monitors":2,"pushStatuses":[200,200],"ownerA":{"milliseconds":70.075,"bytes":1622,"owned":"benchmark-a-1","ownedPresent":true,"foreignPresent":true,"secretsPresent":true},"ownerB":{"milliseconds":82.188,"bytes":1622,"owned":"benchmark-b-1","ownedPresent":true,"foreignPresent":true,"secretsPresent":true},"pairMilliseconds":82.247,"rssBeforeKB":154848,"rssAfterKB":220528}
{"revision":"209259b1010fe9e7d4680c66393b228638885e7a","sample":2,"users":2,"monitors":2,"pushStatuses":[200,200],"ownerA":{"milliseconds":73.523,"bytes":1622,"owned":"benchmark-a-2","ownedPresent":true,"foreignPresent":true,"secretsPresent":true},"ownerB":{"milliseconds":83.034,"bytes":1622,"owned":"benchmark-b-2","ownedPresent":true,"foreignPresent":true,"secretsPresent":true},"pairMilliseconds":83.101,"rssBeforeKB":154944,"rssAfterKB":220624}
{"revision":"209259b1010fe9e7d4680c66393b228638885e7a","sample":3,"users":2,"monitors":2,"pushStatuses":[200,200],"ownerA":{"milliseconds":68.936,"bytes":1622,"owned":"benchmark-a-3","ownedPresent":true,"foreignPresent":true,"secretsPresent":true},"ownerB":{"milliseconds":80.874,"bytes":1622,"owned":"benchmark-b-3","ownedPresent":true,"foreignPresent":true,"secretsPresent":true},"pairMilliseconds":80.929,"rssBeforeKB":154848,"rssAfterKB":220560}
```

After (final `db63e912`, command above with `--expect-isolated=1`):

```json
{"revision":"db63e91246284d513154e32bd95026b5788f8c9a","sample":1,"users":2,"monitors":2,"pushStatuses":[200,200],"ownerA":{"milliseconds":96.407,"bytes":1118,"owned":"benchmark-a-1","ownedPresent":true,"foreignPresent":false,"secretsPresent":false},"ownerB":{"milliseconds":96.297,"bytes":1118,"owned":"benchmark-b-1","ownedPresent":true,"foreignPresent":false,"secretsPresent":false},"pairMilliseconds":96.432,"rssBeforeKB":156928,"rssAfterKB":255392}
{"revision":"db63e91246284d513154e32bd95026b5788f8c9a","sample":2,"users":2,"monitors":2,"pushStatuses":[200,200],"ownerA":{"milliseconds":108.526,"bytes":1118,"owned":"benchmark-a-2","ownedPresent":true,"foreignPresent":false,"secretsPresent":false},"ownerB":{"milliseconds":127.745,"bytes":1118,"owned":"benchmark-b-2","ownedPresent":true,"foreignPresent":false,"secretsPresent":false},"pairMilliseconds":127.832,"rssBeforeKB":157344,"rssAfterKB":255808}
{"revision":"db63e91246284d513154e32bd95026b5788f8c9a","sample":3,"users":2,"monitors":2,"pushStatuses":[200,200],"ownerA":{"milliseconds":78.431,"bytes":1118,"owned":"benchmark-a-3","ownedPresent":true,"foreignPresent":false,"secretsPresent":false},"ownerB":{"milliseconds":78.943,"bytes":1118,"owned":"benchmark-b-3","ownedPresent":true,"foreignPresent":false,"secretsPresent":false},"pairMilliseconds":78.997,"rssBeforeKB":157296,"rssAfterKB":255824}
```

## Credential-admission churn measurement

The partial-penalty raw runner applies 19/20 login-like or 59/60 API-like failed attempts, churns 1,001 foreign
identities, then repeats the target capacity. Before `b4f277c1`, all target attempts were admitted after eviction;
after `db63e912`, exactly one remaining attempt is admitted. The hot exact map remains capped at 100 entries. An exact
bucket is now evictable only when unused or fully refilled to capacity; a successful exact identity is deleted and is
therefore also safely evictable. When all 100 are protected, the fallback is two fixed 4,096-bucket token arrays: one
keyed by a process-randomized identity hash and one keyed by source. Thus the maximum credential-admission state is
16,584 buckets: the login and API-key limiters each have 100 exact buckets and two fixed 4,096-bucket arrays. This is
independent of churn; a success resets only its exact identity bucket, never the fixed fallback.

```json
{"revision":"b4f277c166f5eb2ec2cdd1cce59bd717d1d78fd7","cases":[{"identity":"login-admin","initialFailures":19,"churn":1001,"attemptsAfterChurn":20,"admitted":20,"exactBuckets":100},{"identity":"api-key:42","initialFailures":59,"churn":1001,"attemptsAfterChurn":60,"admitted":60,"exactBuckets":100}]}
{"revision":"db63e91246284d513154e32bd95026b5788f8c9a","cases":[{"identity":"login-admin","initialFailures":19,"churn":1001,"attemptsAfterChurn":20,"admitted":1,"exactBuckets":100},{"identity":"api-key:42","initialFailures":59,"churn":1001,"attemptsAfterChurn":60,"admitted":1,"exactBuckets":100}]}
```

The native gate covers present and fully blocked targets, table-driven login-like partial penalties of 1/5/19 with
19/15/1 remaining and API-like partial penalties of 1/30/59 with 59/30/1 remaining after 1,001-identity churn,
full-capacity late targets, valid-credential reset, full refill/TTL eviction, the deterministic 499/500 ms eviction
boundary, the 16,584-bucket production pair bound, source-first admission, and one target across distinct sources.
The production integration gate additionally covers WebSocket, HTTP Basic, and API-key partial penalties with 100
foreign identities per protocol path.

The fixed identity hash and source fallback are process-randomized. A collision can produce a bounded false-positive
throttle within one window; it cannot evict or reset a target's aggregate fallback penalty, and is not a shared global
overflow bucket. This is the remaining bounded collision trade-off for fixed memory.

## Limits

This is a single-process local microbenchmark, not a throughput, multi-core, or long-running memory test. Password
verification is part of the timed request, so the numbers do not isolate only the SQL ownership query and line filter.
RSS is sampled with `ps` around one request pair and is noisy. The security assertions are the meaningful result: the
baseline admits cross-user monitor data and URL secrets, while the final run passes the same harness with isolation
required.

## WebSocket peer-source follow-up

The source-runtime parent was `69ac7a9e25292b58eee3f7c8df05dd6ddd22e27b`. The final runtime commit is
`180c765fd9d90f4b8c314a91d85c19a451fca5cf` (`Use Bun peer IP for WebSocket rate limits`). The runtime change is one
WebSocket-upgrade input: it passes `bunServer.requestIP(request)?.address || ""` into the existing client-IP
canonicalization policy, matching the established HTTP `/metrics` path. Therefore, with `trustProxy=false`, a Bun peer
of `127.0.0.1` remains the source even when `X-Forwarded-For` and `X-Real-IP` are spoofed. With `trustProxy=true`, the
existing configured behavior deliberately uses forwarding headers; an operator enabling it must prevent direct access
to iglo.monitor, because this change does not add a trusted-proxy allowlist.

The production-path repro filled the 100 exact login identities with one failed login each, then made 250 invalid
WebSocket logins from one Bun peer through five rotating spoofed forwarding-header sets. On the parent runtime all
250 were admitted and the valid admin login passed. With the final runtime, each of three runs admitted 200 and blocked
50; the subsequent valid admin login was rate-limited. `requestIP` unavailable remains the prior bounded behavior:
the source is the empty string, so no synthetic address or untrusted header is introduced. The credential state bound
remains 16,584 buckets (unchanged exact-LRU and fixed fallback design).

New targeted coverage exercises the real upgrade path, untrusted-header rejection, explicit `trustProxy=true`
forwarding behavior, unavailable peer behavior, and the existing HTTP/API canonicalizer shared by the server. The
real WebSocket path asserts exactly `200 admitted / 50 blocked` from 250 overflow attempts and passed 20 consecutive
runs. The native timing/LRU matrix controls and restores `Date.now` in `finally` and passed 50 consecutive runs. Full
backend: `239 pass / 6 skip / 0 fail`; lint exits 0 with existing warnings; compiled auth: `13 pass / 0
fail`; compiled SMTP: `1 pass / 0 fail / 6 expect()`. Full source E2E passed twice (`31/31`, natural exit), the
proxy dialog regression passed 20 repeats, and the three auth UI cases passed 10 repeats each (`35` tests including
the five setup dependencies).

Final isolated benchmark, final runtime `180c765f`, command:

```bash
bun scripts/benchmark/auth-security-api-metrics.ts --repo="$PWD" --samples=3 --expect-isolated=1
```

| sample | owner A (ms) | owner B (ms) | pair (ms) | bytes | RSS before/after (KiB) |
| ------ | -----------: | -----------: | --------: | ----: | ---------------------: |
| 1      |       67.297 |       70.227 |    70.282 | 1,118 |      157,632 / 256,128 |
| 2      |       67.633 |       70.217 |    70.273 | 1,118 |      157,392 / 255,872 |
| 3      |       68.184 |       70.411 |    70.459 | 1,118 |      157,456 / 255,952 |
| median |       67.633 |       70.227 |    70.282 | 1,118 |      157,456 / 255,952 |

All samples enforced ownership isolation and secret redaction. This is a local, isolated measurement; the WebSocket
fix changes rate-limit attribution, not the `/metrics` rendering path.
