# Doorway spike

**Status.** Part A (read-only) done 2026-11-09. Part B (live writes on `camada.dev`, host `cf-test.camada.dev`) ran 2026-11-09 17:47-18:01 UTC and cleaned up. Q1-Q4 are answered live. Q6 is PENDING: it needs Gabe's GitHub click (camada-all-2hh7).

Part B used the spike token (4 groups + DNS Edit). Still open for Gabe: the Q6 click (camada-all-2hh7), and revoking the spike token or letting it expire 2026-11-17 (see Resources).

Part A used a read-only token on camada.app and ran about 40 GraphQL queries. Part B made about 25 probe/trace requests over three attempts: attempt 1 stopped on an API 400 (IPv6 `/4` is illegal, see Q4); attempt 2 was killed by hand (the ray header was not parsed, so lag could not be measured). The EXIT trap cleaned up both; only the third attempt is reported.

Placeholders: `<zone>`, `<acc>`, `<ip-N>` / `<runner-ip>` (client IPs); ray, rule, ruleset, operation, list and DNS IDs cut to 6 chars (Part B probe rays to their last 6, `…xxxxxx`). Never put full values in this public file; full values live only in the factory run's evidence folder.

## Summary


| Q | Question | Status | Answer |
|---|---|---|---|
| Q1 | Minimal token | PROVEN (live) with the 4 groups + DNS Edit; template URL keys SKIPPED | Zone-scoped Analytics Read serves all three Adaptive datasets (no Account Analytics Read). Whether each group is needed stays DOCS. |
| Q2 | Free-plan block rule | PROVEN (live); `cf.client.bot` exemption DOCS | Free accepts the rule. Listed IP gets a Cloudflare 403 block page; unlisted IP and, after the deadline, the listed IP pass. |
| Q3 | Own-block marker | PROVEN (live) | `firewallEventsAdaptive.ruleId == our rule.id` (looked up by `ref`). `securitySource:"firewallCustom"` alone is not unique to us. |
| Q4 | List PUT behavior | PROVEN (live) | 1,001 items replace in under 2 s; no dip seen (min 1001). Concurrent PUTs get `429 / 10040`, not a "pending" error. IPv6 prefixes are /12-/128. |
| Q5 | GraphQL budget and paging | PROVEN (live, camada.app) | About 800 bytes per row. Rows, per-IP groups and total fit in one query. Page on `(datetime, rayName)`. |
| Q6 | Deploy button | PENDING (needs Gabe, camada-all-2hh7) | Needs Gabe's GitHub click. |

## What changed in the plan

1. **Endpoint.** Use `POST https://api.cloudflare.com/client/v4/graphql`. The path without `/v4` returns 404 (`code 10404`).
2. **Paging.** The ticket said to page on `datetime_geq` and dedupe by `rayName`. That fails. `datetime` has 1 s resolution and up to 165 rows share one second on camada.app. On the 934-row minute, with `limit:50`:

   | Method | Rows recovered | Result |
   |---|---|---|
   | `datetime_geq` + dedupe | 51 of 934 | stalls: once 50 rows share the cursor second, every page repeats |
   | `datetime_gt` | 453 of 934 | drops 481 rows (51.5%) |
   | `orderBy:[datetime_ASC, rayName_ASC]` with cursor `(datetime, rayName)` | 934 of 934 | 20 pages, no gaps, no loops |

   Keyset filter: `datetime_geq:$s, datetime_lt:$e, OR:[{datetime_gt:$s},{datetime:$s, rayName_gt:$r}]`.
   **Recommendation:** make this keyset the only paging mechanism, run over `[cursor, now - lag)` with an explicit `datetime_lt:$e` upper bound. Use a lag of at least 2 min (Q3 arrival lag); a cursor that reaches `now` skips late rows for good. Drop the epic's "split the window in half when full", which can't go below 1 s and so still fails on a second with more than 10,000 rows. At real load (Q5) one page usually covers a whole 5-minute tick, and a 30-day backfill is tens of pages, not hundreds of per-minute windows. Camada already keeps the cursor, so `/edge/rows` should reply with the next `(datetime, rayName)` cursor. That lets the Worker keep streaming bodies unparsed.
