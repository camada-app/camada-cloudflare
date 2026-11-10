// Everything the Worker says to Cloudflare's API, except the analytics read (index.ts ships that).
// Every fetch goes through call(), which counts it: Workers Free allows 50 subrequests a tick.

export const CF = 'https://api.cloudflare.com/client/v4';
export const GRAPHQL = `${CF}/graphql`;
export const MAX_FETCHES = 50;

// How we recognise what is ours. A list or rule with our name but without the marker is never written.
export const LIST_NAME = 'camada_block';
export const LIST_DESC =
  'camada:block v1. Managed by the Camada Worker. To uninstall, delete the Worker, then its rule, then this list.';
export const RULE_REF = 'camada_block_v1';
export const RULE_DESC = 'camada:block v1';

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY = 86400;

export class Budget extends Error {}

export interface Run {
  fetches: number;
  token: string; // the Cloudflare API token: only ever sent to api.cloudflare.com
}

export function call(run: Run, url: string, init: RequestInit): Promise<Response> {
  if (++run.fetches > MAX_FETCHES) throw new Budget();
  return fetch(url, init);
}

export interface CfReply {
  status: number;
  result: any; // Cloudflare's small JSON replies only; analytics rows are never parsed
  code?: number;
  why: string; // `"<message>" (code <n>)` of errors[0], or the HTTP status
}

/** The headers of every Cloudflare API call, the analytics read included. The token goes nowhere else. */
export const cfHeaders = (run: Run) => ({ authorization: `Bearer ${run.token}`, 'content-type': 'application/json' });

/** A small JSON reply, or null. */
export const json = (res: Response) => res.json<any>().catch(() => null);

export async function cf(run: Run, method: string, path: string, body?: BodyInit): Promise<CfReply> {
  const res = await call(run, CF + path, { method, headers: cfHeaders(run), body });
  const reply = await json(res);
  const e = reply?.errors?.[0];
  return {
    status: res.status,
    result: reply?.result,
    code: e?.code,
    why: e ? `"${String(e.message).slice(0, 120)}" (code ${e.code})` : `HTTP ${res.status}`,
  };
}

// http.host is matched normalised (lowercase, no port, no trailing dot; checked live on a Free zone,
// camada-all-tz8g), so a plain `in` set needs no port or dot variants, unlike the GraphQL host filter.
// This relies on every entry the Worker writes being a bare lowercase hostname, which HOST and the server's bad_hosts check enforce.
export const ruleExpression = (hosts: string[], deadline: number): string =>
  `(ip.src in $camada_block and not cf.client.bot and http.request.timestamp.sec lt ${deadline}` +
  (hosts.length ? ` and http.host in {${hosts.map((h) => `"${h}"`).join(' ')}}` : '') +
  ')';

export const parseDeadline = (expression: string): number | null => {
  const m = /http\.request\.timestamp\.sec lt (\d+)/.exec(expression ?? '');
  return m ? Number(m[1]) : null;
};

export interface ListResult {
  id?: string;
  size?: number;
  error?: string;
}

/** Find our camada_block list, or create it. Never touches a list we did not make. */
export async function reconcileList(run: Run, account: string): Promise<ListResult> {
  const path = `/accounts/${account}/rules/lists`;
  const cannot = (why: string) =>
    `Cloudflare would not create the camada_block IP list: ${why}. Free plans allow one custom list: delete an unused list, or make sure the API token has Account > Account Filter Lists > Edit.`;
  const got = await cf(run, 'GET', path);
  if (got.status !== 200) return { error: cannot(got.why) };
  if (got.status === 200 && !Array.isArray(got.result)) return { error: cannot(got.why) };
  const same = (got.result as any[]).filter((l) => l.name === LIST_NAME);
  const ours = same.find((l) => l.kind === 'ip' && String(l.description).startsWith(RULE_DESC + '.'));
  if (ours) return { id: ours.id, size: ours.num_items };
  if (same.length) {
    return {
      error:
        'An IP list named camada_block already exists in this Cloudflare account and was not created by Camada, so it was left alone. Rename or delete it under Manage Account > Configurations > Lists, and the Worker will create its own.',
    };
  }
  const made = await cf(run, 'POST', path, JSON.stringify({ name: LIST_NAME, kind: 'ip', description: LIST_DESC }));
  return made.status === 200 ? { id: made.result.id, size: 0 } : { error: cannot(made.why) };
}

