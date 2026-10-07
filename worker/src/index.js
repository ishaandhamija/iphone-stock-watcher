// Cloudflare Worker: every 15 min, checks Apple Canada for fast delivery
// (2-hr / today / tomorrow) of one or more iPhone models to a postal code; alerts via Telegram.
// No browser needed: setting Apple's location cookie first makes delivery-message return
// quotes for the postal code.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BASE = 'https://www.apple.com/ca/shop';
const FAST_TEXT = /\btoday\b|\btomorrow\b|\bhours?\b|\bhrs?\b|a\.m\.|p\.m\./i;
const strip = (s) => String(s).replace(/<[^>]+>/g, '');

function torontoDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).replaceAll('-', '');
}

async function appleGet(path, cookie) {
  const res = await fetch(BASE + path, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-CA,en;q=0.9', Cookie: cookie },
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  return { status: res.status, text, setCookies };
}

const DEFAULT_MODELS = [
  { part: 'MJR54VC/A', name: 'Black', url: 'https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black' },
];

function fastReasons(d) {
  const texts = [
    ...(d.deliveryOptionMessages || []).map((m) => m.displayName),
    ...(d.deliveryOptions || []).flatMap((o) => [o.displayName, o.date]),
    d.stickyMessageSTH, // not orderByDeliveryBy: it always says "Order today." / "Order by 10:15 a.m."
  ].filter(Boolean).map(strip);
  const earliest = (d.deliveryOptionMessages || []).map((m) => m.encodedUpperDateString).filter(Boolean).sort()[0];

  const reasons = [];
  if (d.idl === true) reasons.push('2-hr delivery available');
  if (d.stickyMessageIDL && !/unavailable/i.test(d.stickyMessageIDL)) reasons.push(strip(d.stickyMessageIDL));
  const fast = texts.filter((t) => FAST_TEXT.test(t));
  reasons.push(...fast);
  if (earliest && earliest <= torontoDate(1)) reasons.push(`delivery by ${earliest}`);
  return { texts: [...new Set(texts)], earliest, reasons: [...new Set(reasons)] };
}

export async function check(env) {
  const models = env.MODELS?.length ? env.MODELS : DEFAULT_MODELS;
  const postal = env.POSTAL || 'L7A 4S6';
  const q = encodeURIComponent;

  const upd = await appleGet(`/address/location/update?geoLocated=false&postalCode=${q(postal)}`, '');
  const cookie = upd.setCookies.map((c) => c.split(';')[0]).join('; ');

  // One request covers all models: parts.0, parts.1, ...
  const partsQs = models.map((m, i) => `parts.${i}=${q(m.part)}`).join('&');
  const del = await appleGet(`/delivery-message?${partsQs}&mt=regular&little=false&postalCode=${q(postal)}`, cookie);
  if (del.status !== 200 || !del.text.startsWith('{')) throw new Error(`Apple delivery HTTP ${del.status}: ${del.text.slice(0, 150)}`);
  const dm = JSON.parse(del.text).body.content.deliveryMessage || {};

  let stores = [];
  if (env.ALERT_ON_PICKUP === 'true') {
    const pq = models.map((m, i) => `parts.${i}=${q(m.part)}`).join('&');
    const pk = await appleGet(`/retail/pickup-message?pl=true&${pq}&location=${q(postal)}`, cookie);
    if (pk.status === 200 && pk.text.startsWith('{')) stores = JSON.parse(pk.text).body.stores || [];
  }

  const results = models.map((m) => {
    const d = dm[m.part]?.regular || {};
    const { texts, earliest, reasons } = fastReasons(d);
    const pickupToday = stores
      .filter((s) => /today/i.test(s.partsAvailability?.[m.part]?.pickupSearchQuote || ''))
      .map((s) => `${s.storeName} (${s.storedistance} km)`);
    return {
      ...m, product: strip(d.subHeader || '').replace(/^For\s+/, ''), postalApplied: d.address?.postalCode === postal,
      delivery: texts, idl: d.idl, stickyIDL: d.stickyMessageIDL, earliest,
      fast: reasons.length > 0, reasons, pickupToday,
    };
  });

  return { time: new Date().toISOString(), postal, anyFast: results.some((r) => r.fast), results };
}

async function notify(env, title, message, priority = 'urgent', link = '') {
  // Telegram (preferred): ntfy.sh rate-limits by IP and Workers share IPs, so its free quota is exhausted.
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `${priority === 'urgent' ? '🚨 ' : ''}${title}\n\n${message}`,
        disable_web_page_preview: true,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
    return `Telegram HTTP ${res.status}`;
  }
  if (!env.NTFY_TOPIC) return console.log('no notifier configured; would send:', title, message);
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST', body: message,
    headers: { Title: title, Priority: priority, Tags: 'iphone,rotating_light', ...(link && { Click: link }),
      ...(env.NTFY_TOKEN && { Authorization: `Bearer ${env.NTFY_TOKEN}` }) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${body.slice(0, 200)}`);
  return `ntfy HTTP ${res.status}`;
}

// e.g. "Black and Glacier Blue (both)" / "Glacier Blue only"
function whichLabel(names, total) {
  if (names.length === total && total > 1) return `${names.join(' and ')} (${total === 2 ? 'both' : 'all'})`;
  return `${names.join(', ')} only`;
}

export function buildAlert(r) {
  const fast = r.results.filter((x) => x.fast);
  const lines = [`Available for fast delivery to ${r.postal}: ${whichLabel(fast.map((x) => x.name), r.results.length)}`, ''];
  for (const x of fast) lines.push(`✅ ${x.name}: ${x.reasons.join(' | ')}`, x.url, '');
  for (const x of r.results.filter((x) => !x.fast)) lines.push(`❌ ${x.name}: ${x.delivery[0] || 'no fast delivery'}`);
  return { title: 'iPhone 18 Pro 256GB: FAST DELIVERY!', message: lines.join('\n').trim(), link: fast[0]?.url };
}

async function run(env) {
  const r = await check(env);
  console.log(JSON.stringify(r));
  if (r.anyFast) {
    const a = buildAlert(r);
    await notify(env, a.title, a.message, 'urgent', a.link);
  } else {
    const pick = r.results.filter((x) => x.pickupToday.length);
    if (pick.length) {
      await notify(env, 'iPhone 18 Pro 256GB: pickup today',
        pick.map((x) => `${x.name}: ${x.pickupToday.join(', ')}\n${x.url}`).join('\n\n'), 'high', pick[0].url);
    }
  }
  return r;
}

export default {
  async scheduled(event, env, ctx) {
    try { await run(env); } catch (e) { console.error(e.stack || e); throw e; }
  },
  // Manual check: GET /?key=<NTFY_TOPIC>  (add &test=1 to send a test notification)
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.NTFY_TOPIC || url.searchParams.get('key') !== env.NTFY_TOPIC) return new Response('ok');
    if (url.searchParams.get('telegram') === 'chats') {
      // Lists chats that have messaged the bot, to find TELEGRAM_CHAT_ID.
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
      const j = await r.json();
      const chats = (j.result || []).map((u) => (u.message || u.my_chat_member || {}).chat).filter(Boolean)
        .map((c) => ({ id: c.id, type: c.type, name: c.first_name || c.title, username: c.username }));
      return Response.json({ ok: j.ok, description: j.description, chats });
    }
    if (url.searchParams.get('test')) {
      try { return new Response(await notify(env, 'Test: iPhone watcher', 'Notifications are working.', 'default')); }
      catch (e) { return new Response(String(e), { status: 502 }); }
    }
    try { return Response.json(await run(env)); } catch (e) { return new Response(String(e), { status: 502 }); }
  },
};
