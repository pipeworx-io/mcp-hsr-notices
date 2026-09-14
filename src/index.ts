interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * HSR Notices MCP — FTC Hart-Scott-Rodino early-termination notices
 * (api.ftc.gov, brokered by api.data.gov).
 *
 * When a merger clears HSR antitrust review early, the FTC publishes a
 * notice. For a private-target deal this is the EARLIEST public signal that
 * a merger was filed and cleared — ahead of any 8-K or press release.
 *
 * Tools:
 * - hsr_recent: most recent notices, newest first
 * - hsr_search: notices mentioning a party (acquirer or target), by title match
 * - hsr_party_history: full notice history for one party, oldest to newest
 * - hsr_coverage: dataset size, date range, and the 2021 suspension gap
 *
 * This is a LIVE PROXY — no database. Auth: optional `_apiKey` (api.data.gov
 * key), falls back to the gateway-injected platform key.
 *
 * CRITICAL: api.ftc.gov silently caps page[limit] at 50 — requesting more
 * returns 50 with no error. We page via offset and never claim to have
 * fetched more than we actually did.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'HSR Notices');
}

const BASE_URL = 'https://api.ftc.gov/v0/hsr-early-termination-notices';

// The Workers runtime sends no default User-Agent. An upstream behind a bot
// filter then answers 403, and that reads as "they closed their API" rather than
// as a missing header — phishtank, chess and devto each went fully dark this way.
const UA = 'pipeworx-mcp-hsr-notices/1.0 (+https://pipeworx.io)';

// Confirmed live 2026-08-29: requesting page[limit] above this returns
// exactly this many rows with no error and no signal that it was capped.
const PAGE_CAP = 50;

// Hard ceiling on how many records any single tool call will page through.
// hsr_party_history is the only tool that can legitimately want more than a
// couple of pages; everything else defaults far below this.
const MAX_FETCH = 200;

// The FTC suspended HSR early termination grants for just over a month in
// 2021. Verified from the live data on 2026-08-29: the last pre-suspension
// notice is transaction 20210958 (2021-02-03); a date-filtered query for
// 2021-02-04..2021-03-11 returns zero rows; the first post-suspension
// notices are 20210455/20210456 (2021-03-12). This is a real gap in the
// underlying FTC data, not missing or broken Pipeworx coverage — a caller
// hitting it with no explanation would reasonably conclude our data is
// broken, so hsr_coverage() and every empty-window hint mention it by name.
const SUSPENSION_GAP = {
  note:
    'The FTC suspended HSR early-termination grants from 2021-02-04 through 2021-03-11 — a real gap in the underlying data, not a Pipeworx coverage problem. Early termination resumed 2021-03-12 and has stayed current since.',
  last_notice_before_gap: { transaction_number: '20210958', date: '2021-02-03' },
  first_notices_after_gap: { transaction_numbers: ['20210455', '20210456'], date: '2021-03-12' },
};

