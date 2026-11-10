/// <reference types="@cloudflare/vitest-plugin/types" />
// The whole tick against a stateful fake of Cloudflare's API and Camada's /edge/*. Every fetch is recorded.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_DESC, LIST_NAME, RULE_DESC, RULE_REF, parseDeadline, ruleExpression } from '../src/cf';
import worker, { type Env } from '../src/index';
import { VERSION } from '../src/version';

const Z = 'a'.repeat(32);
const ACC = 'b'.repeat(32);
const TOKEN = 'cf-token-secret';
const env: Env = { CAMADA_KEY: 'ingest1.snap1', CLOUDFLARE_API_TOKEN: TOKEN, ZONE: ' Example.com ', HOSTS: '', CAMADA_URL: 'https://in.test/' };
const NOW = '2026-11-09T16:40:12Z';
const NOW_S = Date.parse(NOW) / 1000;
const GQL = 'https://api.cloudflare.com/client/v4/graphql';
const ENTRY = `/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint`;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Rec { method: string; url: string; headers: Record<string, string>; body: Uint8Array; init: any }
const ok = (result: unknown, status = 200) => Response.json({ success: status < 400, errors: [], result }, { status });
const bad = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
const gqlBytes = (i: number) => enc.encode(`{"data":{"i":${i}}}`);

const win = (i: number) => ({
  from: `2026-11-09T16:${10 + i}:00Z`,
  to: `2026-11-09T16:${11 + i}:00Z`,
  query: 'query($zone:String!){ rows }',
  variables: { zone: Z, from: `2026-11-09T16:${10 + i}:00Z`, to: `2026-11-09T16:${11 + i}:00Z` },
});
const mkPlan = (n = 0, over: object = {}) => ({
  v: 1, zone: Z, now: NOW, limit: 10000, hosts: [], windows: Array.from({ length: n }, (_, i) => win(i)),
  list_etag: null, pending_op: null, deadline_due: false, skipped: null, ...over,
});

let w: ReturnType<typeof fresh>;
function fresh() {
  return {
    calls: [] as Rec[],
    lists: [] as any[],
    entry: null as null | { id: string; rules: any[] },
    ops: {} as Record<string, string>,
    ruleSlotsFull: false,
    noZone: false,
    plan: mkPlan() as any,
    planReply: null as null | (() => Response),
    gql: (i: number): Response => new Response(gqlBytes(i)),
    rows: (_i: number): Response => Response.json({ ok: true }),
    list: (): Response => new Response(null, { status: 204, headers: { etag: '"cf1.none.10000"' } }),
    ids: 0,
  };
}

async function bytesOf(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response((body ?? null) as BodyInit | null).arrayBuffer());
}

async function fake(input: RequestInfo | URL, init: any = {}): Promise<Response> {
  const url = String(input);
  const method: string = init.method ?? 'GET';
  const body = await bytesOf(init.body);
  w.calls.push({ method, url, headers: Object.fromEntries(new Headers(init.headers)), body, init });
  const u = new URL(url);
  const json = () => JSON.parse(dec.decode(body));
  if (u.host === 'in.test') {
    const rows = w.calls.filter((c) => c.url.includes('/edge/rows')).length - 1;
    switch (u.pathname) {
      case '/edge/plan': return w.planReply ? w.planReply() : Response.json(w.plan);
      case '/edge/rows': return w.rows(rows);
      case '/edge/list': return w.list();
      case '/edge/status': return Response.json({ ok: true });
    }
    return new Response('?', { status: 500 });
  }
  const path = u.pathname.replace('/client/v4', '');
  const lists = `/accounts/${ACC}/rules/lists`;
  if (path === '/graphql') return w.gql(w.calls.filter((c) => c.url === GQL).length - 1);
  if (path === '/zones') return ok(w.noZone ? [] : [{ id: Z, account: { id: ACC } }]);
  if (path === lists && method === 'GET') return ok(w.lists);
  if (path === lists && method === 'POST') {
    const list = { id: 'list1', ...json(), num_items: 0 };
    w.lists.push(list);
    return ok(list);
  }
  if (path.startsWith(`${lists}/bulk_operations/`)) {
    const s = w.ops[path.split('/').pop()!];
    return s ? ok({ status: s, error: s === 'failed' ? 'boom' : undefined }) : bad(404, 10000, 'not found');
  }
  if (path === `${lists}/list1/items` && method === 'PUT') return ok({ operation_id: 'op1' });
  const ruleOf = (r: any) => ({ ...r, id: r.id ?? `r${++w.ids}` });
  if (path === ENTRY) {
    if (method === 'GET') return w.entry ? ok(w.entry) : bad(404, 10003, 'no entrypoint');
    w.entry = { id: 'rs1', rules: json().rules.map(ruleOf) };
    return ok(w.entry);
  }
  const sub = `/zones/${Z}/rulesets/rs1/rules`;
  if (path === sub && method === 'POST') {
    if (w.ruleSlotsFull) return bad(400, 20217, 'exceeded the maximum number of rules');
    w.entry!.rules.push(ruleOf(json()));
    return ok(w.entry);
  }
  if (path.startsWith(`${sub}/`) && method === 'PATCH') {
    const id = path.split('/').pop();
    w.entry!.rules = w.entry!.rules.map((r) => (r.id === id ? { ...json(), id } : r));
    return ok(w.entry);
  }
  return new Response('?', { status: 500 });
}

