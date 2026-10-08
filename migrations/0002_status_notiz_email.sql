-- Status, Notiz und E-Mail für Termine. Abgesagte Termine geben den Slot wieder frei,
-- deshalb gilt die Eindeutigkeit (Datum + Uhrzeit) nur für nicht abgesagte Termine.
CREATE TABLE bookings_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    service TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'gebucht',  -- gebucht | erschienen | nicht_erschienen | abgesagt
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bookings_new (id, date, time, name, phone, service, blocked, created_at)
SELECT id, date, time, name, phone, service, blocked, created_at FROM bookings;

DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;

CREATE UNIQUE INDEX bookings_slot ON bookings (date, time) WHERE status != 'abgesagt';
CREATE INDEX bookings_phone ON bookings (phone);
