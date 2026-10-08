-- Galerie-Bilder, vom Friseur über /admin hochgeladen (im Browser verkleinert, WebP)
CREATE TABLE gallery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    data BLOB NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX gallery_position ON gallery (position);