const logs: string[] = [];
beforeEach(() => {
  w = fresh();
  logs.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(fake as typeof fetch);
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(w.calls.length).toBeLessThanOrEqual(50);
  const text = (c: Rec) => `${c.url} ${JSON.stringify(c.headers)} ${dec.decode(c.body)}`;
  for (const c of w.calls) {
    if (c.url.startsWith('https://in.test')) expect(text(c)).not.toContain(TOKEN);
    else expect(text(c)).not.toMatch(/ingest1|snap1/);
  }
  expect(logs.join('\n')).not.toMatch(/cf-token-secret|ingest1|snap1/);
});

async function tick(over: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '*/5 * * * *' }), { ...env, ...over }, ctx);
  await waitOnExecutionContext(ctx);
}
const to = (method: string, part: string) => w.calls.filter((c) => c.method === method && c.url.includes(part));
const writes = () => w.calls.filter((c) => c.method !== 'GET' && c.url.includes('api.cloudflare.com') && !c.url.endsWith('/graphql'));
const status = () => JSON.parse(dec.decode(to('POST', '/edge/status').at(-1)!.body));
const deadline = (extra = 0) => NOW_S + 172800 + extra;

describe('reconcile', () => {
  it('a fresh install creates the list and the rule', async () => {
    await tick();
    expect(JSON.parse(dec.decode(to('POST', '/rules/lists')[0].body))).toEqual({ name: LIST_NAME, kind: 'ip', description: LIST_DESC });
    expect(to('GET', '/zones?name=example.com')).toHaveLength(1);
    const put = JSON.parse(dec.decode(to('PUT', 'entrypoint')[0].body));
    expect(put).toEqual({
      rules: [{
        action: 'block', description: RULE_DESC, ref: RULE_REF, enabled: true,
        expression: `(ip.src in $camada_block and not cf.client.bot and http.request.timestamp.sec lt ${deadline()})`,
      }],
    });
    expect(status()).toMatchObject({ v: 1, version: VERSION, zone: Z, account: ACC, list_id: 'list1', rule_id: 'r1', deadline: deadline(), list_size: 0, errors: {} });
  });

  it('a second tick is idempotent: no new list or rule, same ids', async () => {
    await tick();
    w.calls.length = 0;
    await tick();
    expect(writes().filter((c) => !c.url.endsWith('/items'))).toEqual([]);
    expect(status()).toMatchObject({ list_id: 'list1', rule_id: 'r1', deadline: deadline() });
  });

  it('a foreign list named camada_block is refused and reported, and shipping goes on', async () => {
    w.lists = [{ id: 'x', name: LIST_NAME, kind: 'ip', description: 'someone else', num_items: 4 }];
    w.plan = mkPlan(1);
    await tick();
    expect(writes()).toEqual([]);
    expect(to('GET', 'entrypoint')).toHaveLength(0);
    expect(status().errors.reconcile).toMatch(/was not created by Camada/);
    expect(status().list_id).toBeUndefined();
    expect(to('POST', '/edge/rows')).toHaveLength(1);
  });

  it('no free rule slot: reports the Cloudflare message, never PUTs the entrypoint, still ships', async () => {
    w.entry = { id: 'rs1', rules: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, ref: `theirs${i}`, description: 'theirs', expression: 'true' })) };
    w.ruleSlotsFull = true;
    w.plan = mkPlan(1);
    await tick();
    expect(to('POST', '/rulesets/rs1/rules')).toHaveLength(1);
    expect(to('PUT', 'entrypoint')).toHaveLength(0);
    expect(status().errors.rule).toMatch(/exceeded the maximum number of rules.*code 20217/);
    expect(to('POST', '/edge/rows')).toHaveLength(1);
  });

  it('an entrypoint without our rule gets it appended', async () => {
    w.entry = { id: 'rs1', rules: [{ id: 'c0', ref: 'theirs', description: 'theirs', expression: 'true' }] };
    await tick();
    expect(to('POST', '/rulesets/rs1/rules')).toHaveLength(1);
    expect(to('PUT', 'entrypoint')).toHaveLength(0);
    expect(w.entry!.rules.map((r) => r.id)).toEqual(['c0', 'r1']);
    expect(status().rule_id).toBe('r1');
  });

  it('a foreign rule with our ref is left alone', async () => {
    w.entry = { id: 'rs1', rules: [{ id: 'c0', ref: RULE_REF, description: 'theirs', expression: 'true' }] };
    await tick();
    expect(writes().filter((c) => c.url.includes('rulesets'))).toEqual([]);
    expect(status().errors.rule).toMatch(/was not created by Camada/);
  });

  it('a disabled rule of ours is reported', async () => {
    await tick();
    w.entry!.rules[0].enabled = false;
    await tick();
    expect(status().errors.rule).toMatch(/turned off/);
  });

  it('a disabled rule of ours stays disabled when the deadline is pushed', async () => {
    await tick();
    w.entry!.rules[0].enabled = false;
    w.plan = mkPlan(0, { now: '2026-11-09T17:40:12Z', deadline_due: true });
    await tick();
    expect(JSON.parse(dec.decode(to('PATCH', '/rules/r1').at(-1)!.body)).enabled).toBe(false);
  });

  it('a rule whose description only starts with ours is foreign', async () => {
    w.entry = { id: 'rs1', rules: [{ id: 'c0', ref: RULE_REF, description: 'camada:block v10', expression: 'true' }] };
    await tick();
    expect(writes().filter((c) => c.url.includes('rulesets'))).toEqual([]);
    expect(status().errors.rule).toMatch(/was not created by Camada/);
  });

  it('a list whose description only starts with ours (v10) is foreign', async () => {
    w.lists = [{ id: 'x', name: LIST_NAME, kind: 'ip', description: 'camada:block v10. other', num_items: 0 }];
    await tick();
    expect(status().errors.reconcile).toMatch(/was not created by Camada/);
  });

  it('a list reply that is not an array is reported, not thrown', async () => {
    w.lists = {} as any;
    await tick();
    expect(status().errors.reconcile).toMatch(/would not create the camada_block IP list/);
  });

  it('an entrypoint reply without an id changes nothing', async () => {
    w.entry = { rules: [] } as any;
    await tick();
    expect(writes().filter((c) => c.url.includes('rulesets'))).toEqual([]);
    expect(status().errors.rule).toMatch(/without an id/);
  });
});