3. **No `sampleInterval` on rows.** `ZoneHttpRequestsAdaptive` has no such field. It exists only as `avg{sampleInterval}` in `httpRequestsAdaptiveGroups`. Rows are a sample (934 rows vs a groups `count` of 2562). Groups `count`/`sum` are sampling-scaled estimates, so volumes come from groups and rows are evidence. A groups result can also come back full (10,000 groups, e.g. more than 10,000 IPs), so treat that like a full rows page and check `sum(ips.count) == tot.count` at runtime.
4. **"No security event" is `"unknown"`, not empty.** Clean rows carry `securityAction:"unknown"` and `securitySource:"unknown"`. The mapper must treat `unknown` as none. A check against `""` matches every row.
5. **Own-block marker** (Q3): `firewallEventsAdaptive` filtered to our rule's `ruleId`, as one more alias in the same request. Contract:
   - Only the Worker creates the rule (when no rule has `ref:"camada_block_v1"`) and only PATCHes it after that, so `rule.id` stays stable. Keep `rule.id` from the create or PATCH response (the PATCH that pushes the deadline returns the ruleset), and re-GET the entrypoint only when nothing is stored or a PATCH returns 404. Keep every `rule.id` ever created and match on that set, so late events and backfill from an older rule still count as ours.
   - That dataset is sampled on its own, so a `rayName` join can miss blocks. Count our blocks from `firewallEventsAdaptiveGroups` filtered by `ruleId` (untested), and use joined rows only as per-request evidence, as in item 3.
   - Clip the firewall-events alias to the time range the rows page actually covered, so a full rows page doesn't skip or repeat events.
6. **Window budget.** 700-930 bytes per row, so a full 10,000-row page is 7-9.3 MB (numbers in Q5). Streaming keeps CPU low. Memory while streaming and a 9 MB `/edge/rows` page were not tested in Part B.
7. **One query carries everything.** Rows, per-IP groups and the total fit in one request. Full fields are proven up to 20 aliased windows; 30-50 used `rayName`+`datetime` only; 60 fail (Q5). With the keyset recommendation in item 2 this cap rarely matters.
8. **Range limit.** A query may span at most 4w2d, and retention is about 30 days. Backfill caps at 30 days.
9. **Token needs a 4th group, Zone > Zone > Read,** to resolve `ZONE` to zone and account IDs. Two of the template URL's short keys are unverified (see Q1).
10. **Item prefixes** are IPv4 `/8`-`/32` and IPv6 `/12`-`/128` (Q4), not the runbook's `/4`-`/64`.
11. **List writes converge.** One writer per account owns `camada_block` (two zones in one account must not share it). Each tick it PUTs the full desired list only when that differs from the last list sent, keeps the `operation_id` and checks it next tick instead of waiting. Concurrent PUTs return `429 / 10040`, Cloudflare's general rate limit, not a "pending" error (Q4). Handle 429 once, in the API client that every call uses (list PUT, deadline PATCH, GraphQL): skip the step and let the next tick catch up. Resolve `ZONE` to zone and account IDs once and store them.
12. **Limits found on Free.** `botManagementDecision` is denied (`authz` error), so never select it. A 7-day per-minute groups series hits the 10,000-group cap (10,080 minutes).

## Q1: minimal token

**Answer.** PROVEN (live) with the 4 groups + DNS Edit: reads, the list and the rule all worked on `camada.dev`. DNS Edit only creates the test record (no Worker call uses it), but no token with exactly the 4 groups was tested, so whether each group is needed stays DOCS. The permission groups come from Cloudflare's permissions reference and template-URL docs; the template URL and its short keys were not tested (see Not tested).

| Need | Group | Scope | Short key | Group ID |
|---|---|---|---|---|
| GraphQL `httpRequestsAdaptive`, `...Groups`, `firewallEventsAdaptive` | Zone > Analytics > Read | zone | `analytics` | not published |
| `GET /zones?name=` | Zone > Zone > Read | zone | `zone` | `c8fed203ed3043cba015a93ad1616f1f` (published in the create-token docs) |
| `http_request_firewall_custom` entrypoint and rules | Zone > Zone WAF > Edit | zone | `zone_waf` (guess) | not published |
| Account list create, PUT items, poll bulk ops | Account > Account Filter Lists > Edit | account | `account_filter_lists` (guess) | not published |

