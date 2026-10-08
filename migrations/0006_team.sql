-- Team: Admins und Friseure mit eigenem Login. Passwörter nur als PBKDF2-Hash.
CREATE TABLE staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'friseur',      -- admin | friseur
    bookable INTEGER NOT NULL DEFAULT 1,       -- nimmt Termine an
    active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    pw_version INTEGER NOT NULL DEFAULT 1,     -- erhöht sich bei Passwortwechsel, alte Sitzungen werden ungültig
    setup_hash TEXT,                           -- Einladungs-/Passwort-Link (nur Hash gespeichert)
    setup_expires INTEGER,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jeder Termin gehört einem Friseur; pro Friseur ist eine Uhrzeit nur einmal vergeben
ALTER TABLE bookings ADD COLUMN staff_id INTEGER;
DROP INDEX bookings_slot;
CREATE UNIQUE INDEX bookings_slot ON bookings (date, time, coalesce(staff_id, 0)) WHERE status != 'abgesagt';
