# Doorway spike

**Status.** Part A (read-only) done 2026-11-09. Part B (live writes) is pending and needs two things from Gabe:

1. A token made from the template URL below, saved in `.dev.vars` as `CLOUDFLARE_API_TOKEN`.
2. One click on the Deploy button's GitHub authorization (Q6).

Part A used a read-only token on camada.app and ran about 40 GraphQL queries. It created nothing in Cloudflare or GitHub.

Placeholders: `<zone>`, `<acc>`, `<ip-N>` (client IPs), ray IDs cut to 6 characters, rule IDs cut to 6 characters.

## Summary

| Q | Question | Status | Answer |
|---|---|---|---|
| Q1 | Minimal token | DOCS | 4 permission groups (Analytics Read, Zone Read, Zone WAF Edit, Account Filter Lists Edit). Two short keys are undocumented. |
| Q2 | Free-plan block rule | PENDING | Not tested. Docs allow 5 custom rules on Free. |
| Q3 | Own-block marker | Schema PROVEN (live); marker PENDING | Rows hold `securityAction`/`securitySource`. Rule detail is only in `firewallEventsAdaptive`. |
| Q4 | List PUT behavior | PENDING | Not tested. |
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

   Keyset filter: `datetime_geq:$s, OR:[{datetime_gt:$s},{datetime:$s, rayName_gt:$r}]`. The simplest path is still one `limit:10000` query per 1-minute window and a split when the window comes back full.
3. **No `sampleInterval` on rows.** `ZoneHttpRequestsAdaptive` has no such field. It exists only as `avg{sampleInterval}` in `httpRequestsAdaptiveGroups`, per window. Rows are a sample (934 rows vs a groups `count` of 2562, mean interval 2.74). `count` and `sum` in groups are sampling-scaled estimates. Treat row counts as lower bounds and take volumes from groups. (`firewallEventsAdaptive` does have `sampleInterval`.)
4. **"No security event" is `"unknown"`, not empty.** Rows without a security event carry `securityAction:"unknown"` and `securitySource:"unknown"`. The mapper must treat `unknown` as none. A check against `""` matches every row.
5. **Own-block marker (hypothesis until Part B).** `rulesMetadata` and `productMatches` are empty arrays on every blocked row on Free. The marker will probably have to come from `firewallEventsAdaptive.ruleId`/`rulesetId`, joined to http rows on `rayName`. Rows from our own custom rule may also show a distinct `securitySource` value, but custom rules from the customer would share it, so `ruleId == our rule.id` is the safe default. Part B step 6 decides.
6. **Window budget.** Measured 714, 929 and 737 bytes per row, so 700-930 bytes. A full 10,000-row window is about 7-9.3 MB. The Worker only streams the body (no parsing), so CPU stays low. Two things to confirm in Part B: memory stays flat while streaming, and Camada's `/edge/rows` accepts about 9 MB per window (more if several windows fill at once). Real load is far lower: p50 is 3 rows per minute, p99 is 25, the busiest minute in 7 days was 934 rows.
7. **One query carries everything.** `rows` (`httpRequestsAdaptive`), `ips` (groups by `clientIP`) and `tot` (groups, `limit:1`) for the same window fit in one request. Per-IP counts summed to the total (2562 = 2562). The query worked with up to 50 one-minute windows as aliases. With 60 it fails: `In combination, your request queries too many nodes, zones and accounts` (`code: quota`). The cap is probably tied to the summed `limit`; not tested further. Plan for at most 50 windows per request.
8. **Range limit.** A query may span at most 4w2d: `cannot request a time range wider than 4w2d`. Retention is about 30 days. The Worker's backfill after an outage must cap at 30 days and split into several queries.
9. **Token needs a 4th group.** Add Zone > Zone > Read to resolve `ZONE` to zone and account IDs (`GET /zones?name=`). The API reference lists only Zone Read for that call.
10. **Undocumented short keys.** `zone_waf` and `account_filter_lists` are guesses. They are not in the template-URL docs table. User-token URLs drop unknown keys silently, so check that all 4 rows appear when the URL is opened.
11. **Limits found on Free.** `botManagementDecision` is denied (`authz` error). Never select it. The `groups` query for a 7-day minute series hits the 10,000-group cap (10,080 minutes), so order by `count_DESC` or use shorter ranges.

## Q1: minimal token (DOCS)

**Answer.** Four permission groups cover reads, the list and the rule. The groups are from Cloudflare's permissions reference and template-URL docs, not proven with a live token.

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
- Only the all-accounts and all-zones forms can be prefilled in the URL. Gabe narrows to one zone and account in the form.