**Evidence (docs).**
- Create list and PUT items accept `Account Filter Lists Edit`. Get bulk operation accepts Edit or Read.
- The generic API reference for "Get entrypoint ruleset" and "Edit rule" does not list Zone WAF. The ruleset-engine zone pages do ("Zone WAF Write/Read"). Treat this as unproven.
- The docs do not say whether zone-scoped Analytics Read is enough for the Adaptive datasets. The GraphQL token guide shows the account-level "Account Analytics Read".
- Only the all-accounts and all-zones forms can be prefilled in the URL. Whoever creates the token narrows it to one zone and account in the form.

### Token template URL

Readable form:
```
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"analytics","type":"read"},{"key":"zone","type":"read"},{"key":"zone_waf","type":"edit"},{"key":"account_filter_lists","type":"edit"}]&accountId=*&zoneId=all&name=Camada%20Doorway
```
Link (the same URL; the `permissionGroupKeys` value is `encodeURIComponent(<the JSON array>)`):
```
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_waf%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_filter_lists%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Camada%20Doorway
```
**Caveat.** `zone_waf` and `account_filter_lists` are not in the documented key table. User-token URLs drop unmatched keys silently and don't accept group IDs. If the form shows fewer than 4 permissions, get the real keys from `GET /user/tokens/permission_groups`, or use the account-token form (`https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=...`), which accepts group IDs.

**Token gaps.** DNS Edit was added to the spike token only for the `cf-test.camada.dev` record. Q6's schedules check and Worker cleanup need Workers Scripts Read/Edit, and the Builds connection is dashboard only, so Q6 runs in Gabe's dashboard.

**Live evidence (2026-11-09).** Token: zone `camada.dev` = Analytics Read, Zone Read, Zone WAF Edit, DNS Edit; account = Account Filter Lists Edit. No account analytics group.
- `GET /user/tokens/verify` 200, status active. `GET /zones` 200, only `camada.dev` (Free Website).
- `GET /zones?name=camada.dev` 200. The result carries `account.id` (and the account name, not recorded here), so a one-zone token resolves the account ID.
- `POST /graphql` on `camada.dev`, last hour, the Q5 combined query (rows, ips, tot) plus `firewallEventsAdaptive`: HTTP 200, `errors` absent. 100 rows, 3 IP groups, `sum(ips.count) == tot.count == 100`, 0 firewall events. So zone-scoped Analytics Read serves `httpRequestsAdaptive`, `httpRequestsAdaptiveGroups` and `firewallEventsAdaptive` without Account Analytics Read.
- Zone WAF Edit: `GET .../rulesets/phases/http_request_firewall_custom/entrypoint` 404 (`code 10003`), then PUT 200, PATCH rule 200, `DELETE .../rulesets/<ruleset>` 204. Account Filter Lists Edit: create list, PUT items, get bulk operation, delete list all 200. DNS Edit: create and delete record 200. Nothing returned 401/403.

**Not tested** (no token edits or second token available): the template URL and its keys, dropping one group at a time, `GET /zones?name=` without Zone Read, and Zone WAF Edit alone.

Fallback body for `POST /accounts/{acc}/tokens`: the same groups by ID (`GET /accounts/{acc}/tokens/permission_groups` returns them), resources `com.cloudflare.api.account.zone.<zone>` and `com.cloudflare.api.account.<acc>`.

## Q2: rule on a Free zone

**Answer (live).** Free accepts the rule. `PUT /zones/<zone>/rulesets/phases/http_request_firewall_custom/entrypoint` (entrypoint was 404, so PUT created it with only our rule) returned 200. The `cf.client.bot` exemption cannot be tested from the runner; it stays DOCS.

**Evidence.**
```
PUT .../entrypoint  {"rules":[{"action":"block","description":"camada:block v1","ref":"camada_block_v1","enabled":true,
  "expression":"(ip.src in $camada_block and not cf.client.bot and http.request.timestamp.sec lt <edge-now+900> and http.host in {\"cf-test.camada.dev\"})"}]}
-> 200  ruleset.id 84812c, version "1", name "default", rules[0].id 098e94, ref camada_block_v1
```
The deadline came from the API `Date` header (edge clock) and never had to be pushed.