const tools: McpToolExport['tools'] = [
  {
    name: 'hsr_recent',
    description:
      'Get the most recent FTC Hart-Scott-Rodino (HSR) early-termination notices, newest first. When a merger clears HSR antitrust review early the FTC publishes a notice — for a private-target deal this is the earliest public signal the merger was filed and cleared, ahead of any 8-K or press release. Returns acquirer, target, transaction number and filing date. Answers "what mergers got antitrust clearance recently" or "which deals received HSR early termination this week." Example: hsr_recent({ days: 7, limit: 25 })',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'How many days back from today to look. Default 7.',
        },
        limit: {
          type: 'number',
          description: 'Max notices to return, newest first (paged from the source in batches of 50). Default 25, max 100.',
        },
        _apiKey: {
          type: 'string',
          description: 'Optional — your own api.data.gov key for higher limits; omit to use the shared Pipeworx key.',
        },
      },
      required: [],
    },
  },
  {
    name: 'hsr_search',
    description:
      'Search FTC Hart-Scott-Rodino (HSR) early-termination notices by acquirer or target company name. Matches against the notice title, which embeds both parties and the transaction number, so a partial or one-sided company/fund name finds every notice that mentions it. Use this to check "did this merger get antitrust clearance" or "has the FTC granted HSR early termination for this deal." Example: hsr_search({ party: "Blockbuster", limit: 25 })',
    inputSchema: {
      type: 'object',
      properties: {
        party: {
          type: 'string',
          description: 'Company or fund name to search for, e.g. "Blockbuster" or "Carl C. Icahn". Matches anywhere in the notice title (as-filed legal name, so include known fund suffixes like "L.P." if a plain name misses).',
        },
        since: {
          type: 'string',
          description: 'Optional — only return notices on or after this date, YYYY-MM-DD.',
        },
        limit: {
          type: 'number',
          description: 'Max notices to return, newest first. Default 25, max 100.',
        },
        _apiKey: {
          type: 'string',
          description: 'Optional — your own api.data.gov key for higher limits; omit to use the shared Pipeworx key.',
        },
      },
      required: ['party'],
    },
  },
  {
    name: 'hsr_party_history',
    description:
      'Get every FTC Hart-Scott-Rodino (HSR) early-termination notice mentioning a given company or fund, oldest to newest, with a total count — a full antitrust-clearance history for that party across every deal the FTC granted early termination on. Example: hsr_party_history({ party: "Carl C. Icahn" })',
    inputSchema: {
      type: 'object',
      properties: {
        party: {
          type: 'string',
          description: 'Company or fund name to search for, e.g. "Carl C. Icahn" or "American Securities Partners". Matches anywhere in the notice title (as-filed legal name).',
        },
        _apiKey: {
          type: 'string',
          description: 'Optional — your own api.data.gov key for higher limits; omit to use the shared Pipeworx key.',
        },
      },
      required: ['party'],
    },
  },
  {
    name: 'hsr_coverage',
    description:
      'Report the size and date range of the FTC Hart-Scott-Rodino (HSR) early-termination notice dataset — total notice count, earliest and latest dates on record, and the 2021 suspension gap when the FTC paused granting early terminations for about five weeks. Call this before treating an empty hsr_recent, hsr_search, or hsr_party_history result as "no data" — it confirms whether the requested window actually falls inside FTC coverage. Example: hsr_coverage({})',
    inputSchema: {
      type: 'object',
      properties: {
        _apiKey: {
          type: 'string',
          description: 'Optional — your own api.data.gov key for higher limits; omit to use the shared Pipeworx key.',
        },
      },
      required: [],
    },
  },
];

/* ── Types ─────────────────────────────────────────────────────────── */

interface FtcAttributes {
  title: string;
  'acquired-party': string;
  'acquiring-party': string;
  date: string;
  'transaction-number': string;
  'acquired-entities': string[];
}

interface FtcRecord {
  type: string;
  id: string;
  attributes: FtcAttributes;
}

interface FtcResponse {
  data?: FtcRecord[];
  meta?: { count?: number };
  error?: { code?: string; message?: string };
}

