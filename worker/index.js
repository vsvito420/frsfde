// Fresh Fade Terminbuchung: freie Zeitslots, Buchung und Admin-Übersicht.
// Läuft als Pages Function (functions/api/[[path]].js) für alle /api/*-Anfragen.

import { notifyAdmins } from './push.js';
import { currentStaff, login, clearCookie, changePassword, createInvite, setupInfo, setupPassword, listStaff, saveStaff, publicStaff } from './auth.js';

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

const STATUSES = ['gebucht', 'erschienen', 'nicht_erschienen', 'abgesagt'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[\d\s/()-]{6,}$/;

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

async function bookableStaff(env) {
    const { results } = await env.DB.prepare('SELECT id, name, username FROM staff WHERE active = 1 AND bookable = 1 ORDER BY sort, id').all();
    return results;
}

// Belegte Uhrzeiten pro Friseur an einem Tag: Map(time -> Set(staff_id))
async function takenByTime(env, date) {
    const { results } = await env.DB.prepare("SELECT time, staff_id FROM bookings WHERE date = ? AND status != 'abgesagt'").bind(date).all();
    const taken = new Map();
    for (const r of results) {
        if (!taken.has(r.time)) taken.set(r.time, new Set());
        taken.get(r.time).add(r.staff_id ?? 0);
    }
    return taken;
}

// Wunsch-Friseur (ID) oder alle, die Termine annehmen
async function eligibleStaff(env, wanted) {
    const staff = await bookableStaff(env);
    if (!staff.length) return [{ id: null, name: 'Fresh Fade', username: null }];
    const id = Number(wanted) || null;
    return id ? staff.filter(s => s.id === id) : staff;
}

async function getSlots(url, env) {
    const date = url.searchParams.get('date') || '';
    if (!isBookableDate(date)) return json({ error: 'Ungültiges Datum.' }, 400);
    const staff = await eligibleStaff(env, url.searchParams.get('staff'));
    const taken = await takenByTime(env, date);
    // Frei, wenn mindestens ein passender Friseur zu der Zeit frei ist (keine Namen nach außen)
    const slots = slotsForDate(date).map(time => ({
        time,
        available: !isPastSlot(date, time) && staff.some(s => !taken.get(time)?.has(s.id ?? 0))
    }));
    return json({ date, slots });
}

async function book(request, env, ctx) {
    const body = await readJson(request);
    if (!body) return json({ error: 'Ungültige Anfrage.' }, 400);

    // Honeypot gegen Spam-Bots
    if (body.website) return json({ ok: true });

    const date = String(body.date || '');
    const time = String(body.time || '');
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = String(body.phone || '').trim().slice(0, 30);
    const service = String(body.service || '');
    const email = String(body.email || '').trim().slice(0, 120);

    if (!isBookableDate(date) || !slotsForDate(date).includes(time) || isPastSlot(date, time)) {
        return json({ error: 'Dieser Termin ist nicht buchbar.' }, 400);
    }
    if (name.length < 2) return json({ error: 'Bitte gib deinen Namen an.' }, 400);
    if (!PHONE_PATTERN.test(phone)) return json({ error: 'Bitte gib eine gültige Telefonnummer an.' }, 400);
    if (email && !EMAIL_PATTERN.test(email)) return json({ error: 'Bitte gib eine gültige E-Mail-Adresse an.' }, 400);
    if (!SERVICES.includes(service)) return json({ error: 'Bitte wähle eine Leistung.' }, 400);

    // Datenschutz: Termine, die älter als 30 Tage sind, löschen
    await env.DB.prepare('DELETE FROM bookings WHERE date < ?').bind(addDays(nowInBerlin().date, -30)).run();

    // Wunsch-Friseur oder der erste freie; bei gleichzeitiger Buchung den nächsten versuchen
    const staff = await eligibleStaff(env, body.staff);
    if (!staff.length) return json({ error: 'Dieser Friseur ist nicht buchbar.' }, 400);
    const taken = await takenByTime(env, date);
    let assigned = null;
    for (const candidate of staff.filter(s => !taken.get(time)?.has(s.id ?? 0))) {
        try {
            await env.DB.prepare("INSERT INTO bookings (date, time, name, phone, email, service, seen, source, staff_id) VALUES (?, ?, ?, ?, ?, ?, 0, 'website', ?)")
                .bind(date, time, name, phone, email || null, service, candidate.id).run();
            assigned = candidate;
            break;
        } catch (error) {
            if (!String(error).includes('UNIQUE')) throw error;
        }
    }
    if (!assigned) return json({ error: 'Dieser Termin wurde gerade vergeben. Bitte wähle eine andere Zeit.' }, 409);
    // Push an den Friseur, ohne die Antwort an den Kunden aufzuhalten
    const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' });
    const [, month, day] = date.split('-');
    // Benachrichtigt werden alle Admins und der zugeteilte Friseur
    const { results: admins } = await env.DB.prepare("SELECT username FROM staff WHERE role = 'admin' AND active = 1").all();
    const recipients = [...admins.map(a => a.username), assigned.username].filter(Boolean);
    const multiple = staff.length > 1 || (await bookableStaff(env)).length > 1;
    const push = notifyAdmins(env, {
        title: `💈 Neuer Termin: ${name}`,
        body: `${weekday}, ${Number(day)}.${Number(month)}. um ${time} Uhr · ${service}${multiple ? ` · bei ${assigned.name}` : ''}`,
        url: `/admin#datum-${date}`,
        tag: `termin-${date}-${time}-${assigned.id}`
    }, recipients.length ? recipients : null).catch(() => { });
    if (ctx?.waitUntil) ctx.waitUntil(push);

    return json({ ok: true, date, time, service, staff: multiple ? assigned.name : null });
}

async function pushSubscribe(request, env, user) {
    const body = await readJson(request);
    const endpoint = String(body?.endpoint || '');
    const p256dh = String(body?.keys?.p256dh || '');
    const auth = String(body?.keys?.auth || '');
    if (!endpoint.startsWith('https://') || !p256dh || !auth) return json({ error: 'Ungültiges Abo.' }, 400);
    await env.DB.prepare(
        'INSERT INTO push_subscriptions (endpoint, p256dh, auth, user) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user = excluded.user'
    ).bind(endpoint, p256dh, auth, user).run();
    return json({ ok: true });
}

async function pushUnsubscribe(request, env) {
    const body = await readJson(request);
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(String(body?.endpoint || '')).run();
    return json({ ok: true });
}

async function adminBookings(url, env) {
    const from = url.searchParams.get('from') || nowInBerlin().date;
    const to = url.searchParams.get('to') || '9999-12-31';
    // visits = bisherige Besuche (Status "erschienen") mit derselben Telefonnummer, für die Treuekarte
    const { results } = await env.DB.prepare(`
        SELECT b.id, b.date, b.time, b.name, b.phone, b.email, b.service, b.blocked, b.status, b.note,
            b.seen, b.source, b.created_at, b.staff_id,
            (SELECT count(*) FROM bookings v WHERE v.phone = b.phone AND v.status = 'erschienen' AND v.blocked = 0) AS visits
        FROM bookings b WHERE b.date >= ? AND b.date <= ? ORDER BY b.date, b.time
    `).bind(from, to).all();
    return json({ bookings: results, services: SERVICES, staff: await bookableStaff(env) });
}

const isUniqueError = error => String(error).includes('UNIQUE');

// Termin ändern: verschieben, Status, Notiz, Kontaktdaten
async function adminUpdate(request, env) {
    const body = await readJson(request);
    if (!body || !Number.isInteger(body.id)) return json({ error: 'Ungültige ID.' }, 400);
    const current = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(body.id).first();
    if (!current) return json({ error: 'Termin nicht gefunden.' }, 404);

    const next = { ...current };
    for (const key of ['date', 'time', 'name', 'phone', 'email', 'service', 'status', 'note']) {
        if (body[key] !== undefined) next[key] = body[key] === null ? null : String(body[key]).trim();
    }
    if (body.seen !== undefined) next.seen = body.seen ? 1 : 0;
    if (body.staff_id !== undefined) next.staff_id = Number(body.staff_id) || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date) || !slotsForDate(next.date).includes(next.time)) {
        return json({ error: 'Zu dieser Zeit ist geöffnet nicht möglich.' }, 400);
    }
    if (!STATUSES.includes(next.status)) return json({ error: 'Ungültiger Status.' }, 400);
    if (!current.blocked) {
        if (!next.name || next.name.length < 2) return json({ error: 'Name fehlt.' }, 400);
        if (!PHONE_PATTERN.test(next.phone)) return json({ error: 'Ungültige Telefonnummer.' }, 400);
        if (next.email && !EMAIL_PATTERN.test(next.email)) return json({ error: 'Ungültige E-Mail-Adresse.' }, 400);
    }

    try {
        await env.DB.prepare(
            'UPDATE bookings SET date = ?, time = ?, name = ?, phone = ?, email = ?, service = ?, status = ?, note = ?, seen = ?, staff_id = ? WHERE id = ?'
        ).bind(next.date, next.time, next.name.slice(0, 80), next.phone.slice(0, 30), next.email ? next.email.slice(0, 120) : null,
            next.service.slice(0, 80), next.status, next.note ? next.note.slice(0, 500) : null, next.seen, next.staff_id, current.id).run();
    } catch (error) {
        if (isUniqueError(error)) return json({ error: 'Zu dieser Zeit hat der Friseur schon einen Termin.' }, 409);
        throw error;
    }
    return json({ ok: true });
}

