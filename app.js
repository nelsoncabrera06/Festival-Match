/**
 * Festival Match - Entry point
 *
 * Este es el archivo que Vercel detecta como serverless function, asi que tiene
 * que cumplir el contrato de Express que Vercel exige (ver la doc de Express:
 * "Exporting the Express application"). Los dos requisitos que importan:
 *
 *   1. El archivo TIENE QUE IMPORTAR `express` y crear la app con `express()`.
 *   2. La app tiene que ser el default export del modulo (`module.exports = app`
 *      en CommonJS). La alternativa que acepta Vercel es un port listener.
 *
 * Por que falla si no se cumple: la deteccion de Vercel es estatica, mira este
 * archivo. Antes era `module.exports = require('./server/server')`, que
 * tecnicamente exportaba una app de Express (la de server/server.js) pero no
 * importaba `express` ni creaba ninguna app aqui, asi que Vercel no armaba la
 * funcion: el deploy quedaba como sitio estatico puro y toda la API daba 404
 * (`x-vercel-error: NOT_FOUND`). Por eso la app se crea ACA y las rutas viven
 * en server/server.js, que se las enganchamos con registerServer(app).
 *
 * En produccion Vercel sirve ademas el contenido de public/ como estatico por
 * CDN, y las rutas /api/*, /auth/* y /health llegan a esta funcion.
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const { registerServer, initServices, PORT } = require('./server/server');

const app = express();

// Middlewares globales. El orden importa: cors antes de responder cualquier
// cosa, express.json para los bodies de POST/PUT, cookieParser para la
// cookie de sesion que leen los middlewares de auth.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Solo sirve en dev local: en Vercel `express.static()` se ignora y los estaticos
// los sirve el CDN desde public/. Este no molesta en produccion, pero es lo que
// hace que `npm start` funcione sin depender del CDN.
app.use(express.static(path.join(__dirname, 'public')));

// Todas las rutas: /auth/*, /api/*, /health y el catch-all de la SPA.
registerServer(app);

// Solo abrimos un puerto cuando este archivo se ejecuta directamente
// (`node app.js`, o `npm start` / `npm run dev`). En Vercel las requests entran
// por el handler de la funcion y abrir un puerto ahi no corresponde.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
  // DB y año actual van despues de escuchar: si initServices() falla (no hay
  // DATABASE_URL, por ejemplo) el server ya esta arriba y solo se cae lo que
  // necesita base. initServices() captura sus propios errores.
  initServices();
}

module.exports = app;
