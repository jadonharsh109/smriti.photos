-- Locked section: files hidden from every view until unlocked with the passcode.
CREATE TABLE locked_items (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  locked_at INTEGER NOT NULL
);
