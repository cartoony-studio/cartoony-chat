import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  ErrorChat,
  agregarContacto,
  bloqueadoPor,
  cambiarBloqueo,
  codigoTemporal,
  cuentaPorToken,
  cuentaPorUsuario,
  eliminarContacto,
  entrar,
  estaEnContactos,
  listarContactos,
  registrar,
  resolverCodigo,
  salir,
  type Cuenta,
} from './cuentas.js';
import { conectar, desconectar, enviarA, enLinea, guardar, recientes } from './estado.js';

const PORT = Number(process.env.PORT ?? 8080);
const LARGO_MAXIMO_TEXTO = 180;

const CABECERAS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};

function responder(res: ServerResponse, estado: number, datos: unknown): void {
  res.writeHead(estado, { ...CABECERAS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(datos));
}

async function leerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const trozos: Buffer[] = [];
  let total = 0;

  for await (const trozo of req) {
    total += (trozo as Buffer).length;
    if (total > 8192) throw new ErrorChat(413, 'El cuerpo es demasiado grande');
    trozos.push(trozo as Buffer);
  }

  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(trozos).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ErrorChat(400, 'JSON inválido');
  }
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

function autenticar(req: IncomingMessage): Cuenta {
  const cabecera = req.headers.authorization ?? '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  const cuenta = token ? cuentaPorToken(token) : null;
  if (!cuenta) throw new ErrorChat(401, 'Sesión inválida');
  return cuenta;
}

async function enrutar(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ruta = url.pathname;
  const partes = ruta.split('/').filter(Boolean);

  if (req.method === 'GET' && ruta === '/health') {
    responder(res, 200, { ok: true, servicio: 'cartoony-chat' });
    return;
  }

  if (req.method === 'POST' && ruta === '/registro') {
    const cuerpo = await leerJson(req);
    responder(res, 201, registrar(texto(cuerpo.usuario), texto(cuerpo.contrasena)));
    return;
  }

  if (req.method === 'POST' && ruta === '/login') {
    const cuerpo = await leerJson(req);
    responder(res, 200, entrar(texto(cuerpo.usuario), texto(cuerpo.contrasena)));
    return;
  }

  if (req.method === 'POST' && ruta === '/salir') {
    const cabecera = req.headers.authorization ?? '';
    if (cabecera.startsWith('Bearer ')) salir(cabecera.slice(7));
    responder(res, 200, { ok: true });
    return;
  }

  const cuenta = autenticar(req);

  if (req.method === 'GET' && ruta === '/yo') {
    const temporal = codigoTemporal(cuenta.id);
    responder(res, 200, {
      usuario: cuenta.usuario,
      codigoFijo: cuenta.codigoFijo,
      codigoTemporal: temporal.codigo,
      cambiaEn: temporal.cambiaEn,
    });
    return;
  }

  if (req.method === 'GET' && ruta === '/contactos') {
    const contactos = listarContactos(cuenta.id).map((contacto) => ({
      usuario: contacto.usuario,
      bloqueado: contacto.bloqueado,
      enLinea: enLinea(contacto.usuario),
    }));
    responder(res, 200, { contactos });
    return;
  }

  if (req.method === 'POST' && ruta === '/contactos') {
    const cuerpo = await leerJson(req);
    const otro = resolverCodigo(texto(cuerpo.codigo));
    if (!otro) throw new ErrorChat(404, 'Ese código no existe o ya venció');

    agregarContacto(cuenta.id, otro.id);
    responder(res, 201, { usuario: otro.usuario, enLinea: enLinea(otro.usuario) });
    return;
  }

  if (req.method === 'POST' && partes.length === 3 && partes[0] === 'contactos' && partes[2] === 'bloqueo') {
    const cuerpo = await leerJson(req);
    cambiarBloqueo(cuenta.id, decodeURIComponent(partes[1]), cuerpo.bloqueado === true);
    responder(res, 200, { ok: true });
    return;
  }

  if (req.method === 'DELETE' && partes.length === 2 && partes[0] === 'contactos') {
    eliminarContacto(cuenta.id, decodeURIComponent(partes[1]));
    responder(res, 200, { ok: true });
    return;
  }

  responder(res, 404, { error: 'no encontrado' });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CABECERAS);
    res.end();
    return;
  }

  enrutar(req, res, url).catch((error: unknown) => {
    if (error instanceof ErrorChat) {
      responder(res, error.estado, { error: error.message });
      return;
    }
    console.error(error);
    responder(res, 500, { error: 'fallo interno' });
  });
});

function avisarPresencia(cuenta: Cuenta, conectada: boolean): void {
  for (const contacto of listarContactos(cuenta.id)) {
    enviarA(contacto.usuario, {
      tipo: 'presencia',
      usuario: cuenta.usuario,
      enLinea: conectada,
    });
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, peticion) => {
  const url = new URL(peticion.url ?? '/', 'http://localhost');
  const cuenta = cuentaPorToken(url.searchParams.get('token') ?? '');

  if (!cuenta) {
    socket.close(4401, 'sesión inválida');
    return;
  }

  const primeraVentana = !enLinea(cuenta.usuario);
  conectar(cuenta.usuario, socket);
  if (primeraVentana) avisarPresencia(cuenta, true);

  socket.on('message', (datos) => {
    let evento: Record<string, unknown>;
    try {
      evento = JSON.parse(datos.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (evento.tipo === 'enviar') {
      const destinatario = cuentaPorUsuario(texto(evento.para));
      if (!destinatario || !estaEnContactos(cuenta.id, destinatario.id)) {
        enviarA(cuenta.usuario, { tipo: 'error', motivo: 'No tienes ese contacto' });
        return;
      }

      // Si te bloqueó, el mensaje se descarta sin avisar.
      if (bloqueadoPor(destinatario.id, cuenta.id)) return;

      const contenido = texto(evento.texto).trim().slice(0, LARGO_MAXIMO_TEXTO);
      if (!contenido) return;

      const mensaje = { de: cuenta.usuario, texto: contenido, hora: Date.now() };
      guardar(cuenta.usuario, destinatario.usuario, mensaje);
      enviarA(destinatario.usuario, { tipo: 'mensaje', ...mensaje });
      return;
    }

    if (evento.tipo === 'historial') {
      const con = texto(evento.con);
      enviarA(cuenta.usuario, {
        tipo: 'historial',
        con,
        mensajes: recientes(cuenta.usuario, con),
      });
    }
  });

  socket.on('close', () => {
    if (desconectar(cuenta.usuario, socket)) avisarPresencia(cuenta, false);
  });
});

server.listen(PORT, () => {
  console.log(`cartoony-chat escuchando en :${PORT}`);
});
