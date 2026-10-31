import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const RUTA = process.env.DB_PATH ?? './datos/chat.db';
mkdirSync(dirname(RUTA), { recursive: true });

export const db = new DatabaseSync(RUTA);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS cuentas (
    id INTEGER PRIMARY KEY,
    usuario TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    sal TEXT NOT NULL,
    codigo_fijo TEXT NOT NULL UNIQUE,
    creada_en INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    cuenta_id INTEGER NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
    creada_en INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS temporales (
    codigo TEXT PRIMARY KEY,
    cuenta_id INTEGER NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
    cambia_en INTEGER NOT NULL,
    acepta_hasta INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS temporales_cuenta ON temporales (cuenta_id);

  CREATE TABLE IF NOT EXISTS contactos (
    cuenta_id INTEGER NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
    otro_id INTEGER NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
    bloqueado INTEGER NOT NULL DEFAULT 0,
    desde INTEGER NOT NULL,
    PRIMARY KEY (cuenta_id, otro_id)
  );
`);
