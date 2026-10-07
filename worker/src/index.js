// Cloudflare Worker: every 5 min, checks Apple Canada for fast delivery
// (2-hr / today / tomorrow) of one iPhone to a postal code; pushes an alert via ntfy.sh.
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

export async function check(env) {
  const part = env.PART || 'MJR54VC/A';
  const postal = env.POSTAL || 'L7A 4S6';
  const q = encodeURIComponent;

  const upd = await appleGet(`/address/location/update?geoLocated=false&postalCode=${q(postal)}`, '');
  const cookie = upd.setCookies.map((c) => c.split(';')[0]).join('; ');

  const del = await appleGet(`/delivery-message?parts.0=${q(part)}&mt=regular&little=false&postalCode=${q(postal)}`, cookie);
  if (del.status !== 200 || !del.text.startsWith('{')) throw new Error(`Apple delivery HTTP ${del.status}: ${del.text.slice(0, 150)}`);
  const d = JSON.parse(del.text).body.content.deliveryMessage?.[part]?.regular || {};

  const texts = [
    ...(d.deliveryOptionMessages || []).map((m) => m.displayName),
    ...(d.deliveryOptions || []).flatMap((o) => [o.displayName, o.date]),
    d.stickyMessageSTH, // not orderByDeliveryBy: it always says "Order today." / "Order by 10:15 a.m."
  ].filter(Boolean).map(strip);
  const earliest = (d.deliveryOptionMessages || []).map((m) => m.encodedUpperDateString).filter(Boolean).sort()[0];

  const reasons = [];
  if (d.idl === true) reasons.push('2-hr delivery available');
  if (d.stickyMessageIDL && !/unavailable/i.test(d.stickyMessageIDL)) reasons.push(strip(d.stickyMessageIDL));
  const fast = texts.find((t) => FAST_TEXT.test(t));
  if (fast) reasons.push(fast);
  if (earliest && earliest <= torontoDate(1)) reasons.push(`delivery by ${earliest}`);

  let pickupToday = [];
  if (env.ALERT_ON_PICKUP === 'true') {
    const pk = await appleGet(`/retail/pickup-message?pl=true&parts.0=${q(part)}&location=${q(postal)}`, cookie);
    if (pk.status === 200 && pk.text.startsWith('{')) {
      pickupToday = (JSON.parse(pk.text).body.stores || [])
        .filter((s) => /today/i.test(s.partsAvailability?.[part]?.pickupSearchQuote || ''))
        .map((s) => `${s.storeName} (${s.storedistance} km)`);
    }
  }

  return {
    time: new Date().toISOString(), part, postal,
    postalApplied: d.address?.postalCode === postal,
    delivery: [...new Set(texts)], idl: d.idl, stickyIDL: d.stickyMessageIDL, earliest,
    fast: reasons.length > 0, reasons: [...new Set(reasons)], pickupToday,
  };
}

async function notify(env, title, message, priority = 'urgent') {
  if (!env.NTFY_TOPIC) return console.log('no NTFY_TOPIC; would send:', title, message);
  await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST', body: message,
    headers: { Title: title, Priority: priority, Tags: 'iphone,rotating_light',
      Click: env.PRODUCT_URL || 'https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black' },
  });
}

async function run(env) {
  const r = await check(env);
  console.log(JSON.stringify(r));
  if (r.fast) await notify(env, 'iPhone 18 Pro 256GB Black: FAST DELIVERY!', `${r.postal}: ${r.reasons.join(' | ')}. Order now!`);
  else if (r.pickupToday.length) await notify(env, 'iPhone 18 Pro: pickup today', r.pickupToday.join(', '), 'high');
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
    if (url.searchParams.get('test')) { await notify(env, 'Test: iPhone watcher', 'Notifications are working.', 'default'); return new Response('test sent'); }
    try { return Response.json(await run(env)); } catch (e) { return new Response(String(e), { status: 502 }); }
  },
};
