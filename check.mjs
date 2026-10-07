// Checks Apple Canada for fast delivery (2-hr / today / tomorrow) of one iPhone model
// to a postal code, and sends a push notification via ntfy.sh when it's available.
//
// Apple blocks plain HTTP clients on the fulfillment API (HTTP 541), so this loads
// the product page in headless Chromium and calls the API from inside the page.

import { chromium } from 'playwright';

const PART = process.env.PART || 'MJR54VC/A'; // iPhone 18 Pro 6.3" 256GB Black (Canada)
const POSTAL = process.env.POSTAL || 'L7A 4S6';
const PRODUCT_URL = process.env.PRODUCT_URL ||
  'https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black';
const NTFY_TOPIC = process.env.NTFY_TOPIC; // e.g. iphone18-ishaan-8f3k2 (keep it hard to guess)
const ALERT_ON_PICKUP = process.env.ALERT_ON_PICKUP === 'true'; // also alert on same-day in-store pickup
const TEST_NOTIFY = process.env.TEST_NOTIFY === 'true';

const FAST_TEXT = /\btoday\b|\btomorrow\b|\bhours?\b|\bhrs?\b|a\.m\.|p\.m\./i;

function torontoDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).replaceAll('-', ''); // YYYYMMDD
}

async function notify(title, message, priority = 'urgent') {
  if (!NTFY_TOPIC) { console.log('[no NTFY_TOPIC set] would notify:', title, '-', message); return; }
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST',
    body: message,
    headers: { Title: title, Priority: priority, Tags: 'iphone,rotating_light', Click: PRODUCT_URL },
  });
  console.log('ntfy status', res.status);
}

async function fetchFulfillment() {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000); // let Apple's bot-check scripts set their cookies

    return await page.evaluate(async ({ part, postal }) => {
      const q = (s) => encodeURIComponent(s);
      // Store the postal code in Apple's location cookie, as the "Delivers to" dialog does.
      await fetch(`/ca/shop/address/location/update?geoLocated=false&postalCode=${q(postal)}`);
      const url = `/ca/shop/fulfillment-messages?fae=true&little=false&geoLocated=false` +
        `&postalCode=${q(postal)}&searchNearby=true&location=${q(postal)}` +
        `&parts.0=${part}&mts.0=regular&mts.1=expanded`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      return { status: r.status, text: await r.text() };
    }, { part: PART, postal: POSTAL });
  } finally {
    await browser.close();
  }
}

async function main() {
  if (TEST_NOTIFY) { await notify('Test: iPhone watcher', 'Notifications are working.', 'default'); return; }

  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetchFulfillment();
    if (res.status === 200 && res.text.startsWith('{')) break;
    console.log(`attempt ${attempt}: HTTP ${res.status}, retrying`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (res.status !== 200 || !res.text.startsWith('{')) {
    console.error(`Apple returned HTTP ${res.status}; body starts: ${res.text.slice(0, 200)}`);
    process.exit(1);
  }

  const content = JSON.parse(res.text).body.content;
  const dm = content.deliveryMessage?.[PART] || {};
  const d = dm.regular || dm.expanded || {};

  const texts = [
    ...(d.deliveryOptionMessages || []).map((m) => m.displayName),
    ...(d.deliveryOptions || []).flatMap((o) => [o.displayName, o.date]),
    d.stickyMessageSTH, // not orderByDeliveryBy: it always says "Order today." / "Order by 10:15 a.m."
  ].filter(Boolean);
  const earliest = (d.deliveryOptionMessages || []).map((m) => m.encodedUpperDateString).filter(Boolean).sort()[0];

  const reasons = [];
  if (d.idl === true) reasons.push('2-hr delivery available');
  if (d.stickyMessageIDL && !/unavailable/i.test(d.stickyMessageIDL)) reasons.push(d.stickyMessageIDL);
  const fastText = texts.find((t) => FAST_TEXT.test(t.replace(/<[^>]+>/g, '')));
  if (fastText) reasons.push(fastText.replace(/<[^>]+>/g, ''));
  if (earliest && earliest <= torontoDate(1)) reasons.push(`delivery by ${earliest}`);

  const stores = (content.pickupMessage?.stores || [])
    .map((s) => ({ name: s.storeName, km: s.storedistance, quote: s.partsAvailability?.[PART]?.pickupSearchQuote }))
    .filter((s) => s.quote);
  const pickupToday = stores.filter((s) => /today/i.test(s.quote));

  const isAddressed = d.address?.postalCode || /L7A|postal/i.test(d.orderByDeliveryBySuffix || '');
  console.log(new Date().toISOString(), {
    delivery: texts.map((t) => t.replace(/<[^>]+>/g, '')),
    idl: d.idl, stickyIDL: d.stickyMessageIDL, earliest, postalApplied: Boolean(isAddressed),
    pickupToday: pickupToday.map((s) => `${s.name} (${s.km} km)`),
  });

  if (reasons.length) {
    await notify('iPhone 18 Pro 256GB Black: FAST DELIVERY!',
      `${POSTAL}: ${[...new Set(reasons)].join(' | ')}. Order now!`);
  } else if (ALERT_ON_PICKUP && pickupToday.length) {
    await notify('iPhone 18 Pro: pickup today',
      pickupToday.map((s) => `${s.name} (${s.km} km)`).join(', '), 'high');
  } else {
    console.log('No fast delivery right now.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
