// Camada for Cloudflare. Runs on a cron in the customer's own account and never on their traffic.
// Each tick (planned in camada-all, epic "Cloudflare doorway"):
//   1. ask Camada which 1-minute windows are due (Camada keeps every cursor: this Worker has no storage)
//   2. read those windows from Cloudflare's GraphQL Analytics (httpRequestsAdaptive, eyeball traffic) and
//      stream each response to Camada unparsed, so the tick stays inside the Free plan's 10 ms CPU
//   3. sync the camada_block list in this account from Camada's published blocks
//   4. report health to Camada; the Cloudflare token never leaves this account

import { Budget, MAX_FETCHES, call, cf, cfHeaders, GRAPHQL, json, reconcileList, reconcileRule, type Run } from './cf';
import { VERSION } from './version';

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

type Errors = Partial<Record<'reconcile' | 'plan' | 'ship' | 'list' | 'rule', string>>;
type Cam = (path: string, init?: { method?: string; body?: BodyInit; headers?: Record<string, string> }, snap?: boolean) => Promise<Response>;
interface Tick {
  run: Run;
  cam: Cam;
  errors: Errors;
}

/** A condition that ends the tick without a status report (Camada would not know this install). */
class Stop extends Error {}

const KEY_MSG = 'Camada did not accept CAMADA_KEY. Copy it again from my.camada.app > Setup > Deploy on Cloudflare.';
const LIST_PERM = 'The API token cannot edit the camada_block list. Recreate it from Camada\'s Setup link (it needs Account > Account Filter Lists > Edit).';
const HEX = /^[0-9a-f]{32}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const clean = (s: unknown) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);

async function getPlan({ cam, errors }: Tick, zone: string, hosts: string): Promise<any | null> {
  const res = await cam(`/edge/plan?zone=${zone}&hosts=${encodeURIComponent(hosts)}`);
  const body = await json(res);
  if (res.status === 409) throw new Stop(`camada: ${clean(body?.error?.message ?? 'zone limit reached')}`);
  if (res.status === 400 && body?.error?.code === 'bad_hosts') errors.plan = body.error.message;
  else if (res.status !== 200) errors.plan = `Camada was busy (HTTP ${res.status}); the Worker retries in 5 minutes.`;
  else if (!Number.isFinite(Date.parse(body?.now))) errors.plan = 'Camada sent a plan the Worker could not read; it retries in 5 minutes.';
  else return body;
  return null;
}

/** Read each due window from Cloudflare and stream the reply, unparsed, to Camada. Returns windows shipped. */
async function ship({ run, cam, errors }: Tick, zone: string, windows: any): Promise<number> {
  let shipped = 0;
  for (const w of Array.isArray(windows) ? windows : []) {
    if (run.fetches + 5 > MAX_FETCHES) break; // keep 3 calls for the list sync and status; Camada's cursor resumes next tick
    if (typeof w?.query !== 'string' || typeof w.variables !== 'object' || !w.variables) {
      errors.ship = "Camada's server did not send the analytics query, so no data was sent. This clears itself when Camada updates; nothing to change on your side.";
      break;
    }
    const gql = await call(run, GRAPHQL, {
      method: 'POST',
      headers: { ...cfHeaders(run), 'accept-encoding': 'gzip' },
      body: JSON.stringify({ query: w.query, variables: w.variables }),
      encodeResponseBody: 'manual',
    });
    const enc = gql.headers.get('content-encoding');
    const gzip = enc === 'gzip';
    const refused =
      gql.status !== 200
        ? `Cloudflare refused the analytics read (HTTP ${gql.status}). Make sure the API token has Zone > Analytics > Read for this zone.`
        : enc && enc !== 'identity' && !gzip
          ? `Cloudflare answered with an encoding the Worker cannot pass on (${clean(enc)}).`
          : undefined;
    if (refused) {
      void gql.body?.cancel();
      errors.ship = refused;
      break;
    }
    const res = await cam(`/edge/rows?zone=${zone}&from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`, {
      method: 'POST',
      body: gql.body!,
      headers: { 'content-type': 'application/json', ...(gzip && { 'content-encoding': 'gzip' }) },
    });
    const reply = await json(res);
    if (res.status === 400 || res.status === 415 || res.status === 422) {
      errors.ship = `Camada could not read the analytics (${clean(reply?.error?.code)}: ${clean(reply?.error?.message)}).`;
      break;
    }
    if (res.status !== 200 || reply?.split) break; // split, 409, 413, 404, 429, 503: the next tick re-plans
    shipped++;
  }
  return shipped;
}

interface Sync {
  op?: { id: string; state: string; etag?: string | null; error?: string };
  overflow?: number;
  outcome: string;
}