Probes (`curl -4 --resolve cf-test.camada.dev:443:<edge-ip> https://cf-test.camada.dev/`, one request each, `--max-time 15`). Pass = status other than 403; the `100::` origin gives 522.

| Step | Probe | Status | Ray |
|---|---|---|---|
| Runner listed (rule + list 8 s old) | listed#1 | 403 block page | …23ebd5 |
| | listed-extra#1, #2 | 403, 403 | …fc4cd0, …3c265b |
| List swapped to docs ranges only (op done 1.4 s) | docs-only#1 | 522 (pass) | …bef58d |
| Runner re-listed (op done 0.2 s) | relisted#1, 8 s apart #2 | 522, then 403 | …5e8f8a, …2c4cfe |
| Deadline PATCHed to now+120 (200); probe at deadline + 30 s | after-deadline#1 | 522 (pass) | …5e910c |

Findings: removing the runner from the list took effect within the first probe (about 2 s); re-adding took longer than 1 s (the first probe after the op was still a pass, the next one 8 s later blocked), so a list add can take several seconds at the edge. The dead-man's switch works: after the deadline the listed runner passed. The 403s carry the Cloudflare block page and a `cf-ray`.

## Q3: how our block shows up

**Answer (live, schema).** A managed-WAF block appears in `httpRequestsAdaptive` as `securityAction:"block"`, `securitySource:"firewallManaged"`, status 403. Rule detail lives only in `firewallEventsAdaptive` (`ruleId`, `rulesetId`, `description`, `action`, `source`, `rayName`). Join the two on `rayName`.

**Evidence.** Introspection (`__type(name:"ZoneHttpRequestsAdaptive")`, HTTP 200):
- Present: `securityAction`, `securitySource` (strings), `rulesMetadata{ruleId metadataKey metadataValue}`, `productMatches{product ruleIds rulesetId rulesetVersion}`, `requestSource`.
- Absent: row-level `ruleId`, `rulesetId`, `sampleInterval`.

24 h `firewallEventsAdaptive` query on Free (HTTP 200, `errors:null`, 20 rows):
```
firewallEventsAdaptive(limit:20, filter:{datetime_geq:$s, datetime_leq:$e}, orderBy:[datetime_DESC]){
  ruleId rulesetId description action source rayName kind matchIndex clientIP datetime }
```
This query used inclusive `datetime_leq`. Production windows are half-open (`datetime_lt`).
```json
{"action":"block","clientIP":"<ip-1>","datetime":"2026-11-09T16:03:03Z","description":"React - RCE - CVE:CVE-2025-55182","kind":"firewall","matchIndex":0,"rayName":"a57e0b","ruleId":"2b5d06…","rulesetId":"77454f…","source":"firewallManaged"}
```
The same ray in `httpRequestsAdaptive` with `OR:[{securityAction_neq:"unknown"},{securitySource_neq:"unknown"}]`:
```json
{"datetime":"2026-11-09T16:03:03Z","edgeResponseStatus":403,"productMatches":[],"rayName":"a57e0b","requestSource":"eyeball","rulesMetadata":[],"securityAction":"block","securitySource":"firewallManaged","verifiedBotCategory":""}
```
The 20 newest security rows were all one scanner burst; no custom-rule or bot source was seen.

**Marker (live).** Use `firewallEventsAdaptive.ruleId == our rule.id`, for the rule with `ref == "camada_block_v1"` (how the Worker tracks `rule.id`: What changed, item 5). `httpRequestsAdaptive` alone is not enough: our block and a customer's own custom rule both give `securitySource:"firewallCustom"`.

Blocked vs passed rays (probe rays cut to their last 6 chars, since the probes share a prefix; `rulesMetadata` and `productMatches` were `[]` on every row):

