-- Schichtplan: Arbeitszeiten pro Wochentag. Ohne Einträge arbeitet ein Friseur alle Öffnungszeiten (100 %).
CREATE TABLE staff_hours (
    staff_id INTEGER NOT NULL,
    weekday INTEGER NOT NULL,       -- 0 = Sonntag … 6 = Samstag
    start TEXT,                     -- NULL = an diesem Tag frei
    end TEXT,
    PRIMARY KEY (staff_id, weekday)
);

-- Abwesenheiten (ganze Tage): Urlaub, krank, frei …
CREATE TABLE staff_absence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'urlaub',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX staff_absence_range ON staff_absence (staff_id, date_to);