/** Check a pending bulk operation, or else fetch Camada's list and replace ours with it. */
async function syncList({ run, cam, errors }: Tick, account: string, listId: string, plan: any): Promise<Sync> {
  const lists = `/accounts/${account}/rules/lists`;
  const pending = plan.pending_op;
  if (typeof pending === 'string' && ID.test(pending)) {
    const r = await cf(run, 'GET', `${lists}/bulk_operations/${pending}`);
    if (r.status === 404) return { op: { id: pending, state: 'failed', error: 'operation not found' }, outcome: 'op failed' };
    const state = r.result?.status;
    if (r.status !== 200 || typeof state !== 'string') {
      errors.list = r.status === 401 || r.status === 403 ? LIST_PERM : `Cloudflare would not report the list update: ${r.why}.`;
      return { outcome: 'op unknown' };
    }
    return { op: { id: pending, state, error: state === 'failed' ? clean(r.result.error) : undefined }, outcome: `op ${state}` };
  }

  const etag = plan.list_etag;
  const res = await cam('/edge/list', { headers: typeof etag === 'string' ? { 'if-none-match': etag } : {} }, true);
  if (res.status === 401) {
    errors.list = KEY_MSG;
    return { outcome: 'camada refused' };
  }
  if (res.status !== 200 && res.status !== 204) return { outcome: res.status === 304 ? 'not modified' : `camada HTTP ${res.status}` };

  const full = res.status === 200; // 204: Camada blocks nothing, so the list is emptied
  const put = await cf(run, 'PUT', `${lists}/${listId}/items`, full ? res.body! : '[]');
  if (put.status === 200 && put.result?.operation_id) {
    return {
      op: { id: put.result.operation_id, state: 'pending', etag: res.headers.get('etag') },
      overflow: full ? Number(res.headers.get('x-camada-overflow')) || 0 : 0,
      outcome: full ? 'updated' : 'emptied',
    };
  }
  errors.list =
    put.status === 401 || put.status === 403
      ? LIST_PERM
      : put.status === 429 || put.code === 10040
        ? 'Cloudflare is still applying an earlier list update; the Worker retries in 5 minutes.'
        : `Cloudflare rejected the block list: ${put.why}.`;
  return { outcome: 'rejected' };
}

async function tick(env: Env): Promise<void> {
  const key = env.CAMADA_KEY.trim();
  const dot = key.indexOf('.');
  if (dot < 1 || dot === key.length - 1) {
    console.warn('camada: CAMADA_KEY is not <ingest>.<snap>. Copy it again from my.camada.app > Setup > Deploy on Cloudflare.');
    return;
  }
  const [ingest, snap] = [key.slice(0, dot), key.slice(dot + 1)];
  const base = (env.CAMADA_URL || 'https://in.camada.app').replace(/\/$/, '');
  const run: Run = { fetches: 0, token: env.CLOUDFLARE_API_TOKEN.trim() };
  const cam: Cam = async (path, init = {}, snapAuth = false) => {
    const res = await call(run, base + path, {
      ...init,
      headers: {
        'x-camada-sdk': `@camada/cloudflare/${VERSION}`,
        ...(snapAuth ? { authorization: `Bearer ${snap}` } : { 'x-tenant': ingest }),
        ...init.headers,
      },
    });
    if (res.status === 401 && !snapAuth) throw new Stop(KEY_MSG);
    return res;
  };
  const errors: Errors = {};
  const t: Tick = { run, cam, errors };
  const status: Record<string, unknown> = { v: 1, version: VERSION };
  let shipped = 0;
  let list = 'skipped';

  try {
    const name = env.ZONE.trim().toLowerCase();
    const found = await cf(run, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    const z = found.status === 200 ? found.result?.[0] : null;
    if (!HEX.test(z?.id) || !HEX.test(z?.account?.id)) {
      throw new Stop(`camada: ZONE "${clean(name)}" was not found with this API token. Check ZONE, and that the token covers this zone (Zone > Zone > Read).`);
    }
    const zone: string = z.id;
    const account: string = z.account.id;
    Object.assign(status, { zone, account });

    const plan = await getPlan(t, zone, env.HOSTS ?? '');
    const hosts = Array.isArray(plan?.hosts) ? plan.hosts : (env.HOSTS ?? '').trim() === '' ? [] : null;
    const lst = await reconcileList(run, account);
    Object.assign(status, { list_id: lst.id, list_size: lst.size });
    if (lst.error) errors.reconcile = lst.error;
    else {
      // The deadline and the hosts clause come from the plan; the Worker never reads its own clock.
      const rule = await reconcileRule(run, zone, plan && { nowS: Math.floor(Date.parse(plan.now) / 1000), hosts, due: plan.deadline_due === true });
      Object.assign(status, { rule_id: rule.rule_id, deadline: rule.deadline });
      errors.rule = rule.error;
    }
    if (plan) {
      shipped = await ship(t, zone, plan.windows);
      if (lst.id) {
        const sync = await syncList(t, account, lst.id, plan);
        Object.assign(status, { op: sync.op, overflow: sync.overflow });
        list = sync.outcome;
      }
    }
  } catch (e) {
    if (e instanceof Stop) {
      console.warn(e.message);
      return;
    }
    console.warn(`camada: tick stopped early (${e instanceof Budget ? 'subrequest budget used up' : (e as Error).name})`);
  }
  if (!status.zone) return;

  const reported = Object.fromEntries(Object.entries(errors).filter(([, v]) => v).map(([k, v]) => [k, clean(v)]));
  for (const text of Object.values(reported)) console.warn(`camada: ${text}`);
  console.log(`camada: zone ${status.zone}, shipped ${shipped} windows, list ${list}, errors [${Object.keys(reported)}]`);
  await cam('/edge/status', {
    method: 'POST',
    body: JSON.stringify({ ...status, errors: reported }),
    headers: { 'content-type': 'application/json' },
  }).catch(() => console.warn('camada: status was not delivered'));
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const missing = missingConfig(env);
    if (missing.length) {
      console.warn(`camada: not configured, missing ${missing.join(', ')}`);
      return;
    }
    await tick(env);
  },
} satisfies ExportedHandler<Env>;
