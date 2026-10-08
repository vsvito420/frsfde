// Fresh Fade Terminbuchung: freie Zeitslots, Buchung und Admin-Übersicht.
// Läuft als Pages Function (functions/api/[[path]].js) für alle /api/*-Anfragen.

const SLOT_MINUTES = 25;
const BOOKING_DAYS_AHEAD = 30;
const TIMEZONE = 'Europe/Berlin';

// Öffnungszeiten wie auf der Webseite (0 = Sonntag)
const OPENING_HOURS = {
    1: ['09:30', '19:30'],
    2: ['09:30', '19:30'],
    3: ['09:30', '19:30'],
    4: ['09:30', '19:30'],
    5: ['09:30', '19:30'],
    6: ['09:30', '17:30']
};

const SERVICES = [
    'Herren Haarschnitt',
    'Herren Premium Service',
    'Kinder Haarschnitt (bis 12)',
    'Schüler Haarschnitt (ab 12)',
    'Bart schneiden & Kontur',
    'Bart Premium Service',
    'Maschinen Schnitt',
    'Damen Haarschnitt',
    'Sonstiges'
];

const toMinutes = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

const toHHMM = minutes =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function slotsForDate(date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const hours = OPENING_HOURS[weekday];
    if (!hours) return [];
    const slots = [];
    for (let t = toMinutes(hours[0]); t + SLOT_MINUTES <= toMinutes(hours[1]); t += SLOT_MINUTES) {
        slots.push(toHHMM(t));
    }
    return slots;
}

// Aktuelles Datum und Uhrzeit in Deutschland
function nowInBerlin() {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date()).map(p => [p.type, p.value])
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function isBookableDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const today = nowInBerlin().date;
    return date >= today && date <= addDays(today, BOOKING_DAYS_AHEAD);
}

function isPastSlot(date, time) {
    const now = nowInBerlin();
    return date === now.date && toMinutes(time) <= now.minutes;
}

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

// Optional für später: Login über Cloudflare Access (GitHub). Access legt ein signiertes
// JWT in den Header; wir prüfen Signatur, Audience, Ablauf und die erlaubten E-Mails.
let accessKeysCache = null;

const base64UrlDecode = text =>
    Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0));

async function accessKeys(env) {
    if (accessKeysCache && accessKeysCache.expires > Date.now()) return accessKeysCache.keys;
    const response = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const { keys } = await response.json();
    accessKeysCache = { keys, expires: Date.now() + 60 * 60 * 1000 };
    return keys;
}

// Login mit Benutzername + Passwort. ADMIN_USERS (Secret) = "name:passwort,name2:passwort2".
// Nach dem Login gibt es ein mit SESSION_SECRET signiertes Cookie (12 Stunden gültig).
const SESSION_COOKIE = 'ff_session';
const SESSION_HOURS = 12;

async function hmac(env, text) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}

// Vergleich in konstanter Zeit, damit Passwörter nicht über Antwortzeiten erraten werden können
async function safeEqual(a, b) {
    const [ha, hb] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
    const va = new Uint8Array(ha);
    const vb = new Uint8Array(hb);
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
    return diff === 0;
}

function adminUsers(env) {
    return String(env.ADMIN_USERS || '').split(',').map(entry => {
        const index = entry.indexOf(':');
        return index > 0 ? { name: entry.slice(0, index).trim(), password: entry.slice(index + 1).trim() } : null;
    }).filter(Boolean);
}

async function sessionUser(request, env) {
    if (!env.SESSION_SECRET) return null;
    const cookie = (request.headers.get('cookie') || '').split(';').map(c => c.trim())
        .find(c => c.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) return null;
    const [user, expires, signature] = decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)).split('|');
    if (!user || !signature || Number(expires) < Date.now()) return null;
    if (!(await safeEqual(signature, await hmac(env, `${user}|${expires}`)))) return null;
    return adminUsers(env).some(u => u.name === user) ? user : null;
}

async function login(request, env) {
    const body = await readJson(request);
    const name = String(body?.user || '').trim();
    const password = String(body?.password || '');
    let match = null;
    for (const user of adminUsers(env)) {
        const ok = (await safeEqual(user.name, name)) & (await safeEqual(user.password, password));
        if (ok) match = user;
    }
    if (!match || !env.SESSION_SECRET) {
        await new Promise(resolve => setTimeout(resolve, 800));
        return json({ error: 'Benutzername oder Passwort falsch.' }, 401);
    }
    const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
    const value = `${match.name}|${expires}|${await hmac(env, `${match.name}|${expires}`)}`;
    const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
    return new Response(JSON.stringify({ user: match.name }), {
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/api/admin; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`
        }
    });
}

const logout = () => new Response(JSON.stringify({ ok: true }), {
    headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`
    }
});

// Angemeldeter Admin: Session-Cookie oder (später) Cloudflare Access
async function adminUser(request, env) {
    return (await sessionUser(request, env)) || (await accessEmail(request, env));
}