**Pending (Part B step 1).**
1. Open the template URL. Confirm 4 rows appear. If `zone_waf` or `account_filter_lists` is dropped, call `GET /user/tokens/permission_groups` for real names, or use the account-token form with group IDs.
2. With only Analytics Read in effect, run the Q5 query on camada.dev. If it fails, add Account Analytics Read.
3. Confirm the list and rule calls below work with exactly the 4 groups. Optionally drop one group at a time and record which call fails.
4. Check whether `GET /zones?name=` needs Zone Read (try without it) and still returns `account.id` on a one-zone token.
5. Check that GET entrypoint and PATCH rule work with Zone WAF Edit alone.

Fallback body for `POST /accounts/{acc}/tokens`: the same groups by ID (`GET /accounts/{acc}/tokens/permission_groups` returns them), resources `com.cloudflare.api.account.zone.<zone>` and `com.cloudflare.api.account.<acc>`.

## Q2: rule on a Free zone (PENDING)

**Answer.** Not tested. Expected: accepted, since Free allows 5 custom rules and `ip.src in $list` is allowed. The `cf.client.bot` exemption cannot be tested from the runner; it stays DOCS.

**Part B (steps 0, 4, 5).**
0. Preflight: load the token from `.dev.vars`. `GET /user/tokens/verify`. `GET /zones?name=camada.dev` and assert `name == "camada.dev"`. Use only that zone and its account in write URLs. `GET /accounts/{acc}/rules/lists`: if the Free list slot is taken, stop and ask. Never reuse or delete an existing list. Check `cf-test.camada.dev` resolves proxied; if absent, create a proxied `AAAA 100::` record and log it.
4. Create the rule: `PUT /zones/<zone>/rulesets/phases/http_request_firewall_custom/entrypoint`, or POST a rule to the entrypoint if it exists, leaving other rules untouched.
   ```
   expression: (ip.src in $camada_block and not cf.client.bot
                and http.request.timestamp.sec lt <now+900>
                and http.host in {"cf-test.camada.dev"})
   action: block, ref: "camada_block_v1", description: "camada:block v1"
   ```
   Record whether Free accepts it, plus `rule.id`, `ruleset.id` and `version`.
