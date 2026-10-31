import type { WebSocket } from 'ws';

// El historial vive en memoria a propósito: son solo tres mensajes por
// conversación y se pierden al reiniciar.
const MAX_MENSAJES = 3;

export type Mensaje = { de: string; texto: string; hora: number };

const conexiones = new Map<string, Set<WebSocket>>();
const historial = new Map<string, Mensaje[]>();

export function conectar(usuario: string, socket: WebSocket): void {
  const lista = conexiones.get(usuario) ?? new Set<WebSocket>();
  lista.add(socket);
  conexiones.set(usuario, lista);
}

/** Devuelve true si con esta desconexión la persona quedó sin ventanas abiertas. */
export function desconectar(usuario: string, socket: WebSocket): boolean {
  const lista = conexiones.get(usuario);
  if (!lista) return false;

  lista.delete(socket);
  if (lista.size > 0) return false;

  conexiones.delete(usuario);
  return true;
}

export function enLinea(usuario: string): boolean {
  return conexiones.has(usuario);
}

export function enviarA(usuario: string, datos: unknown): void {
  const texto = JSON.stringify(datos);
  for (const socket of conexiones.get(usuario) ?? []) {
    if (socket.readyState === socket.OPEN) socket.send(texto);
  }
}

function clave(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function guardar(a: string, b: string, mensaje: Mensaje): void {
  const lista = historial.get(clave(a, b)) ?? [];
  lista.push(mensaje);
  while (lista.length > MAX_MENSAJES) lista.shift();
  historial.set(clave(a, b), lista);
}

export function recientes(a: string, b: string): Mensaje[] {
  return historial.get(clave(a, b)) ?? [];
}