async function accessEmail(request, env) {
    const allowed = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);

    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

    try {
        const [headerPart, payloadPart, signaturePart] = token.split('.');
        const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)));
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));

        const jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
        if (!jwk) return null;
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        const valid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5', key, base64UrlDecode(signaturePart),
            new TextEncoder().encode(`${headerPart}.${payloadPart}`)
        );

        const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        const email = String(payload.email || '').toLowerCase();
        if (!valid || !audiences.includes(env.ACCESS_AUD) || payload.exp * 1000 < Date.now()) return null;
        if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
        return allowed.includes(email) ? email : null;
    } catch {
        return null;
    }
}

async function getSlots(url, env) {
    const date = url.searchParams.get('date') || '';
    if (!isBookableDate(date)) return json({ error: 'Ungültiges Datum.' }, 400);

    const { results } = await env.DB.prepare('SELECT time FROM bookings WHERE date = ?').bind(date).all();
    const taken = new Set(results.map(r => r.time));
    const slots = slotsForDate(date).map(time => ({
        time,
        available: !taken.has(time) && !isPastSlot(date, time)
    }));
    return json({ date, slots });
}

async function book(request, env) {
    const body = await readJson(request);
    if (!body) return json({ error: 'Ungültige Anfrage.' }, 400);

    // Honeypot gegen Spam-Bots
    if (body.website) return json({ ok: true });

    const date = String(body.date || '');
    const time = String(body.time || '');
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = String(body.phone || '').trim().slice(0, 30);
    const service = String(body.service || '');

    if (!isBookableDate(date) || !slotsForDate(date).includes(time) || isPastSlot(date, time)) {
        return json({ error: 'Dieser Termin ist nicht buchbar.' }, 400);
    }
    if (name.length < 2) return json({ error: 'Bitte gib deinen Namen an.' }, 400);
    if (!/^\+?[\d\s/()-]{6,}$/.test(phone)) return json({ error: 'Bitte gib eine gültige Telefonnummer an.' }, 400);
    if (!SERVICES.includes(service)) return json({ error: 'Bitte wähle eine Leistung.' }, 400);

    // Datenschutz: Termine, die älter als 30 Tage sind, löschen
    await env.DB.prepare('DELETE FROM bookings WHERE date < ?').bind(addDays(nowInBerlin().date, -30)).run();

    try {
        await env.DB.prepare('INSERT INTO bookings (date, time, name, phone, service) VALUES (?, ?, ?, ?, ?)')
            .bind(date, time, name, phone, service).run();
    } catch (error) {
        if (String(error).includes('UNIQUE')) {
            return json({ error: 'Dieser Termin wurde gerade vergeben. Bitte wähle eine andere Zeit.' }, 409);
        }
        throw error;
    }
    return json({ ok: true, date, time, service });
}

async function adminBookings(url, env) {
    const from = url.searchParams.get('from') || nowInBerlin().date;
    const { results } = await env.DB.prepare(
        'SELECT id, date, time, name, phone, service, blocked FROM bookings WHERE date >= ? ORDER BY date, time'
    ).bind(from).all();
    return json({ bookings: results });
}

async function adminDelete(request, env) {
    const body = await readJson(request);
    if (!body || !Number.isInteger(body.id)) return json({ error: 'Ungültige ID.' }, 400);
    await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(body.id).run();
    return json({ ok: true });
}

async function adminBlock(request, env) {
    const body = await readJson(request);
    const date = String(body?.date || '');
    const times = Array.isArray(body?.times) ? body.times.map(String) : [];
    const validTimes = times.filter(t => slotsForDate(date).includes(t));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || validTimes.length === 0) {
        return json({ error: 'Ungültiges Datum oder Uhrzeit.' }, 400);
    }
    const insert = env.DB.prepare(
        "INSERT OR IGNORE INTO bookings (date, time, name, phone, service, blocked) VALUES (?, ?, 'Blockiert', '-', 'Blockiert', 1)"
    );
    await env.DB.batch(validTimes.map(t => insert.bind(date, t)));
    return json({ ok: true });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname}`;

        if (route === 'GET /api/services') return json({ services: SERVICES });
        if (route === 'GET /api/slots') return getSlots(url, env);
        if (route === 'POST /api/book') return book(request, env);

        if (url.pathname.startsWith('/api/admin/')) {
            if (route === 'POST /api/admin/login') return login(request, env);
            if (route === 'POST /api/admin/logout') return logout();
            const user = await adminUser(request, env);
            if (!user) return json({ error: 'Nicht angemeldet.' }, 401);
            if (route === 'GET /api/admin/me') return json({ user });
            if (route === 'GET /api/admin/bookings') return adminBookings(url, env);
            if (route === 'POST /api/admin/delete') return adminDelete(request, env);
            if (route === 'POST /api/admin/block') return adminBlock(request, env);
        }

        return json({ error: 'Nicht gefunden.' }, 404);
    }
};