5. Effect: 3 curls from the runner (listed) to `https://cf-test.camada.dev/` should return a Cloudflare 403. Replace the list with documentation-range items only, wait for the operation, and re-curl: expect a pass. Re-list the runner, PATCH the deadline to now+120, wait it out, re-curl: expect a pass (dead-man's switch). Keep total probe traffic under 50 requests, no bursts. Record the curl status lines and the block-page ray.

## Q3: how our block shows up (schema PROVEN; marker PENDING)

**Answer (live, schema).** A managed-WAF block appears in `httpRequestsAdaptive` as `securityAction:"block"`, `securitySource:"firewallManaged"`, status 403. Rule detail lives only in `firewallEventsAdaptive` (`ruleId`, `rulesetId`, `description`, `action`, `source`, `rayName`). Join the two on `rayName`.

**Evidence.** Introspection (`__type(name:"ZoneHttpRequestsAdaptive")`, HTTP 200):
- Present: `securityAction`, `securitySource` (strings), `rulesMetadata{ruleId metadataKey metadataValue}`, `productMatches{product ruleIds rulesetId rulesetVersion}`, `requestSource`.
- Absent: row-level `ruleId`, `rulesetId`, `sampleInterval`.

24 h `firewallEventsAdaptive` query on Free (HTTP 200, `errors:null`, 20 rows):
```
firewallEventsAdaptive(limit:20, filter:{datetime_geq:$s, datetime_leq:$e}, orderBy:[datetime_DESC]){
  ruleId rulesetId description action source rayName kind matchIndex clientIP datetime }
```
```json
{"action":"block","clientIP":"<ip-1>","datetime":"2026-11-09T16:03:03Z","description":"React - RCE - CVE:CVE-2025-55182","kind":"firewall","matchIndex":0,"rayName":"a57e0b","ruleId":"2b5d06…","rulesetId":"77454f…","source":"firewallManaged"}
```
The same ray in `httpRequestsAdaptive` with `OR:[{securityAction_neq:"unknown"},{securitySource_neq:"unknown"}]`:
```json
{"datetime":"2026-11-09T16:03:03Z","edgeResponseStatus":403,"productMatches":[],"rayName":"a57e0b","requestSource":"eyeball","rulesMetadata":[],"securityAction":"block","securitySource":"firewallManaged","verifiedBotCategory":""}
```
Clean rows: `securityAction:"unknown"`, `securitySource:"unknown"`. The 20 newest security rows were all one scanner burst; no custom-rule or bot source was seen.

**Pending (Part B step 6).** Wait about 2 min after the Q2 curls. Pull the blocked `rayName`s from `httpRequestsAdaptive` (`securityAction`, `securitySource`, `rulesMetadata`, `productMatches`) and from `firewallEventsAdaptive` (`ruleId`, `rulesetId`, `description`, `action`, `source`). Put blocked and passed rays side by side. Pick the marker present on every blocked ray and absent on pass rays. Default: `firewallEventsAdaptive.ruleId == our rule.id`.

## Q4: list PUT (PENDING)

**Answer.** Not tested. Open points: is the replace atomic (no empty-list window), bulk-operation timing, the error when an operation is pending, item formats.

**Part B (steps 2, 3).**
2. `POST /accounts/<acc>/rules/lists {"name":"camada_block","kind":"ip"}`. `PUT .../items` with `[{"ip":"<runner-ip>","comment":"camada"}]` plus about 1,000 documentation-range items (198.51.100.0/24 singles, `2001:db8:N::/64`). Record the `operation_id`, poll `GET .../rules/lists/bulk_operations/{op}` until done, and time it. Send a second PUT while the first is pending and record the exact error. Item formats: IPv4 single and /8-/32, IPv6 /4-/64. Send one illegal item (`/65`) and record the error.
3. Atomicity: while a PUT replacing the 1,001 items runs, poll `GET .../items` every 250 ms for at most 60 s. Record the minimum count seen. Any 0 means the replace is not atomic, so the Worker must diff with POST/DELETE.

## Q5: GraphQL budget and paging (PROVEN, live on camada.app)

**Answer.** About 800 bytes per row; a full window is 7-9 MB. One query returns rows, per-IP counts and the total. Page with the `(datetime, rayName)` keyset (see "What changed").

**Load, 7 days of eyeball traffic** (`httpRequestsAdaptiveGroups` by `datetimeMinute`, HTTP 200). The query returned exactly 10,000 groups, so it was cut off (at most 80 low-count minutes missing). Total count 54,021. Per minute: p50 3, p99 25, p99.9 382, max 2562 (estimated count).

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
Result: 934 rows, 5 IP groups, `sum(ips.count) == tot.count == 2562`.

**Aliased windows.** 5, 20, 30, 40 and 50 one-minute windows returned HTTP 200. 60 returned the `quota` error above.

**Paging.** See the table under "What changed". Rate-limit (429) responses were not hit.

## Q6: Deploy button (PENDING)

**Answer.** Not tested. Open points: are the `.dev.vars.example` secrets and the `package.json` `cloudflare.bindings` descriptions prompted, are `ZONE` and `HOSTS` vars prompted, does the cron survive.

**Part B (step 7).**
1. Gabe opens `https://deploy.workers.cloudflare.com/?url=https://github.com/camada-app/camada-cloudflare`, picks the `camada-app` org and authorizes GitHub.
2. Record with screenshots (IDs cropped): whether `CAMADA_KEY` and `CLOUDFLARE_API_TOKEN` are prompted with their descriptions, and whether `ZONE`/`HOSTS` are prompted. Enter dummy values. Do not run the cron on real data.
3. Confirm the cron with `GET /accounts/<acc>/workers/scripts/<name>/schedules`.

## Token template URL

Four permission groups: Zone > Analytics > Read, Zone > Zone > Read, Zone > Zone WAF > Edit, Account > Account Filter Lists > Edit. The user-token form below prefills all zones and all accounts. Gabe narrows to the one zone and account in the form.

Raw:
```
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"analytics","type":"read"},{"key":"zone","type":"read"},{"key":"zone_waf","type":"edit"},{"key":"account_filter_lists","type":"edit"}]&accountId=*&zoneId=all&name=Camada%20Doorway
```
Encoded:
```
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_waf%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_filter_lists%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Camada%20Doorway
```
**Caveat.** `zone_waf` and `account_filter_lists` are not in the documented key table. User-token URLs drop unmatched keys silently and permission group IDs are not accepted there. When you open the URL, check that all 4 permissions are listed. If fewer show, use `GET /user/tokens/permission_groups` for the real keys, or the account-token form (`https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=...`), which accepts group IDs.

## Resources created and deleted

**Part A created nothing** in Cloudflare or GitHub. It made read-only GraphQL calls and docs reads only.

| Resource | Created | Deleted | Verified 404 |
|---|---|---|---|
| (none) | | | |

**Part B inventory template.** Fill in as the spike runs. Every row needs a GET returning 404 or absent.

| Resource | Created | Deleted | Verified 404 |
|---|---|---|---|
| Account list `camada_block` | | | |
| Custom rule ref `camada_block_v1` (and the entrypoint ruleset, only if the spike created it) | | | |
| DNS record `cf-test.camada.dev` (only if created) | | | |
| Cloned Worker | | | |
| Workers Builds connection | | | |
| Clone repo `camada-app/<clone>` (Gabe deletes, or grants `delete_repo`) | | | |
| Spike token (Gabe revokes) | | | |
| Read-only epic token (revoke unless the epic still needs it) | | | |
