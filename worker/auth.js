// Team-Logins: Passwörter (PBKDF2), Sitzungs-Cookie, Einladungs-Links und Rollen.

const encoder = new TextEncoder();
const SESSION_COOKIE = 'ff_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;
const SETUP_DAYS = 7;

const toBase64Url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0));

const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

// Vergleich in konstanter Zeit
function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

async function verifyPassword(password, stored) {
    const [scheme, iterations, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2') return false;
    return sameBytes(await pbkdf2(password, fromBase64Url(salt), Number(iterations)), fromBase64Url(hash));
}

const sha256 = async text => toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

async function sign(env, text) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

export const publicStaff = s => ({
    id: s.id, username: s.username, name: s.name, role: s.role,
    bookable: s.bookable, active: s.active,
    hasPassword: Boolean(s.password_hash),
    invitePending: Boolean(s.setup_hash && s.setup_expires > Date.now())
});

async function sessionCookie(request, env, staff) {
    const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
    const payload = `${staff.id}|${staff.pw_version}|${expires}`;
    const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
    return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}|${await sign(env, payload)}`)}; Path=/api; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 3600}`;
}

export const clearCookie = () => `${SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`;
// Altes Cookie aus der Zeit vor dem Team-Login (Pfad /api/admin) entfernen, sonst schickt der Browser beide
export const clearLegacyCookie = () => `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`;

// Angemeldete Person aus dem Cookie (oder null)
// Der Browser kann mehrere ff_session-Cookies schicken (z. B. ein altes mit anderem Pfad): jedes prüfen
export async function currentStaff(request, env) {
    if (!env.SESSION_SECRET) return null;
    const cookies = (request.headers.get('cookie') || '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${SESSION_COOKIE}=`));
    for (const cookie of cookies) {
        const parts = decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)).split('|');
        if (parts.length !== 4) continue;
        const [id, version, expires, signature] = parts;
        if (Number(expires) < Date.now()) continue;
        if (!sameBytes(encoder.encode(signature), encoder.encode(await sign(env, `${id}|${version}|${expires}`)))) continue;
        const staff = await env.DB.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').bind(Number(id)).first();
        if (staff && String(staff.pw_version) === version) return staff;
    }
    return null;
}

// Einmalig: bestehende Zugänge aus dem Secret ADMIN_USERS ins Team übernehmen
async function bootstrapFromEnv(env) {
    const { count } = await env.DB.prepare('SELECT count(*) AS count FROM staff').first();
    if (count > 0) return;
    const users = String(env.ADMIN_USERS || '').split(',').map(entry => {
        const i = entry.indexOf(':');
        return i > 0 ? { username: entry.slice(0, i).trim(), password: entry.slice(i + 1).trim() } : null;
    }).filter(Boolean);
    if (!users.length) return;

    const statements = [];
    for (const [index, user] of users.entries()) {
        // "sorin" war ein Tippfehler: der Inhaber heißt Zorin
        const username = user.username.toLowerCase() === 'sorin' ? 'zorin' : user.username.toLowerCase();
        const name = username.charAt(0).toUpperCase() + username.slice(1);
        const bookable = username === 'vito' ? 0 : 1;
        statements.push(env.DB.prepare('INSERT INTO staff (username, name, role, bookable, password_hash, sort) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(username, name, 'admin', bookable, await hashPassword(user.password), index));
    }
    await env.DB.batch(statements);
    // Bisherige Termine gehören dem ersten Friseur, der Termine annimmt
    await env.DB.prepare('UPDATE bookings SET staff_id = (SELECT id FROM staff WHERE bookable = 1 ORDER BY sort, id LIMIT 1) WHERE staff_id IS NULL').run();
}

export async function login(request, env) {
    await bootstrapFromEnv(env);
    const body = await readJson(request);
    let username = String(body?.user || '').trim();
    if (username.toLowerCase() === 'sorin') username = 'zorin';
    const staff = await env.DB.prepare('SELECT * FROM staff WHERE username = ? AND active = 1').bind(username).first();
    const ok = staff && env.SESSION_SECRET && await verifyPassword(String(body?.password || ''), staff.password_hash);
    if (!ok) {
        await new Promise(resolve => setTimeout(resolve, 800));
        return json({ error: 'Benutzername oder Passwort falsch.' }, 401);
    }
    return withCookies({ user: publicStaff(staff) }, [await sessionCookie(request, env, staff), clearLegacyCookie()]);
}

// Mehrere Set-Cookie-Header in einer Antwort
function withCookies(data, cookies) {
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    for (const c of cookies) headers.append('set-cookie', c);
    return new Response(JSON.stringify(data), { headers });
}

const PASSWORD_HINT = 'Das Passwort braucht mindestens 8 Zeichen.';
const validPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

export async function changePassword(request, env, staff) {
    const body = await readJson(request);
    if (!(await verifyPassword(String(body?.current || ''), staff.password_hash))) return json({ error: 'Aktuelles Passwort stimmt nicht.' }, 400);
    if (!validPassword(body?.next)) return json({ error: PASSWORD_HINT }, 400);
    await env.DB.prepare('UPDATE staff SET password_hash = ?, pw_version = pw_version + 1 WHERE id = ?').bind(await hashPassword(body.next), staff.id).run();
    const updated = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(staff.id).first();
    // Andere Geräte werden abgemeldet, dieses bleibt angemeldet
    return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(request, env, updated) });
}