// Termin von Hand eintragen (z. B. telefonische Buchung)
async function adminCreate(request, env) {
    const body = await readJson(request);
    const date = String(body?.date || '');
    const time = String(body?.time || '');
    const name = String(body?.name || '').trim().slice(0, 80);
    const phone = String(body?.phone || '').trim().slice(0, 30);
    const email = String(body?.email || '').trim().slice(0, 120);
    const service = String(body?.service || 'Sonstiges').slice(0, 80);
    const note = String(body?.note || '').trim().slice(0, 500);
    const staff = await bookableStaff(env);
    const staffId = Number(body?.staff_id) || staff[0]?.id || null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slotsForDate(date).includes(time)) return json({ error: 'Ungültige Zeit.' }, 400);
    if (name.length < 2) return json({ error: 'Name fehlt.' }, 400);
    if (phone && !PHONE_PATTERN.test(phone)) return json({ error: 'Ungültige Telefonnummer.' }, 400);
    if (email && !EMAIL_PATTERN.test(email)) return json({ error: 'Ungültige E-Mail-Adresse.' }, 400);

    try {
        await env.DB.prepare("INSERT INTO bookings (date, time, name, phone, email, service, note, seen, source, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'team', ?)")
            .bind(date, time, name, phone || '-', email || null, service, note || null, staffId).run();
    } catch (error) {
        if (isUniqueError(error)) return json({ error: 'Zu dieser Zeit hat der Friseur schon einen Termin.' }, 409);
        throw error;
    }
    return json({ ok: true });
}

