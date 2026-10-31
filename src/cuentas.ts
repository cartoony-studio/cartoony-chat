import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

export class ErrorChat extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export type Cuenta = {
  id: number;
  usuario: string;
  codigoFijo: string;
};

type FilaCuenta = {
  id: number;
  usuario: string;
  hash: string;
  sal: string;
  codigo_fijo: string;
};

// Sin I, O, 0 ni 1: el código se dicta en voz alta y se teclea a mano.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO_CODIGO = 7;
const VIGENCIA_TEMPORAL = 120_000;
const TOLERANCIA_TEMPORAL = 120_000;
const LARGO_MINIMO_CONTRASENA = 8;

function azar(): string {
  const bytes = randomBytes(LARGO_CODIGO);
  let texto = '';
  for (const byte of bytes) texto += ALFABETO[byte % ALFABETO.length];
  return `${texto.slice(0, 3)}-${texto.slice(3)}`;
}

function codigoDeCuenta(): string {
  let candidato = azar();
  while (db.prepare('SELECT 1 FROM cuentas WHERE codigo_fijo = ?').get(candidato)) {
    candidato = azar();
  }
  return candidato;
}

function codigoTemporalNuevo(): string {
  let candidato = azar();
  while (db.prepare('SELECT 1 FROM temporales WHERE codigo = ?').get(candidato)) {
    candidato = azar();
  }
  return candidato;
}

function hashDe(contrasena: string, sal: string): string {
  return scryptSync(contrasena, sal, 64).toString('hex');
}

function aCuenta(fila: FilaCuenta): Cuenta {
  return { id: fila.id, usuario: fila.usuario, codigoFijo: fila.codigo_fijo };
}

function filaPorUsuario(usuario: string): FilaCuenta | undefined {
  return db.prepare('SELECT * FROM cuentas WHERE usuario = ?').get(usuario) as FilaCuenta | undefined;
}

function filaPorId(id: number): FilaCuenta | undefined {
  return db.prepare('SELECT * FROM cuentas WHERE id = ?').get(id) as FilaCuenta | undefined;
}

export function cuentaPorUsuario(usuario: string): Cuenta | null {
  const fila = filaPorUsuario(usuario);
  return fila ? aCuenta(fila) : null;
}

function validarUsuario(usuario: string): void {
  if (!/^[a-z0-9_]{3,20}$/.test(usuario)) {
    throw new ErrorChat(400, 'El usuario debe tener entre 3 y 20 caracteres: letras, números o _');
  }
}

function validarContrasena(contrasena: string): void {
  if (contrasena.length < LARGO_MINIMO_CONTRASENA) {
    throw new ErrorChat(400, `La contraseña necesita al menos ${LARGO_MINIMO_CONTRASENA} caracteres`);
  }
  if (contrasena.length > 200) throw new ErrorChat(400, 'La contraseña es demasiado larga');
}

function abrirSesion(cuenta: Cuenta): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token, cuenta_id, creada_en) VALUES (?, ?, ?)').run(
    token,
    cuenta.id,
    Date.now(),
  );
  return token;
}

export function registrar(usuario: string, contrasena: string): Cuenta & { token: string } {
  validarUsuario(usuario);
  validarContrasena(contrasena);

  if (filaPorUsuario(usuario)) throw new ErrorChat(409, 'Ese usuario ya existe');

  const sal = randomBytes(16).toString('hex');
  const resultado = db
    .prepare('INSERT INTO cuentas (usuario, hash, sal, codigo_fijo, creada_en) VALUES (?, ?, ?, ?, ?)')
    .run(usuario, hashDe(contrasena, sal), sal, codigoDeCuenta(), Date.now());

  const fila = filaPorId(Number(resultado.lastInsertRowid));
  if (!fila) throw new ErrorChat(500, 'No se pudo crear la cuenta');

  const cuenta = aCuenta(fila);
  return { ...cuenta, token: abrirSesion(cuenta) };
}

export function entrar(usuario: string, contrasena: string): Cuenta & { token: string } {
  const fila = filaPorUsuario(usuario);
  if (!fila) throw new ErrorChat(401, 'Usuario o contraseña incorrectos');

  const esperado = Buffer.from(fila.hash, 'hex');
  const recibido = Buffer.from(hashDe(contrasena, fila.sal), 'hex');
  if (esperado.length !== recibido.length || !timingSafeEqual(esperado, recibido)) {
    throw new ErrorChat(401, 'Usuario o contraseña incorrectos');
  }

  const cuenta = aCuenta(fila);
  return { ...cuenta, token: abrirSesion(cuenta) };
}

export function salir(token: string): void {
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
}

export function cuentaPorToken(token: string): Cuenta | null {
  const fila = db
    .prepare('SELECT cuenta_id FROM sesiones WHERE token = ?')
    .get(token) as { cuenta_id: number } | undefined;
  if (!fila) return null;

  const cuenta = filaPorId(fila.cuenta_id);
  return cuenta ? aCuenta(cuenta) : null;
}

/* ---------- códigos ---------- */

