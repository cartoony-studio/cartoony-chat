import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, servicio: 'cartoony-chat' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'no encontrado' }));
});

// Aquí va el upgrade a WebSocket del chat.

server.listen(PORT, () => {
  console.log(`cartoony-chat escuchando en :${PORT}`);
});
