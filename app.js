/**
 * Festival Match - Entry point para Vercel
 *
 * Vercel detecta una app Express solo si la encuentra y la exporta desde
 * app.js / index.js / server.js en la raíz del repo (o en src/). La app real
 * vive en server/server.js, así que este archivo cumple ese rol y la reexporta.
 *
 * Importar este archivo NO abre ningún puerto: server/server.js solo hace
 * listen cuando se ejecuta directamente (ver `require.main === module`).
 *
 * En producción Vercel sirve además el contenido de public/ como estático por
 * CDN, y las rutas /api/* y /auth/* llegan a esta función.
 */
module.exports = require('./server/server');