export function normalizarCodigo(texto: string): string {
  const limpio = texto.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LARGO_CODIGO);
  return limpio.length === LARGO_CODIGO ? `${limpio.slice(0, 3)}-${limpio.slice(3)}` : '';
}

export function codigoTemporal(cuentaId: number): { codigo: string; cambiaEn: number } {
  const ahora = Date.now();
  db.prepare('DELETE FROM temporales WHERE acepta_hasta < ?').run(ahora);

  const actual = db
    .prepare('SELECT codigo, cambia_en FROM temporales WHERE cuenta_id = ? AND cambia_en > ?')
    .get(cuentaId, ahora) as { codigo: string; cambia_en: number } | undefined;

  if (actual) return { codigo: actual.codigo, cambiaEn: Number(actual.cambia_en) };

  // El anterior no se borra: sigue siendo válido durante la tolerancia.
  const codigo = codigoTemporalNuevo();
  const cambiaEn = ahora + VIGENCIA_TEMPORAL;
  db.prepare('INSERT INTO temporales (codigo, cuenta_id, cambia_en, acepta_hasta) VALUES (?, ?, ?, ?)').run(
    codigo,
    cuentaId,
    cambiaEn,
    cambiaEn + TOLERANCIA_TEMPORAL,
  );
  return { codigo, cambiaEn };
}

export function resolverCodigo(texto: string): Cuenta | null {
  const codigo = normalizarCodigo(texto);
  if (!codigo) return null;

  const fija = db.prepare('SELECT * FROM cuentas WHERE codigo_fijo = ?').get(codigo) as FilaCuenta | undefined;
  if (fija) return aCuenta(fija);

  const temporal = db
    .prepare('SELECT cuenta_id FROM temporales WHERE codigo = ? AND acepta_hasta > ?')
    .get(codigo, Date.now()) as { cuenta_id: number } | undefined;
  if (!temporal) return null;

  const fila = filaPorId(temporal.cuenta_id);
  return fila ? aCuenta(fila) : null;
}

/* ---------- contactos ---------- */

export function agregarContacto(cuentaId: number, otroId: number): void {
  if (cuentaId === otroId) throw new ErrorChat(400, 'Ese código es tuyo');

  const existente = db
    .prepare('SELECT 1 FROM contactos WHERE cuenta_id = ? AND otro_id = ?')
    .get(cuentaId, otroId);
  if (existente) throw new ErrorChat(409, 'Ya está en tus contactos');

  // El vínculo es mutuo: si alguien te fija con tu código, tú también lo ves.
  const ahora = Date.now();
  db.prepare('INSERT INTO contactos (cuenta_id, otro_id, bloqueado, desde) VALUES (?, ?, 0, ?)').run(
    cuentaId,
    otroId,
    ahora,
  );
  db.prepare(
    'INSERT OR IGNORE INTO contactos (cuenta_id, otro_id, bloqueado, desde) VALUES (?, ?, 0, ?)',
  ).run(otroId, cuentaId, ahora);
}

export type Contacto = { usuario: string; bloqueado: boolean };

export function listarContactos(cuentaId: number): Contacto[] {
  const filas = db
    .prepare(
      `SELECT c.usuario, x.bloqueado
         FROM contactos x
         JOIN cuentas c ON c.id = x.otro_id
        WHERE x.cuenta_id = ?
        ORDER BY c.usuario COLLATE NOCASE`,
    )
    .all(cuentaId) as { usuario: string; bloqueado: number }[];

  return filas.map((fila) => ({ usuario: fila.usuario, bloqueado: fila.bloqueado === 1 }));
}

export function idsDeContactos(cuentaId: number): number[] {
  return (
    db.prepare('SELECT otro_id AS id FROM contactos WHERE cuenta_id = ?').all(cuentaId) as { id: number }[]
  ).map((fila) => fila.id);
}

export function estaEnContactos(cuentaId: number, otroId: number): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM contactos WHERE cuenta_id = ? AND otro_id = ?').get(cuentaId, otroId),
  );
}

export function bloqueadoPor(destinatarioId: number, remitenteId: number): boolean {
  const fila = db
    .prepare('SELECT bloqueado FROM contactos WHERE cuenta_id = ? AND otro_id = ?')
    .get(destinatarioId, remitenteId) as { bloqueado: number } | undefined;
  return fila?.bloqueado === 1;
}

export function cambiarBloqueo(cuentaId: number, otroUsuario: string, bloqueado: boolean): void {
  const otro = filaPorUsuario(otroUsuario);
  if (!otro) throw new ErrorChat(404, 'Ese contacto no existe');

  const resultado = db
    .prepare('UPDATE contactos SET bloqueado = ? WHERE cuenta_id = ? AND otro_id = ?')
    .run(bloqueado ? 1 : 0, cuentaId, otro.id);
  if (resultado.changes === 0) throw new ErrorChat(404, 'Ese contacto no existe');
}

export function eliminarContacto(cuentaId: number, otroUsuario: string): void {
  const otro = filaPorUsuario(otroUsuario);
  if (!otro) throw new ErrorChat(404, 'Ese contacto no existe');

  db.prepare('DELETE FROM contactos WHERE cuenta_id = ? AND otro_id = ?').run(cuentaId, otro.id);
}
