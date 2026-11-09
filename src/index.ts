// Camada for Cloudflare. Runs on a cron in the customer's own account and never on their traffic.
// Each tick (planned in camada-all, epic "Cloudflare doorway"):
//   1. ask Camada which 1-minute windows are due (Camada keeps every cursor: this Worker has no storage)
//   2. read those windows from Cloudflare's GraphQL Analytics (httpRequestsAdaptive, eyeball traffic) and
//      stream each response to Camada unparsed, so the tick stays inside the Free plan's 10 ms CPU
//   3. sync the camada_block list in this account from Camada's published blocks
//   4. report health to Camada; the Cloudflare token never leaves this account
// The tick itself lands with the Worker ticket; this file is the skeleton.

export interface Env {
  CAMADA_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  ZONE: string;
  HOSTS: string;
  CAMADA_URL: string;
}

/** The setup values that are missing, by name. Empty means the Worker can run. */
export function missingConfig(env: Partial<Env>): string[] {
  return (['CAMADA_KEY', 'CLOUDFLARE_API_TOKEN', 'ZONE'] as const).filter((k) => !env[k]?.trim());
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const missing = missingConfig(env);
    if (missing.length) {
      console.warn(`camada: not configured, missing ${missing.join(', ')}`);
      return;
    }
  },
} satisfies ExportedHandler<Env>;
