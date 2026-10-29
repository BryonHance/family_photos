import type { DatabaseSync } from "node:sqlite";

/**
 * Brings a table of faces.db made by an older version of the viewer up to
 * `definition` (its columns and constraints, in parentheses), which SQLite
 * cannot add to an existing table: `prepare` first fixes rows the new
 * constraints would refuse, then the table is rebuilt under `definition` with
 * the columns the two share, as SQLite's documentation describes. Nothing
 * happens when the table already has this definition. Indexes on the table
 * are dropped with it, so create them afterwards.
 */
export function upgradeTable(db: DatabaseSync, table: string, definition: string, prepare: string) {
  const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!stored || stored.sql === `CREATE TABLE ${table} ${definition}`) return;

  const columnsOf = (name: string) =>
    (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((column) => column.name);
  const old = new Set(columnsOf(table));
  // Other tables' foreign keys point at the table by name: off while it is
  // replaced, so that dropping the old one neither cascades nor fails.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(prepare);
      db.exec(`CREATE TABLE ${table}_upgraded ${definition}`);
      const shared = columnsOf(`${table}_upgraded`)
        .filter((column) => old.has(column))
        .join(", ");
      db.exec(`INSERT INTO ${table}_upgraded (${shared}) SELECT ${shared} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_upgraded RENAME TO ${table}`);
      if (db.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error(`Upgrading ${table} broke a foreign key`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
