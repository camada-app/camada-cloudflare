# Doorway spike

**Status.** Part A (read-only) done 2026-11-09. Part B (live writes) is pending and needs these from Gabe:

1. The spike token, made from the template URL below, saved in `.dev.vars` as `CLOUDFLARE_API_TOKEN`.
2. One click on the Deploy button's GitHub authorization (Q6).
3. The narrow Analytics-only token and the "spike-ops" token (DNS Edit, Workers Scripts Edit, API Tokens Read; see Q1). The dashboard can replace the spike-ops calls only; the Analytics-only token can't be replaced by the dashboard.
4. Token edits for the Q1 drop-one-group checks.
5. Cleanup only he can do: delete the clone repo, remove the Workers Builds connection, revoke the tokens.

Part A used a read-only token on camada.app and ran about 40 GraphQL queries. It created nothing in Cloudflare or GitHub.

Placeholders: `<zone>`, `<acc>`, `<ip-N>` (client IPs), ray IDs cut to 6 characters, rule IDs cut to 6 characters, all other IDs (operation, list, DNS record) cut to 6 chars. Part B records use the same placeholders (`<zone>`, `<acc>`, `<runner-ip>`; rays, rule and ruleset IDs cut to 6 chars). Never put full values in this public file; keep full values outside the repo (e.g. the factory run's evidence folder) only if needed.

## Summary

This table is the one place status is tracked. Update it when Part B runs.

| Q | Question | Status | Answer |
|---|---|---|---|
| Q1 | Minimal token | DOCS | 4 permission groups, see [Q1](#q1-minimal-token). |
| Q2 | Free-plan block rule | PENDING | The epic says Free allows 5 custom rules (unverified until Part B). |
| Q3 | Own-block marker | Schema PROVEN (live); marker PENDING | Rows hold `securityAction`/`securitySource`. Rule detail is only in `firewallEventsAdaptive`. |
| Q4 | List PUT behavior | PENDING | |
| Q5 | GraphQL budget and paging | PROVEN (live, camada.app) | About 800 bytes per row. Rows, per-IP groups and total fit in one query. Page on `(datetime, rayName)`. |
| Q6 | Deploy button | PENDING | Needs Gabe's GitHub click. |

## What changed in the plan

1. **Endpoint.** Use `POST https://api.cloudflare.com/client/v4/graphql`. The path without `/v4` returns 404 (`code 10404`).
2. **Paging.** The ticket said to page on `datetime_geq` and dedupe by `rayName`. That fails. `datetime` has 1 s resolution and up to 165 rows share one second on camada.app. On the 934-row minute, with `limit:50`:

   | Method | Rows recovered | Result |
   |---|---|---|
   | `datetime_geq` + dedupe | 51 of 934 | stalls: once 50 rows share the cursor second, every page repeats |
   | `datetime_gt` | 453 of 934 | drops 481 rows (51.5%) |
   | `orderBy:[datetime_ASC, rayName_ASC]` with cursor `(datetime, rayName)` | 934 of 934 | 20 pages, no gaps, no loops |

   Keyset filter: `datetime_geq:$s, datetime_lt:$e, OR:[{datetime_gt:$s},{datetime:$s, rayName_gt:$r}]`.
   **Recommendation:** make this keyset the only paging mechanism, run over `[cursor, now - lag)` with an explicit `datetime_lt:$e` upper bound. Rows are expected to arrive 1–2 min late (Part B step 6 measures it), and a cursor that reaches `now` skips late rows for good. Drop the epic's "split the window in half when full", which can't go below 1 s and so still fails on a second with more than 10,000 rows. At real load (Q5) one page usually covers a whole 5-minute tick, and a 30-day backfill is tens of pages, not hundreds of per-minute windows. Camada already keeps the cursor, so `/edge/rows` should reply with the next `(datetime, rayName)` cursor. That lets the Worker keep streaming bodies unparsed.
3. **No `sampleInterval` on rows.** `ZoneHttpRequestsAdaptive` has no such field. It exists only as `avg{sampleInterval}` in `httpRequestsAdaptiveGroups`. Rows are a sample (934 rows vs a groups `count` of 2562). Groups `count`/`sum` are sampling-scaled estimates, so volumes come from groups and rows are evidence. A groups result can also come back full (10,000 groups, e.g. more than 10,000 IPs), so treat that like a full rows page and check `sum(ips.count) == tot.count` at runtime.
4. **"No security event" is `"unknown"`, not empty.** Clean rows carry `securityAction:"unknown"` and `securitySource:"unknown"`. The mapper must treat `unknown` as none. A check against `""` matches every row.
5. **Own-block marker (hypothesis until Part B).** `rulesMetadata` and `productMatches` are empty on Free. The likely marker is `firewallEventsAdaptive` filtered server-side to our rule's `ruleId`, fetched as one more alias in the same request. Two cautions: that dataset is sampled on its own (it has its own `sampleInterval`), so a `rayName` join will miss some of our blocks; and `rule.id` changes if the rule is recreated, so look it up each tick from the stable `ref` while reading the entrypoint. `securitySource` alone can't tell our rule from a customer's own custom rules. Part B step 6 decides.
6. **Window budget.** 700-930 bytes per row, so a full 10,000-row page is 7-9.3 MB (numbers in Q5). Streaming keeps CPU low. Part B confirms that memory stays flat while streaming and that `/edge/rows` accepts about 9 MB per page.
7. **One query carries everything.** Rows, per-IP groups and the total fit in one request. Full fields are proven up to 20 aliased windows; 30-50 used `rayName`+`datetime` only; 60 fail (Q5). With the keyset recommendation in item 2 this cap rarely matters.
8. **Range limit.** A query may span at most 4w2d, and retention is about 30 days. Backfill caps at 30 days.
9. **Token needs a 4th group, Zone > Zone > Read,** to resolve `ZONE` to zone and account IDs. Two of the template URL's short keys are unverified (see Q1).
10. **Limits found on Free.** `botManagementDecision` is denied (`authz` error), so never select it. A 7-day per-minute groups series hits the 10,000-group cap (10,080 minutes).

## Q1: minimal token

**Answer.** Four permission groups cover reads, the list and the rule. They come from Cloudflare's permissions reference and template-URL docs and are not yet proven with a live token.

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

**Token gaps.** Part B calls outside the 4 groups: creating or deleting the `cf-test.camada.dev` DNS record (DNS Edit), `GET .../workers/scripts/<name>/schedules` (Workers Scripts Read), `GET .../tokens/permission_groups` (API Tokens Read), and the cleanup calls that delete the cloned Worker and check it is gone (Workers Scripts Edit/Read). Removing the Workers Builds connection is dashboard only. Make the API calls from Gabe's dashboard or with a separate short-lived "spike-ops" token (DNS Edit, Workers Scripts Edit, API Tokens Read), never the spike token, so the 4-group test stays clean. Step 2 below needs its own narrow Analytics-only token.

**Pending (Part B step 1).**
1. Open the template URL and check the caveat above.
2. With a separate narrow Analytics-only token, run the Q5 query on camada.dev. If it fails, add Account Analytics Read.
3. Confirm the list and rule calls below work with exactly the 4 groups. Optionally drop one group at a time and record which call fails.
4. Check whether `GET /zones?name=` needs Zone Read (try without it) and still returns `account.id` on a one-zone token.
5. Check that GET entrypoint and PATCH rule work with Zone WAF Edit alone.

Fallback body for `POST /accounts/{acc}/tokens`: the same groups by ID (`GET /accounts/{acc}/tokens/permission_groups` returns them), resources `com.cloudflare.api.account.zone.<zone>` and `com.cloudflare.api.account.<acc>`.

## Q2: rule on a Free zone

**Expected:** accepted, since the epic says Free allows 5 custom rules (unverified until Part B) and `ip.src in $list` is allowed. The `cf.client.bot` exemption cannot be tested from the runner; it stays DOCS.

**Part B (steps 0, 4, 5).**
0. Preflight: load the token from `.dev.vars`. `GET /user/tokens/verify`. `GET /zones?name=camada.dev` and assert `name == "camada.dev"`. Use only that zone and its account in write URLs. `GET /accounts/{acc}/rules/lists`: if the Free list slot (1 list; epic, unverified until Part B) is taken, stop and ask. Never reuse or delete an existing list. Check `cf-test.camada.dev` resolves proxied; if absent, create a proxied `AAAA 100::` record (via spike-ops or the dashboard) and log it.
4. Create the rule: GET the entrypoint. On 404, PUT it with only our rule. On 200, `POST /zones/<zone>/rulesets/<ruleset_id>/rules`. On anything else, stop. Never PUT an existing entrypoint (it replaces all custom rules). Cleanup deletes only our rule via `DELETE /zones/<zone>/rulesets/<ruleset_id>/rules/<rule_id>`.
   ```
   expression: (ip.src in $camada_block and not cf.client.bot
                and http.request.timestamp.sec lt <now+900>
                and http.host in {"cf-test.camada.dev"})
   action: block, ref: "camada_block_v1", description: "camada:block v1"
   ```
   Record whether Free accepts it, plus `rule.id`, `ruleset.id` and `version`.
5. Effect: 3 curls from the runner (listed) to `https://cf-test.camada.dev/` should return a Cloudflare 403. Replace the list with documentation-range items only, wait for the operation (same 1 s / 60 s bound as Q4), and re-curl: expect a pass. Re-list the runner, wait for the bulk op, and confirm one 403 BEFORE the next step (otherwise a later pass proves nothing). Then PATCH the deadline to now+120, sleep once until the deadline plus 30 s, re-curl: expect a pass (dead-man's switch). Pass means the status is not 403 (the `100::` origin gives a 5xx, never a 403). Secondary only: no firewall event for that ray, since that dataset is sampled and late. Keep total probe traffic under 50 requests, no bursts. Record the curl status lines and the block-page ray.

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

**Pending (Part B step 6).** Measure the arrival lag, and wait about 2 min after the Q2 curls. Pull the blocked `rayName`s from `httpRequestsAdaptive` (`securityAction`, `securitySource`, `rulesMetadata`, `productMatches`) and from `firewallEventsAdaptive` (`ruleId`, `rulesetId`, `description`, `action`, `source`). Put blocked and passed rays side by side. Pick the marker present on every blocked ray and absent on pass rays. Default: `firewallEventsAdaptive.ruleId == our rule.id`.

## Q4: list PUT

**Open points:** is the replace atomic (no empty-list window), bulk-operation timing, the error when an operation is pending, item formats.

**Part B (steps 2, 3).**
2. `POST /accounts/<acc>/rules/lists {"name":"camada_block","kind":"ip"}`. `PUT .../items` with `[{"ip":"<runner-ip>","comment":"camada"}]` plus about 1,000 documentation-range items (198.51.100.0/24 singles, `2001:db8:N::/64`). Record the `operation_id`, poll `GET .../rules/lists/bulk_operations/{op}` every 1 s for at most 60 s, and time it (a timeout is a result, record it). Send a second PUT while the first is pending and record the exact error. Item formats: IPv4 single and /8-/32, IPv6 /4-/64. Send one illegal item (`/65`) and record the error.
3. Atomicity: while a PUT replacing the list with a different 1,001 items (still including `<runner-ip>`, so the Q2 step-5 curls stay blocked) runs, poll `GET /accounts/<acc>/rules/lists/<list>` (one request; read `num_items`) every 500 ms for at most 60 s, then confirm any low reading with one `GET .../items` page. Paging `.../items` mid-replace would mix before and after. Record the minimum count seen. Any reading other than 1,001 means the replace is not atomic (the old and new sets share `<runner-ip>`, so a non-atomic replace may dip to 1 or rise to about 2,001, never 0), so the Worker must diff with POST/DELETE.

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

**Part B (step 7).**
1. Gabe opens `https://deploy.workers.cloudflare.com/?url=https://github.com/camada-app/camada-cloudflare`, picks the `camada-app` org and authorizes GitHub.
2. Record with screenshots (IDs cropped): whether `CAMADA_KEY` and `CLOUDFLARE_API_TOKEN` are prompted with their descriptions, and whether `ZONE`/`HOSTS` are prompted. Enter dummy values. Do not run the cron on real data.
3. Confirm the cron with `GET /accounts/<acc>/workers/scripts/<name>/schedules`.

## Resources created and deleted

Part A created nothing (see Status). **Part B inventory.** Fill in as the spike runs. Every row needs a GET returning 404 or absent.

| Resource | Created | Deleted | Verified 404 |
|---|---|---|---|
| Account list `camada_block` | | | |
| Custom rule ref `camada_block_v1` (and the entrypoint ruleset, only if the spike created it) | | | |
| DNS record `cf-test.camada.dev` (only if created) | | | |
| Cloned Worker | | | |
| Workers Builds connection | | | |
| Clone repo `camada-app/<clone>` (Gabe deletes, or grants `delete_repo`) | | | |
| Spike token (Gabe revokes) | | | |
| Narrow Analytics-only token (Gabe revokes) | | | |
| "spike-ops" token (Gabe revokes) | | | |
| Read-only epic token (revoke unless the epic still needs it) | | | |