| Ray | Probe | `httpRequestsAdaptive` status / `securityAction` / `securitySource` | `firewallEventsAdaptive` `ruleId` / `rulesetId` / `description` / `action` / `source` |
|---|---|---|---|
| …23ebd5 | listed#1 | 403 / block / firewallCustom | 098e94 / 84812c / camada:block v1 / block / firewallCustom |
| …fc4cd0 | listed-extra#1 | 403 / block / firewallCustom | 098e94 / 84812c / camada:block v1 / block / firewallCustom |
| …3c265b | listed-extra#2 | 403 / block / firewallCustom | 098e94 / 84812c / camada:block v1 / block / firewallCustom |
| …2c4cfe | relisted#2 | 403 / block / firewallCustom | 098e94 / 84812c / camada:block v1 / block / firewallCustom |
| …bef58d | docs-only#1 (pass) | 522 / unknown / unknown | no event |
| …5e910c | after-deadline#1 (pass) | 522 / unknown / unknown | no event |

All 4 blocked rays carry the `ruleId` and none of the passed rays do. The `ruleId` and `rulesetId` match the PUT response, and the `description` is our `camada:block v1`. A customer can copy a description, so only `ruleId` is the marker. The `relisted#1` pass ray never appeared in `httpRequestsAdaptive` (sampled out, still absent after 5 min).

**Arrival lag.** Polled every 15 s from the first batch of probes to 5 min after the last probe. The last probe (polled right after sending) showed up in `httpRequestsAdaptive` within 31 s. The first batch showed up at 50-66 s after sending, but polling started late, so those are upper bounds. Firewall events arrived at 50-81 s (upper bounds; one ray was in `httpRequestsAdaptive` 15 s before its event). Use at least a 2 min lag behind `now`.

## Q4: list PUT

**Answer (live).**
- **Atomic:** no empty or doubled window seen. Three PUTs each replacing 1,001 items with a different 1,001 (B, A, B), polling `GET .../rules/lists/<list>` every 100 ms (33 readings): `num_items` min 1001, max 1002. The 1002 is the first reading, the list's state before the first replace (one item left from the `/65` test below); it was 1001 from then on. Never 0, never about 2,001. Caveat: this reads a count only, and the operations ran 0.7-1.7 s, so it is consistent with atomic, not a proof. The Worker can PUT the whole list (see What changed, item 11).
- **Timing:** `PUT .../items` with 1,001 items returns 200 and an `operation_id` (eecdcc) at once; the bulk operation was `completed` at the first poll (0.18 s after the poll began, 0.7 s from the PUT). Other operations took 0.2-1.7 s.
- **Pending operation:** not reproducible. A second PUT right after the first was accepted (200, its own `operation_id`, done in 0.2 s). Four concurrent PUTs: two 200, two `429`:
  ```
  {"success":false,"errors":[{"code":10040,"message":"you have been ratelimited please wait and try again"}]}
  ```
  So the only concurrency error is a 429 (`10040`).
- **Item formats accepted:** IPv4 single; `/8` (a /8 outside the doc ranges); `/24` of 198.51.100, 203.0.113 and 192.0.2; an explicit `/32`; IPv6 `/12`; IPv6 `/64` derived from 2001:db8::/32; IPv6 `/65` (legal). A 1,001-item list was accepted on Free. Overlapping items (a /24 and singles inside it) are accepted as separate items (`num_items` counts all 1,001).
- **Illegal items:** rejected synchronously with 400, no operation is created and the list is unchanged (`num_items` stayed 1002):
  ```
  IPv6 /4 : 400 code 10035 "invalid value for ip at position N: filters.api.IPv6 CIDRs should have a prefix length from /12 to /128 inclusive"
  IPv4 /7 : 400 code 10034 "invalid value for ip at position N: filters.api.IPv4 CIDRs should have a prefix length from /8 to /32 inclusive"
  ```

## Q5: GraphQL budget and paging

**Load, 7 days of eyeball traffic** (`httpRequestsAdaptiveGroups` by `datetimeMinute`, HTTP 200). The query returned exactly 10,000 groups, so it was cut off. The query used `orderBy:[count_DESC]` and the smallest count returned was 2, so the cut drops at most 80 minutes, all with a count of 2 or less. max is unaffected; p50 and p99 can shift by at most 40 and 1 ranks, and the total is low by at most about 160. Total count 54,021. Per minute: p50 3, p99 25, p99.9 382, max 2562 (estimated count).

**Size, 3 busiest minutes** (`httpRequestsAdaptive`, `limit:10000`, 0.5-0.75 s):

