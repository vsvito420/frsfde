// Web Push ohne externe Bibliothek: Verschlüsselung nach RFC 8291 (aes128gcm),
// Absender-Signatur nach RFC 8292 (VAPID). Läuft komplett mit WebCrypto.

const encoder = new TextEncoder();

const base64UrlEncode = bytes =>
    btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const base64UrlDecode = text =>
    Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0));

function concat(...parts) {
    const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

async function hkdf(salt, ikm, info, length) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

export async function encryptPayload(subscription, payload) {
    const uaPublic = base64UrlDecode(subscription.p256dh);
    const authSecret = base64UrlDecode(subscription.auth);

    const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
    const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256));

    const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

    // 0x02 = Ende des letzten (und einzigen) Datensatzes
    const plaintext = concat(encoder.encode(payload), new Uint8Array([2]));
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

    const recordSize = new Uint8Array([0, 0, 0x10, 0]); // 4096
    return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function vapidHeader(endpoint, env) {
    const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = base64UrlEncode(encoder.encode(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: 'https://freshfade-studio.de'
    })));
    const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`));
    return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Schickt eine Nachricht an registrierte Team-Geräte; abgelaufene Abos werden entfernt
// usernames: nur an diese Personen schicken (null = an alle)
export async function notifyAdmins(env, message, usernames = null) {
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return { sent: 0, failed: 0 };
    let { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth, user FROM push_subscriptions').all();
    if (usernames) {
        const wanted = new Set(usernames.map(u => String(u).toLowerCase()));
        results = results.filter(r => wanted.has(String(r.user || '').toLowerCase()));
    }
    let sent = 0;
    let failed = 0;

    await Promise.all(results.map(async subscription => {
        try {
            const response = await fetch(subscription.endpoint, {
                method: 'POST',
                headers: {
                    authorization: await vapidHeader(subscription.endpoint, env),
                    'content-encoding': 'aes128gcm',
                    'content-type': 'application/octet-stream',
                    ttl: String(24 * 60 * 60),
                    urgency: 'high'
                },
                body: await encryptPayload(subscription, JSON.stringify(message))
            });
            if (response.status === 404 || response.status === 410) {
                await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(subscription.endpoint).run();
                failed++;
            } else if (response.ok) {
                sent++;
            } else {
                failed++;
            }
        } catch {
            failed++;
        }
    }));
    return { sent, failed };
}
