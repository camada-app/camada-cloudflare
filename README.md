# Camada for Cloudflare

Keep bad actors out of a site that already runs on Cloudflare, with no code changes.

This Worker runs in your own Cloudflare account on a schedule. It never sits in front of your site. Every 5 minutes it:

1. Reads your zone's request analytics from Cloudflare (the same data as **Observability → Logs**) and sends it to Camada.
2. Keeps a `camada_block` IP list and one WAF custom rule in your account in sync with the IPs Camada blocks.

Your Cloudflare API token stays in your account. Camada never sees it.

> Status: preview.

## Install

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/camada-app/camada-cloudflare)

Cloudflare copies this repo to your GitHub account and deploys it. You may need to install the Cloudflare Workers and Pages GitHub app first. The prompts ask for:

- `CAMADA_KEY`: from the Camada dashboard.
- `CLOUDFLARE_API_TOKEN`: see below.
- `ZONE`: your domain, for example `example.com`.
- `HOSTS`: optional. Limits Camada to some hostnames.

Leave `CAMADA_URL` as it is.

### API token

[Create the token](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_waf%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_filter_lists%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Camada%20Doorway) with the link. It asks for four permissions:

- Zone > Analytics > Read
- Zone > Zone > Read
- Zone > Zone WAF > Edit
- Account > Account Filter Lists > Edit

Narrow the token to your one zone and your account. If the form shows fewer than four permissions, add the missing ones by hand.

## What to expect

- Works on every Cloudflare plan, including Free. It needs no Logpush, no Enterprise features and no storage.
- Blocks are by IP address and take about 10 to 17 minutes from the first bad request to the block. For blocking on the first request, use one of Camada's SDKs.
- Verified good bots (search engines and the like) are never blocked by the rule.
- If this Worker stops running, the rule expires on its own within 48 hours, so nothing stays blocked forever.
- The Worker creates one list, `camada_block`, and one custom rule, described as `camada:block v1`. It never touches lists or rules it didn't create.
- A Free plan allows 1 list and 5 custom rules. If there is no free slot, the Camada dashboard (Setup) shows what to fix. Analytics keep flowing meanwhile.

## Run locally

1. Copy `.dev.vars.example` to `.dev.vars` and fill in `CAMADA_KEY` and `CLOUDFLARE_API_TOKEN`.
2. Set `ZONE` in the `vars` of `wrangler.jsonc`, or in `.dev.vars`.
3. Run `npm run dev`.
4. Trigger one run: `curl "http://localhost:8787/__scheduled"`.

The path `/__scheduled` is what Wrangler 4.160.0 documents for `--test-scheduled`.

## Updating

Camada fixes most things on its side, so you don't need to do anything.

When the Camada dashboard (Setup) says your Worker is out of date:

1. Download the source code (zip) of the [latest release](https://github.com/camada-app/camada-cloudflare/releases/latest) and unzip it.
2. In your copy of this repo, replace the `src/` folder with the one you unzipped, then commit.
3. Cloudflare redeploys the Worker from that commit within a few minutes. Your settings (zone, hosts and secrets) are kept: they live in `wrangler.jsonc` and in Cloudflare, not in `src/`.

For one-click updates, add [`.github/workflows/update.yml`](https://github.com/camada-app/camada-cloudflare/blob/main/.github/workflows/update.yml) from this repo to your copy. After that, Actions, **Update Camada**, Run workflow does these steps for you.

## Uninstall

Do these in order:

1. Delete the Worker: Workers & Pages, pick the Worker, Settings, Delete.
2. Delete the rule: Security, WAF, Custom rules, `camada:block v1`, Delete. Delete only that rule, never the whole ruleset.
3. Delete the list: Manage Account, Configurations, Lists, `camada_block`, Delete.

The order matters because the rule uses the list, and a running Worker would recreate both.

## License

MIT
