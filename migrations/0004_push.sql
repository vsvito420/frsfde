-- Push-Abos der Admin-App (ein Eintrag pro Gerät)
CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