interface Notice {
  transaction_number: string;
  date: string;
  title: string;
  acquiring_party: string;
  acquired_party: string;
  acquired_entities: string[];
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function normalize(rec: FtcRecord): Notice {
  const a = rec.attributes;
  return {
    transaction_number: a['transaction-number'],
    date: a.date,
    title: a.title,
    acquiring_party: a['acquiring-party'],
    // `acquired-party` (singular) is often the ultimate parent or an
    // individual and DIFFERS from `acquired-entities` (the actual operating
    // subsidiaries). Both are returned, never collapsed into one string.
    acquired_party: a['acquired-party'],
    acquired_entities: Array.isArray(a['acquired-entities']) ? a['acquired-entities'] : [],
  };
}

function classForStatus(status: number): string {
  if (status === 404) return 'not_found';
  if (status === 429) return 'upstream_throttled';
  if (status >= 500) return 'upstream_down';
  return 'user_error';
}

/**
 * Shorthand filter — `filter[field][operator]=OP&filter[field][value]=V`.
 * This is the form the FTC's own docs use for `title` with CONTAINS.
 */
function addFilter(params: URLSearchParams, field: string, operator: string, value: string): void {
  params.set(`filter[${field}][operator]`, operator);
  params.set(`filter[${field}][value]`, value);
}

/**
 * Date comparison, in the CONDITION form the FTC documents for this field:
 *
 *   filter[date][condition][path]=date
 *   filter[date][condition][operator]==
 *   filter[date][condition][value]=2021-01-15
 *
 * Two things here were got wrong once and are worth stating. The operator token
 * is a Drupal JSON:API comparison symbol — `>=`, not `GTE`; and `date` takes the
 * nested `[condition]` form rather than the flat one that works for `title`.
 * Both come from the endpoint's own documentation, not from convention:
 * https://www.ftc.gov/developer/api/v0/endpoints/hsr-early-termination-notices-api
 */
function addDateCondition(params: URLSearchParams, operator: string, value: string): void {
  params.set('filter[date][condition][path]', 'date');
  params.set('filter[date][condition][operator]', operator);
  params.set('filter[date][condition][value]', value);
}

async function ftcFetch(params: URLSearchParams, apiKey: string): Promise<FtcResponse> {
  params.set('api_key', apiKey);
  const res = await pwFetch(`${BASE_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  const bodyText = await res.text();
  let body: FtcResponse = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as FtcResponse) : {};
  } catch {
    body = {};
  }

  if (!res.ok) {
    const detail = body?.error?.message;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `auth_required: FTC HSR early-termination-notices requires an API key, and the one supplied was rejected (HTTP ${res.status}). ` +
          'Pass a working api.data.gov key via _apiKey — get one free at https://api.data.gov/signup/.' +
          (detail ? ` Upstream said: ${detail}` : ''),
      );
    }
    const cls = classForStatus(res.status);
    throw new Error(`${cls}: FTC HSR API returned HTTP ${res.status}${detail ? ` — ${detail}` : ''}.`);
  }

  return body;
}

interface FetchOpts {
  sortPath: string;
  sortDir: 'ASC' | 'DESC';
  want: number;
}

// Pages through offset because page[limit] silently caps at 50. Stops as
// soon as a page comes back shorter than requested (last page) or the
// caller's `want` is satisfied — never fetches more than either bound.
async function fetchRecords(
  filterParams: URLSearchParams,
  apiKey: string,
  opts: FetchOpts,
): Promise<{ records: FtcRecord[]; total: number }> {
  const want = Math.max(1, Math.min(opts.want, MAX_FETCH));
  const records: FtcRecord[] = [];
  let total = 0;
  let offset = 0;

  while (records.length < want) {
    const remaining = want - records.length;
    const pageLimit = Math.min(PAGE_CAP, remaining);
    const params = new URLSearchParams(filterParams);
    params.set('page[offset]', String(offset));
    params.set('page[limit]', String(pageLimit));
    params.set('sort[s][path]', opts.sortPath);
    params.set('sort[s][direction]', opts.sortDir);

    const body = await ftcFetch(params, apiKey);
    total = body.meta?.count ?? total;
    const page = body.data ?? [];
    records.push(...page);
    offset += page.length;

    if (page.length < pageLimit || page.length === 0) break; // last page
  }

  return { records: records.slice(0, want), total };
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function requireString(v: unknown, field: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new Error(`user_error: "${field}" is required and must be a non-empty string.`);
  return s;
}

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// True when [from, to] (either end optional) overlaps the 2021 suspension
// gap — used to make an empty-result hint name the real cause instead of
// leaving the caller to suspect broken data.
function overlapsSuspensionGap(from?: string, to?: string): boolean {
  const gapStart = '2021-02-04';
  const gapEnd = '2021-03-11';
  if (to && to < gapStart) return false;
  if (from && from > gapEnd) return false;
  return true;
}

/* ── Tools ─────────────────────────────────────────────────────────── */

async function hsrRecent(args: Record<string, unknown>, apiKey: string) {
  const days = clampInt(args.days, 7, 1, 3650);
  const limit = clampInt(args.limit, 25, 1, 100);
  const since = isoDateDaysAgo(days);

  const filterParams = new URLSearchParams();
  addDateCondition(filterParams, '>=', since);

  const { records, total } = await fetchRecords(filterParams, apiKey, {
    sortPath: 'date',
    sortDir: 'DESC',
    want: limit,
  });

  if (records.length === 0) {
    const gapHint = overlapsSuspensionGap(since, undefined)
      ? ` This window overlaps the FTC's 2021-02-04..2021-03-11 early-termination suspension — see hsr_coverage() for details.`
      : '';
    return {
      found: false,
      reason: 'no_notices_in_window',
      window_days: days,
      since,
      hint: `No HSR early-termination notices found in the last ${days} day(s) (since ${since}). Try a wider window, e.g. days: 30.${gapHint}`,
    };
  }

  return {
    window_days: days,
    since,
    count: records.length,
    total_matches: total,
    notices: records.map(normalize),
  };
}

async function hsrSearch(args: Record<string, unknown>, apiKey: string) {
  const party = requireString(args.party, 'party');
  const since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : undefined;
  const limit = clampInt(args.limit, 25, 1, 100);

  const filterParams = new URLSearchParams();
  addFilter(filterParams, 'title', 'CONTAINS', party);
  if (since) addDateCondition(filterParams, '>=', since);

  const { records, total } = await fetchRecords(filterParams, apiKey, {
    sortPath: 'date',
    sortDir: 'DESC',
    want: limit,
  });

  if (records.length === 0) {
    const gapHint = since && overlapsSuspensionGap(since, undefined)
      ? ` Your since date overlaps the FTC's 2021-02-04..2021-03-11 early-termination suspension — see hsr_coverage() for details.`
      : '';
    return {
      found: false,
      reason: 'no_matching_notices',
      party,
      since: since ?? null,
      hint: `No HSR notices found with "${party}" in the title. Titles use the as-filed legal name — try a shorter fragment, a different spelling, or a known fund suffix (e.g. "L.P."). Drop \`since\` to search the full history back to 1999.${gapHint}`,
    };
  }

  return {
    party,
    since: since ?? null,
    count: records.length,
    total_matches: total,
    notices: records.map(normalize),
  };
}

async function hsrPartyHistory(args: Record<string, unknown>, apiKey: string) {
  const party = requireString(args.party, 'party');

  const filterParams = new URLSearchParams();
  addFilter(filterParams, 'title', 'CONTAINS', party);

  const { records, total } = await fetchRecords(filterParams, apiKey, {
    sortPath: 'date',
    sortDir: 'ASC',
    want: MAX_FETCH,
  });

  if (records.length === 0) {
    return {
      found: false,
      reason: 'no_matching_notices',
      party,
      hint: `No HSR notices found with "${party}" in the title. Titles use the as-filed legal name — try a shorter fragment or a different spelling.`,
    };
  }

  return {
    party,
    total_matches: total,
    returned: records.length,
    truncated: total > records.length,
    notices: records.map(normalize),
  };
}

async function hsrCoverage(apiKey: string) {
  const totalParams = new URLSearchParams();
  totalParams.set('page[limit]', '1');
  const totalBody = await ftcFetch(totalParams, apiKey);
  const total = totalBody.meta?.count ?? 0;

  // Sortable paths are `created` and `changed` ONLY — the endpoint accepts
  // sort[s][path]=date without complaint and then ignores it, so asking for
  // ASC and DESC returned the SAME newest row and coverage reported
  // earliest == latest == today. That reads as "we hold one day of data" for a
  // corpus of 28k notices going back to 1999 — the worst possible answer, and a
  // clean 200 the whole way.
  //
  // `created` is Drupal's row-creation time, not the notice date, so it cannot
  // stand in for min(date) either. Rather than publish a number we cannot
  // verify, the floor is established by ASKING: one filtered HEAD-ish query per
  // candidate year, oldest first, and the first year that returns a row is a
  // fact we measured.
  const latestBody = await ftcFetch(withLimit(new URLSearchParams(), 1), apiKey);
  const latest = latestBody.data?.[0] ? normalize(latestBody.data[0]) : null;

  let earliestYearWithData: number | null = null;
  for (const year of COVERAGE_PROBE_YEARS) {
    const p = new URLSearchParams();
    addDateCondition(p, '<', `${year + 1}-01-01`);
    const body = await ftcFetch(withLimit(p, 1), apiKey);
    if ((body.data?.length ?? 0) > 0) {
      earliestYearWithData = year;
      break;
    }
  }

  return {
    total_notices: total,
    latest_notice_date: latest?.date ?? null,
    earliest_year_with_data: earliestYearWithData,
    coverage_note: earliestYearWithData
      ? `Notices exist from at least ${earliestYearWithData} through ${latest?.date ?? 'the latest publication'}. The exact earliest date is not reported because this API sorts only by record-creation time, not by notice date — the year floor above was measured by querying for it.`
      : 'Coverage floor could not be measured on this call. Searching without a `since` filter still reaches the full history.',
    suspension_gap: SUSPENSION_GAP,
  };
}

/** Years probed, oldest first, to establish a measured coverage floor. */
const COVERAGE_PROBE_YEARS = [1990, 1995, 1999, 2005, 2015, 2021, 2026];

function withLimit(p: URLSearchParams, n: number): URLSearchParams {
  p.set('page[limit]', String(n));
  return p;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  delete args._apiKey;

  if (!apiKey) {
    throw new Error(
      'auth_required: FTC HSR early-termination-notices requires an API key. The gateway normally supplies one automatically; if you are calling this pack directly, pass your own api.data.gov key via _apiKey — get one free at https://api.data.gov/signup/.',
    );
  }

  switch (name) {
    case 'hsr_recent':
      return hsrRecent(args, apiKey);
    case 'hsr_search':
      return hsrSearch(args, apiKey);
    case 'hsr_party_history':
      return hsrPartyHistory(args, apiKey);
    case 'hsr_coverage':
      return hsrCoverage(apiKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