export interface RulePlan {
  nowS: number; // the server's clock, from the plan
  hosts: string[] | null; // null: an old analyst that does not echo hosts
  due: boolean; // the plan's deadline_due
}

export interface RuleResult {
  rule_id?: string;
  deadline?: number;
  error?: string;
}

/**
 * Find our custom rule, or append it, and push its deadline out when due. plan null means no write this tick
 * (the plan failed), but we still report the rule that is there. Never PUTs an existing entrypoint.
 */
export async function reconcileRule(run: Run, zone: string, plan: RulePlan | null): Promise<RuleResult> {
  const path = `/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const perm = 'The API token cannot edit WAF custom rules. Recreate it from Camada\'s Setup link (it needs Zone > Zone WAF > Edit).';
  const got = await cf(run, 'GET', path);
  if (got.status === 401 || got.status === 403) return { error: perm };
  if (got.status !== 200 && got.status !== 404) return { error: `Cloudflare would not read the zone's custom rules: ${got.why}.` };
  const rs = got.status === 200 ? got.result : null;
  if (got.status === 200 && typeof rs?.id !== 'string') {
    return { error: "Cloudflare returned the zone's custom rules without an id; the rule was left unchanged." };
  }
  const rules: any[] = rs?.rules ?? [];
  const mine = rules.find((r) => r.ref === RULE_REF && r.description === RULE_DESC);
  if (!mine && rules.some((r) => r.ref === RULE_REF)) {
    return {
      error:
        'A custom rule using Camada\'s reference camada_block_v1 exists but was not created by Camada, so it was left alone. Delete it if it is a leftover.',
    };
  }
  const d0 = mine ? parseDeadline(mine.expression) : null;
  const seen: RuleResult = { rule_id: mine?.id, deadline: d0 ?? undefined };
  const off = mine?.enabled === false ? 'The Camada WAF rule is turned off. Turn it on under Security > WAF > Custom rules to enforce blocks.' : undefined;
  if (!plan) return { ...seen, error: off };

  const { nowS, hosts } = plan;
  // Hosts we cannot apply must not stop the deadline: our rule keeps its own hosts clause and gets a new number.
  const refused = !hosts
    ? "Camada's server cannot apply HOSTS yet; the rule was left unchanged."
    : hosts.length > 20 || !hosts.every((h) => typeof h === 'string' && HOST.test(h))
      ? 'Camada sent a host name the Worker would not put in a rule; the rule was left unchanged. Check HOSTS.'
      : undefined;
  if (refused && !mine) return { ...seen, error: refused };
  const deadline = plan.due || d0 == null || d0 - nowS < DAY ? nowS + 2 * DAY : d0;
  const expression = refused
    ? mine.expression.replace(/(http\.request\.timestamp\.sec lt )\d+/, `$1${deadline}`)
    : ruleExpression(hosts!, deadline);
  if (mine && expression === mine.expression) return { ...seen, error: refused ?? off };

  const rule = { action: 'block', expression, description: RULE_DESC, ref: RULE_REF, enabled: mine?.enabled !== false };
  const body = JSON.stringify(rule);
  const sub = `/zones/${zone}/rulesets/${rs?.id}/rules`;
  const w = !rs
    ? await cf(run, 'PUT', path, JSON.stringify({ rules: [rule] }))
    : mine
      ? await cf(run, 'PATCH', `${sub}/${mine.id}`, body)
      : await cf(run, 'POST', sub, body);
  if (w.status === 401 || w.status === 403) return { ...seen, error: perm };
  if (w.status !== 200) {
    return {
      ...seen,
      error: `Cloudflare would not add or update the Camada WAF rule: ${w.why}. Free plans allow 5 custom rules: delete one you don't need under Security > WAF > Custom rules.`,
    };
  }
  const written = (w.result?.rules ?? []).find((r: any) => r.ref === RULE_REF);
  return { rule_id: written?.id ?? mine?.id, deadline, error: refused ?? off };
}