describe('deadline and hosts', () => {
  it('pushes the deadline out by 48 h from the plan time when the plan says it is due', async () => {
    await tick();
    w.calls.length = 0;
    w.plan = mkPlan(0, { now: '2026-11-09T17:40:12Z', deadline_due: true });
    await tick();
    const patch = to('PATCH', '/rules/r1');
    expect(patch).toHaveLength(1);
    expect(JSON.parse(dec.decode(patch[0].body)).expression).toContain(`lt ${deadline(3600)}`);
    expect(status().deadline).toBe(deadline(3600));
  });

  it('pushes it on its own when under 24 h are left, without deadline_due (old analyst)', async () => {
    await tick();
    w.plan = mkPlan(0, { now: '2026-11-10T20:00:00Z' });
    await tick();
    expect(to('PATCH', '/rules/r1')).toHaveLength(1);
  });

  it('keeps the deadline when it is not due, and reports it', async () => {
    await tick();
    w.calls.length = 0;
    w.plan = mkPlan(0, { now: '2026-11-09T18:40:12Z' });
    await tick();
    expect(to('PATCH', '/rules/')).toHaveLength(0);
    expect(status().deadline).toBe(deadline());
  });

  it('a hosts change patches the expression and keeps the old deadline', async () => {
    await tick();
    w.calls.length = 0;
    w.plan = mkPlan(0, { now: '2026-11-09T18:40:12Z', hosts: ['a.example.com', 'b.example.com'] });
    await tick({ HOSTS: 'a.example.com,b.example.com' });
    expect(JSON.parse(dec.decode(to('PATCH', '/rules/r1')[0].body)).expression).toBe(
      `(ip.src in $camada_block and not cf.client.bot and http.request.timestamp.sec lt ${deadline()} and http.host in {"a.example.com" "b.example.com"})`,
    );
    expect(status().deadline).toBe(deadline());
    expect(to('GET', '/edge/plan')[0].url).toContain('hosts=a.example.com%2Cb.example.com');
  });

  it.each(['a.example.com" or true or http.host in {"x', 'A.example.com', 'a.example.com.', 'a.example.com:443'])('a host that is not a bare lowercase hostname never reaches a rule: %s', async (host) => {
    w.plan = mkPlan(0, { hosts: [host] });
    await tick();
    expect(to('PUT', 'entrypoint')).toHaveLength(0);
    expect(status().errors.rule).toMatch(/would not put in a rule/);
  });

  it('an analyst that does not echo hosts: fine for an empty HOSTS, an error otherwise', async () => {
    delete w.plan.hosts;
    await tick();
    expect(to('PUT', 'entrypoint')).toHaveLength(1);
    w.entry = null;
    w.calls.length = 0;
    await tick({ HOSTS: 'a.example.com' });
    expect(to('PUT', 'entrypoint')).toHaveLength(0);
    expect(status().errors.rule).toMatch(/cannot apply HOSTS yet/);
  });

  it('hosts refused but the deadline is due: our rule keeps its hosts clause and gets the new deadline', async () => {
    await tick();
    w.entry!.rules[0].expression = ruleExpression(['a.example.com'], deadline());
    w.calls.length = 0;
    w.plan = mkPlan(0, { now: '2026-11-09T17:40:12Z', hosts: ['bad host'], deadline_due: true });
    await tick({ HOSTS: 'bad host' });
    expect(JSON.parse(dec.decode(to('PATCH', '/rules/r1')[0].body)).expression).toBe(ruleExpression(['a.example.com'], deadline(3600)));
    expect(status().deadline).toBe(deadline(3600));
    expect(status().errors.rule).toMatch(/would not put in a rule/);
  });

  it('ruleExpression and parseDeadline', () => {
    expect(ruleExpression([], 5)).toBe('(ip.src in $camada_block and not cf.client.bot and http.request.timestamp.sec lt 5)');
    expect(ruleExpression(['a.com'], 5)).toMatch(/lt 5 and http\.host in \{"a\.com"\}\)$/);
    expect(ruleExpression(['a.com', 'b.com'], 5)).toMatch(/\{"a\.com" "b\.com"\}\)$/);
    expect(parseDeadline(ruleExpression(['a.com'], 1234))).toBe(1234);
    expect(parseDeadline('true')).toBeNull();
  });
});

