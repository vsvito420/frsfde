-- seen: 0 = neue Online-Buchung, noch nicht im Admin geöffnet
-- source: 'website' (Kunde online) oder 'team' (im Admin eingetragen)
ALTER TABLE bookings ADD COLUMN seen INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'website';
UPDATE bookings SET source = 'team' WHERE blocked = 1;