// GALERIE: Bilder liegen als BLOB in D1 (vorher im Browser auf max. 1600 px verkleinert)
const MAX_IMAGE_BYTES = 1.8 * 1024 * 1024;
const IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'];

async function galleryList(env) {
    const { results } = await env.DB.prepare('SELECT id, width, height FROM gallery ORDER BY position, id').all();
    return json({ images: results }, 200);
}

async function galleryImage(id, env) {
    const row = await env.DB.prepare('SELECT type, data FROM gallery WHERE id = ?').bind(id).first();
    if (!row) return new Response('Nicht gefunden', { status: 404 });
    // Jedes Bild hat eine eigene, nie wiederverwendete ID, daher darf es dauerhaft gecacht werden
    return new Response(new Uint8Array(row.data), {
        headers: { 'content-type': row.type, 'cache-control': 'public, max-age=31536000, immutable' }
    });
}

async function readImage(request) {
    const type = (request.headers.get('content-type') || '').split(';')[0];
    if (!IMAGE_TYPES.includes(type)) return { error: 'Nur Bilder (WebP, JPEG, PNG) erlaubt.' };
    const data = await request.arrayBuffer();
    if (data.byteLength === 0) return { error: 'Leere Datei.' };
    if (data.byteLength > MAX_IMAGE_BYTES) return { error: 'Bild zu groß.' };
    return { type, data };
}

async function galleryUpload(request, url, env) {
    const image = await readImage(request);
    if (image.error) return json({ error: image.error }, 400);
    const width = Number(url.searchParams.get('w')) || null;
    const height = Number(url.searchParams.get('h')) || null;
    const replaceId = Number(url.searchParams.get('replace')) || null;

    if (replaceId) {
        // Tauschen: neues Bild bekommt die Position des alten, damit die Reihenfolge bleibt
        const old = await env.DB.prepare('SELECT position FROM gallery WHERE id = ?').bind(replaceId).first();
        if (!old) return json({ error: 'Bild nicht gefunden.' }, 404);
        await env.DB.batch([
            env.DB.prepare('INSERT INTO gallery (position, type, data, width, height) VALUES (?, ?, ?, ?, ?)')
                .bind(old.position, image.type, image.data, width, height),
            env.DB.prepare('DELETE FROM gallery WHERE id = ?').bind(replaceId)
        ]);
        return json({ ok: true });
    }

    const { next } = await env.DB.prepare('SELECT coalesce(max(position), -1) + 1 AS next FROM gallery').first();
    await env.DB.prepare('INSERT INTO gallery (position, type, data, width, height) VALUES (?, ?, ?, ?, ?)')
        .bind(next, image.type, image.data, width, height).run();
    return json({ ok: true });
}