describe('ship', () => {
  it('sends the plan query verbatim and passes each reply to Camada byte for byte', async () => {
    w.plan = mkPlan(5);
    w.gql = (i) => new Response(gqlBytes(i), i === 1 ? { headers: { 'content-encoding': 'gzip' }, encodeBody: 'manual' } as ResponseInit : undefined);
    await tick();
    const gql = w.calls.filter((c) => c.url === GQL);
    const rows = to('POST', '/edge/rows');
    expect(gql).toHaveLength(5);
    expect(rows).toHaveLength(5);
    gql.forEach((c, i) => {
      expect(c.method).toBe('POST');
      expect(dec.decode(c.body)).toBe(JSON.stringify({ query: w.plan.windows[i].query, variables: w.plan.windows[i].variables }));
      expect(c.init.encodeResponseBody).toBe('manual');
      expect(c.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'accept-encoding': 'gzip' });
      expect(rows[i].body).toEqual(gqlBytes(i));
      expect(rows[i].headers['content-encoding']).toBe(i === 1 ? 'gzip' : undefined);
      expect(rows[i].url).toBe(`https://in.test/edge/rows?zone=${Z}&from=${encodeURIComponent(w.plan.windows[i].from)}&to=${encodeURIComponent(w.plan.windows[i].to)}`);
    });
  });

  it('a split reply stops shipping for the tick, without an error', async () => {
    w.plan = mkPlan(5);
    w.rows = (i) => (i === 1 ? Response.json({ split: true, cursor: w.plan.windows[1].from }) : Response.json({ ok: true }));
    await tick();
    expect(w.calls.filter((c) => c.url === GQL)).toHaveLength(2);
    expect(status().errors).toEqual({});
  });

  it('a window without a query (old analyst) ships nothing and reports it', async () => {
    w.plan = mkPlan(2);
    for (const x of w.plan.windows) delete x.query;
    await tick();
    expect(w.calls.filter((c) => c.url === GQL)).toHaveLength(0);
    expect(status().errors.ship).toMatch(/did not send the analytics query/);
  });

  it('a Cloudflare GraphQL failure is reported and nothing is forwarded', async () => {
    w.plan = mkPlan(2);
    w.gql = () => new Response('nope', { status: 403 });
    await tick();
    expect(to('POST', '/edge/rows')).toHaveLength(0);
    expect(status().errors.ship).toMatch(/Cloudflare refused the analytics read \(HTTP 403\).*Analytics > Read/);
  });

  it('a Camada 503 on rows is reported as a retry; 409 and a 413 split stay silent', async () => {
    w.plan = mkPlan(2);
    w.rows = () => new Response('x', { status: 503 });
    await tick();
    expect(status().errors.ship).toBe('Camada did not take the analytics (HTTP 503); the Worker retries in 5 minutes.');
    w.rows = () => new Response('x', { status: 409 });
    await tick();
    expect(status().errors).toEqual({});
    w.rows = () => Response.json({ split: true }, { status: 413 });
    await tick();
    expect(status().errors).toEqual({});
  });

  it('a window without from/to (old analyst) ships nothing and reports it', async () => {
    w.plan = mkPlan(1);
    delete w.plan.windows[0].from;
    await tick();
    expect(w.calls.filter((c) => c.url === GQL)).toHaveLength(0);
    expect(status().errors.ship).toMatch(/did not send the analytics query/);
  });

  it('a Camada 422 on rows is reported with its message', async () => {
    w.plan = mkPlan(2);
    w.rows = () => Response.json({ error: { code: 'graphql_error', message: 'bad field' } }, { status: 422 });
    await tick();
    expect(w.calls.filter((c) => c.url === GQL)).toHaveLength(1);
    expect(status().errors.ship).toBe('Camada could not read the analytics (graphql_error: bad field).');
  });
});