| Minute (UTC) | Rows | Groups `count` | Bytes | Bytes/row |
|---|---|---|---|---|
| 2026-11-04T03:22 | 934 | 2562 | 666,857 | 714 |
| 2026-11-05T23:49 | 237 | 809 | 220,246 | 929 |
| 2026-11-09T16:03 | 224 | 808 | 165,080 | 737 |

The 10,000-row cap was never reached, so its behavior is unobserved.

**Combined query** on the busiest minute, HTTP 200, 667,395 bytes:
```
rows: httpRequestsAdaptive(limit:10000, filter:{datetime_geq:$s, datetime_lt:$e, requestSource:"eyeball"}, orderBy:[datetime_ASC]){...}
ips:  httpRequestsAdaptiveGroups(limit:10000, filter:{same}){count avg{sampleInterval} dimensions{clientIP}}
tot:  httpRequestsAdaptiveGroups(limit:1, filter:{same}){count sum{edgeResponseBytes} avg{sampleInterval}}
```
This run used `orderBy:[datetime_ASC]` only; production must use `[datetime_ASC, rayName_ASC]`.
Result: 934 rows, 5 IP groups, `sum(ips.count) == tot.count == 2562`.

**Aliased windows.** Full field list: 5 and 20 one-minute windows returned HTTP 200. 30, 40 and 50 (`rayName`+`datetime` only) also returned 200. The 5-window test's windows held 934, 5, 26, 7 and 6 rows (row counts for the larger tests were not recorded). 60 returned HTTP 200 with `data:null` and error code `quota`: `In combination, your request queries too many nodes, zones and accounts`.

**Paging.** See the table under "What changed". Rate-limit (429) responses were not hit.

## Q6: Deploy button

**Open points:** are the `.dev.vars.example` secrets and the `package.json` `cloudflare.bindings` descriptions prompted, are `ZONE` and `HOSTS` vars prompted, does the cron survive.

**Status: PENDING (needs Gabe, camada-all-2hh7).** Not run in Part B: it needs Gabe's GitHub authorization.

**Runbook (step 7).**
1. Gabe opens `https://deploy.workers.cloudflare.com/?url=https://github.com/camada-app/camada-cloudflare`, picks the `camada-app` org and authorizes GitHub.
2. Record with screenshots (IDs cropped): whether `CAMADA_KEY` and `CLOUDFLARE_API_TOKEN` are prompted with their descriptions, and whether `ZONE`/`HOSTS` are prompted. Enter dummy values. Do not run the cron on real data.
3. Confirm the cron with `GET /accounts/<acc>/workers/scripts/<name>/schedules` (needs Workers Scripts Read, which the spike token lacks; use the dashboard or a token with it).
4. Clean up: delete the Worker, its Workers Builds connection and the clone repo.

## Resources created and deleted

Part A created nothing (see Status). Part B created the rows below on 2026-11-09 (UTC times from the third attempt; attempts 1-2 created and deleted the same DNS record, list and rule between 17:47 and 17:52). Each delete was checked with a GET that returned 404 or an empty list.

| Resource | Created | Deleted | Verified 404 |
|---|---|---|---|
| Account list `camada_block` (7a816d) | 17:52:42 | 18:01:25 | `GET .../rules/lists/<list>` 404; `GET .../rules/lists` returns 0 lists |
| Custom rule ref `camada_block_v1` (098e94) and its entrypoint ruleset (84812c, created by the spike, held only our rule) | 17:53:04 | 18:01:24 (`DELETE` ruleset 204) | `GET .../phases/http_request_firewall_custom/entrypoint` 404 |
| DNS record `cf-test.camada.dev` (AAAA `100::`, proxied) | 17:52:37 | 18:01:26 | `GET .../dns_records/<id>` 404; no record named `cf-test` remains |
| Cloned Worker | not created (Q6 pending) | | |
| Workers Builds connection | not created (Q6 pending) | | |
| Clone repo `camada-app/<clone>` | not created (Q6 pending) | | |
| Spike token | by Gabe (before Part B) | not deleted: Gabe revokes, or it expires 2026-11-17 | |
| Narrow Analytics-only token | not issued | | |
| "spike-ops" token | not issued | | |
| Read-only epic token | untouched | | |

Other records in the zone were never touched; a final read-only check confirmed them unchanged.