async function galleryOrder(request, env) {
    const body = await readJson(request);
    const ids = Array.isArray(body?.ids) ? body.ids.filter(Number.isInteger) : [];
    if (ids.length === 0) return json({ error: 'Keine Reihenfolge.' }, 400);
    const update = env.DB.prepare('UPDATE gallery SET position = ? WHERE id = ?');
    await env.DB.batch(ids.map((id, index) => update.bind(index, id)));
    return json({ ok: true });
}

async function galleryDelete(request, env) {
    const body = await readJson(request);
    if (!body || !Number.isInteger(body.id)) return json({ error: 'Ungültige ID.' }, 400);
    await env.DB.prepare('DELETE FROM gallery WHERE id = ?').bind(body.id).run();
    return json({ ok: true });
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
    // staff_id: ein Friseur, oder "all" = für alle, die Termine annehmen
    const staffIds = body?.staff_id === 'all' || !body?.staff_id
        ? (await bookableStaff(env)).map(s => s.id)
        : [Number(body.staff_id)];
    const insert = env.DB.prepare(
        "INSERT OR IGNORE INTO bookings (date, time, name, phone, service, blocked, source, staff_id) VALUES (?, ?, 'Blockiert', '-', 'Blockiert', 1, 'team', ?)"
    );
    await env.DB.batch((staffIds.length ? staffIds : [null]).flatMap(id => validTimes.map(t => insert.bind(date, t, id))));
    return json({ ok: true });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname}`;

        if (route === 'GET /api/services') {
            const staff = await bookableStaff(env);
            return json({ services: SERVICES, staff: staff.length > 1 ? staff.map(s => ({ id: s.id, name: s.name })) : [] });
        }
        if (route === 'GET /api/setup') return setupInfo(url, env);
        if (route === 'POST /api/setup') return setupPassword(request, env);
        if (route === 'GET /api/gallery') return galleryList(env);
        const imageMatch = url.pathname.match(/^\/api\/gallery\/(\d+)$/);
        if (request.method === 'GET' && imageMatch) return galleryImage(Number(imageMatch[1]), env);
        if (route === 'GET /api/slots') return getSlots(url, env);
        if (route === 'POST /api/book') return book(request, env, ctx);

        if (url.pathname.startsWith('/api/admin/')) {
            if (route === 'POST /api/admin/login') return login(request, env);
            if (route === 'POST /api/admin/logout') {
                return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'set-cookie': clearCookie() } });
            }
            const me = await currentStaff(request, env);
            if (!me) return json({ error: 'Nicht angemeldet.' }, 401);
            const isAdmin = me.role === 'admin';
            const user = me.username;
            if (route === 'GET /api/admin/me') return json({ user: publicStaff(me) });
            if (route === 'POST /api/admin/account/password') return changePassword(request, env, me);
            if (route === 'GET /api/admin/bookings') return adminBookings(url, env);
            if (route === 'POST /api/admin/delete') return adminDelete(request, env);
            if (route === 'POST /api/admin/block') return adminBlock(request, env);
            if (route === 'POST /api/admin/update') return adminUpdate(request, env);
            if (route === 'POST /api/admin/create') return adminCreate(request, env);
            if (route === 'GET /api/admin/push/key') return json({ key: env.VAPID_PUBLIC_KEY || null });
            if (route === 'POST /api/admin/push/subscribe') return pushSubscribe(request, env, user);
            if (route === 'POST /api/admin/push/unsubscribe') return pushUnsubscribe(request, env);
            if (route === 'POST /api/admin/push/test') {
                return json(await notifyAdmins(env, { title: '💈 Test von Fresh Fade', body: 'Benachrichtigungen funktionieren!', url: '/admin', tag: 'test' }, [user]));
            }

            // Ab hier nur für Admins: Team und Galerie
            if (!isAdmin) return json({ error: 'Nur für Admins.' }, 403);
            if (route === 'GET /api/admin/staff') return listStaff(env);
            if (route === 'POST /api/admin/staff') return saveStaff(request, env, me);
            if (route === 'POST /api/admin/staff/invite') return createInvite(request, env);
            if (route === 'POST /api/admin/gallery') return galleryUpload(request, url, env);
            if (route === 'POST /api/admin/gallery/order') return galleryOrder(request, env);
            if (route === 'POST /api/admin/gallery/delete') return galleryDelete(request, env);
        }

        return json({ error: 'Nicht gefunden.' }, 404);
    }
};