describe('list sync', () => {
  const body = '[{"ip":"203.0.113.0/25","comment":"camada manual"}]';
  const items = () => to('PUT', '/rules/lists/list1/items');

  it('200: PUTs the list bytes, with If-None-Match and the snap token, and reports the pending op', async () => {
    w.plan = mkPlan(0, { list_etag: '"cf1.old.10000"' });
    w.list = () => new Response(body, { headers: { etag: '"cf1.new.10000"', 'x-camada-overflow': '3' } });
    await tick();
    const get = to('GET', '/edge/list')[0];
    expect(get.headers).toMatchObject({ 'if-none-match': '"cf1.old.10000"', authorization: 'Bearer snap1' });
    expect(get.headers['x-tenant']).toBeUndefined();
    expect(dec.decode(items()[0].body)).toBe(body);
    expect(status()).toMatchObject({ op: { id: 'op1', state: 'pending', etag: '"cf1.new.10000"' }, overflow: 3 });
  });

  it('304: no PUT', async () => {
    w.plan = mkPlan(0, { list_etag: '"cf1.x.10000"' });
    w.list = () => new Response(null, { status: 304 });
    await tick();
    expect(items()).toHaveLength(0);
    expect(status().op).toBeUndefined();
  });

  it('204: PUTs an empty list with the 204 etag', async () => {
    await tick();
    expect(dec.decode(items()[0].body)).toBe('[]');
    expect(status()).toMatchObject({ op: { id: 'op1', state: 'pending', etag: '"cf1.none.10000"' }, overflow: 0 });
  });

  it('a pending op still running: no /edge/list call, and no op in the status (keeps the saved etag)', async () => {
    w.plan = mkPlan(0, { pending_op: 'opP' });
    w.ops.opP = 'running';
    await tick();
    expect(to('GET', '/edge/list')).toHaveLength(0);
    expect(items()).toHaveLength(0);
    expect(status().op).toBeUndefined();
  });

  it('a completed or vanished op is reported and the list is not fetched this tick', async () => {
    w.plan = mkPlan(0, { pending_op: 'opP' });
    w.ops.opP = 'completed';
    await tick();
    expect(status().op).toEqual({ id: 'opP', state: 'completed' });
    delete w.ops.opP;
    await tick();
    expect(status().op).toEqual({ id: 'opP', state: 'failed', error: 'operation not found' });
    expect(to('GET', '/edge/list')).toHaveLength(0);
  });

  it('Cloudflare still busy with an earlier update (429): reported, retried next tick', async () => {
    w.list = () => new Response(body, { headers: { etag: '"cf1.new.10000"' } });
    const real = fake;
    vi.mocked(fetch).mockImplementation((async (i: any, init: any) =>
      String(i).endsWith('/items') ? bad(429, 10040, 'busy') : real(i, init)) as typeof fetch);
    await tick();
    expect(status().errors.list).toMatch(/still applying an earlier list update/);
  });

  it('a snap token Camada refuses is reported without stopping the status', async () => {
    w.list = () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    await tick();
    expect(status().errors.list).toMatch(/did not accept CAMADA_KEY/);
  });
});

