# Camada for Cloudflare

Keep bad actors out of a site that already runs on Cloudflare, with no code changes.

This Worker runs in your own Cloudflare account on a schedule. It never sits in front of your site. Every 5 minutes it:

1. Reads your zone's request analytics from Cloudflare (the same data as **Observability → Logs**) and sends it to Camada.
2. Keeps a `camada_block` IP list and one WAF custom rule in your account in sync with the IPs Camada blocks.

Your Cloudflare API token stays in your account. Camada never sees it.

> Status: in development. Not ready to install yet.

## What to expect

- Works on every Cloudflare plan, including Free. It needs no Logpush, no Enterprise features and no storage.
- Blocks are by IP address and take about 10 to 17 minutes from the first bad request to the block. For blocking on the first request, use one of Camada's SDKs.
- Verified good bots (search engines and the like) are never blocked by the rule.
- If this Worker stops running, the rule expires on its own within 48 hours, so nothing stays blocked forever.

## Updating

Camada fixes most things on its side, so you don't need to do anything.

When the Camada dashboard (Setup) says your Worker is out of date, open your copy of this repo on GitHub. Go to Actions, pick **Update Camada**, then choose Run workflow. Cloudflare redeploys the Worker within a few minutes. Your settings (zone, hosts and secrets) are kept.

If Actions are off, copy the `src/` folder from the [latest release](https://github.com/camada-app/camada-cloudflare/releases) into your repo and commit it. Cloudflare redeploys when you push.

## License

MIT