// Einladungs- bzw. Passwort-Link erzeugen (nur Admin)
export async function createInvite(request, env) {
    const body = await readJson(request);
    const staff = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(Number(body?.id)).first();
    if (!staff) return json({ error: 'Person nicht gefunden.' }, 404);
    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const expires = Date.now() + SETUP_DAYS * 24 * 3600 * 1000;
    await env.DB.prepare('UPDATE staff SET setup_hash = ?, setup_expires = ? WHERE id = ?').bind(await sha256(token), expires, staff.id).run();
    const link = `${new URL(request.url).origin}/admin#setup=${token}`;
    return json({ link, expires, name: staff.name, username: staff.username });
}

async function staffByToken(env, token) {
    if (!token) return null;
    const staff = await env.DB.prepare('SELECT * FROM staff WHERE setup_hash = ? AND active = 1').bind(await sha256(token)).first();
    return staff && staff.setup_expires > Date.now() ? staff : null;
}

// Öffentlich: Passwort über Einladungs-Link setzen
export async function setupInfo(url, env) {
    const staff = await staffByToken(env, url.searchParams.get('token'));
    if (!staff) return json({ error: 'Der Link ist abgelaufen oder wurde schon benutzt. Bitte einen neuen Link anfordern.' }, 404);
    return json({ name: staff.name, username: staff.username });
}

export async function setupPassword(request, env) {
    const body = await readJson(request);
    const staff = await staffByToken(env, String(body?.token || ''));
    if (!staff) return json({ error: 'Der Link ist abgelaufen oder wurde schon benutzt.' }, 404);
    if (!validPassword(body?.password)) return json({ error: PASSWORD_HINT }, 400);
    await env.DB.prepare('UPDATE staff SET password_hash = ?, pw_version = pw_version + 1, setup_hash = NULL, setup_expires = NULL WHERE id = ?')
        .bind(await hashPassword(body.password), staff.id).run();
    const updated = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(staff.id).first();
    return withCookies({ user: publicStaff(updated) }, [await sessionCookie(request, env, updated), clearLegacyCookie()]);
}

// Team verwalten (nur Admin)
export async function listStaff(env) {
    const { results } = await env.DB.prepare('SELECT * FROM staff ORDER BY active DESC, sort, id').all();
    return json({ staff: results.map(publicStaff) });
}

export async function saveStaff(request, env, me) {
    const body = await readJson(request);
    const id = Number(body?.id) || null;
    const name = String(body?.name || '').trim().slice(0, 60);
    const username = String(body?.username || '').trim().toLowerCase();
    const role = body?.role === 'admin' ? 'admin' : 'friseur';
    const bookable = body?.bookable ? 1 : 0;
    const active = body?.active === false ? 0 : 1;

    if (name.length < 2) return json({ error: 'Name fehlt.' }, 400);
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: 'Benutzername: 3–30 Zeichen, nur a–z, 0–9, Punkt, Strich.' }, 400);

    if (id) {
        const current = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first();
        if (!current) return json({ error: 'Person nicht gefunden.' }, 404);
        if (id === me.id && (role !== 'admin' || !active)) return json({ error: 'Du kannst dir selbst die Admin-Rolle nicht nehmen.' }, 400);
        if (current.role === 'admin' && (role !== 'admin' || !active)) {
            const { admins } = await env.DB.prepare("SELECT count(*) AS admins FROM staff WHERE role = 'admin' AND active = 1").first();
            if (admins <= 1) return json({ error: 'Es muss mindestens einen Admin geben.' }, 400);
        }
    }

    try {
        if (id) {
            // Deaktivieren meldet alle Geräte der Person ab
            await env.DB.prepare('UPDATE staff SET name = ?, username = ?, role = ?, bookable = ?, active = ?, pw_version = pw_version + (CASE WHEN ? = 0 THEN 1 ELSE 0 END) WHERE id = ?')
                .bind(name, username, role, bookable, active, active, id).run();
        } else {
            await env.DB.prepare('INSERT INTO staff (name, username, role, bookable, sort) VALUES (?, ?, ?, ?, (SELECT coalesce(max(sort), 0) + 1 FROM staff))')
                .bind(name, username, role, bookable).run();
        }
    } catch (error) {
        if (String(error).includes('UNIQUE')) return json({ error: 'Diesen Benutzernamen gibt es schon.' }, 409);
        throw error;
    }
    const saved = await env.DB.prepare('SELECT * FROM staff WHERE username = ?').bind(username).first();
    return json({ staff: publicStaff(saved) });
}