describe('budget', () => {
  it('the worst tick (fresh install, 20 windows, list 200) stays within 50 subrequests', async () => {
    w.plan = mkPlan(20);
    w.list = () => new Response('[]', { headers: { etag: '"cf1.a.10000"' } });
    await tick();
    expect(w.calls).toHaveLength(49);
    expect(to('POST', '/edge/rows')).toHaveLength(20);
  });

  it('a 25-window plan ships 20 and still posts status', async () => {
    w.plan = mkPlan(25);
    await tick();
    expect(w.calls.filter((c) => c.url === GQL)).toHaveLength(20);
    expect(to('POST', '/edge/status')).toHaveLength(1);
    expect(w.calls.length).toBeLessThanOrEqual(50);
  });
});

describe('Camada calls and stops', () => {
  it('every Camada call carries x-camada-sdk with the version; plan, rows and status use x-tenant', async () => {
    w.plan = mkPlan(1);
    w.list = () => new Response('[]', { headers: { etag: '"e"' } });
    await tick();
    const camada = w.calls.filter((c) => c.url.startsWith('https://in.test/'));
    expect(camada.map((c) => new URL(c.url).pathname)).toEqual(['/edge/plan', '/edge/rows', '/edge/list', '/edge/status']);
    for (const c of camada) {
      expect(c.headers['x-camada-sdk']).toBe(`@camada/cloudflare/${VERSION}`);
      if (c.url.includes('/edge/list')) expect(c.headers.authorization).toBe('Bearer snap1');
      else expect(c.headers).toMatchObject({ 'x-tenant': 'ingest1' });
    }
    expect(camada[0].url).toBe(`https://in.test/edge/plan?zone=${Z}&hosts=`);
  });

  it('bad_hosts: the server message becomes errors.plan, status is posted, nothing ships or is written to the rule', async () => {
    const message = 'HOSTS entry "*.x.com" is not a hostname. Set HOSTS to comma-separated hostnames.';
    w.planReply = () => Response.json({ error: { code: 'bad_hosts', message } }, { status: 400 });
    await tick({ HOSTS: '*.x.com' });
    expect(status().errors).toEqual({ plan: message });
    expect(w.calls.filter((c) => c.url === GQL)).toHaveLength(0);
    expect(to('PUT', 'entrypoint')).toHaveLength(0);
    expect(to('GET', '/edge/list')).toHaveLength(0);
    expect(status()).toMatchObject({ list_id: 'list1' });
  });

  it('bad_hosts without a message falls back to a fixed one', async () => {
    w.planReply = () => Response.json({ error: { code: 'bad_hosts' } }, { status: 400 });
    await tick({ HOSTS: 'x' });
    expect(status().errors.plan).toMatch(/^Camada did not accept HOSTS\. Set HOSTS/);
  });

  it('a Cloudflare fetch that rejects ends the tick early, reports it, and still posts status', async () => {
    const real = fake;
    vi.mocked(fetch).mockImplementation((async (i: any, init: any) => {
      if (String(i).endsWith(ENTRY)) throw new TypeError('network down');
      return real(i, init);
    }) as typeof fetch);
    await tick();
    expect(status().errors.reconcile).toBe('The tick stopped early (TypeError: network down); the Worker retries in 5 minutes.');
  });

  it('a 401 on /edge/status logs the CAMADA_KEY message', async () => {
    const real = fake;
    vi.mocked(fetch).mockImplementation((async (i: any, init: any) =>
      String(i).endsWith('/edge/status') ? new Response('x', { status: 401 }) : real(i, init)) as typeof fetch);
    await tick();
    expect(logs.join('\n')).toContain('did not accept CAMADA_KEY');
  });

  it('a busy Camada (503) is reported as errors.plan and the rule is left alone', async () => {
    w.planReply = () => new Response('x', { status: 503 });
    await tick();
    expect(status().errors.plan).toBe('Camada was busy (HTTP 503); the Worker retries in 5 minutes.');
    expect(to('PUT', 'entrypoint')).toHaveLength(0);
  });

  it('a Camada 401 stops the tick with no status', async () => {
    w.planReply = () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    await tick();
    expect(to('POST', '/edge/status')).toHaveLength(0);
    expect(w.calls).toHaveLength(2);
    expect(logs.join()).toMatch(/did not accept CAMADA_KEY/);
  });

  it('plan 409 zone_limit stops with no status', async () => {
    w.planReply = () => Response.json({ error: { code: 'zone_limit', message: 'At most 3 zones.' } }, { status: 409 });
    await tick();
    expect(to('POST', '/edge/status')).toHaveLength(0);
    expect(logs.join()).toMatch(/At most 3 zones/);
  });

  it('a zone this token cannot see stops with a clear log and no status', async () => {
    w.noZone = true;
    await tick();
    expect(w.calls).toHaveLength(1);
    expect(logs.join()).toMatch(/ZONE "example.com" was not found/);
  });

  it('a CAMADA_KEY without a dot stops before any call', async () => {
    await tick({ CAMADA_KEY: 'nodot' });
    expect(w.calls).toHaveLength(0);
  });

  it('an unconfigured Worker makes no call', async () => {
    await tick({ ZONE: '' });
    expect(w.calls).toHaveLength(0);
  });

  it('logs one summary and one warning per error, with no secrets', async () => {
    w.lists = [{ id: 'x', name: LIST_NAME, kind: 'ip', description: 'theirs' }];
    await tick();
    expect(logs.filter((l) => l.startsWith('camada: zone'))).toHaveLength(1);
    expect(logs.filter((l) => /not created by Camada/.test(l))).toHaveLength(1);
  });
});
