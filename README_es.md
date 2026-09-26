# Festival Match

**Compará tu gusto musical contra los lineups reales de los festivales.**

En vivo: https://festivalmatch.vercel.app/ · English: [README.md](README.md)

Cargá los artistas que realmente escuchás. Festival Match compara tu lista contra el
lineup de cada festival del catálogo y le pone un puntaje a cada uno — así, en lugar de
"qué hay en Europa este verano" obtenés "cuáles de estos 58 festivals es realmente sobre vos".

## Qué hace

- **Puntaje de match** — qué porcentaje de tus artistas aparece en cada lineup, ordenado de mayor a menor.
- **58 festivales, 648 artistas** en Europa, USA y Latinoamérica. Los lineups están marcados
  como *confirmado*, *parcial* o *sin anunciar*, así sabés cuánto confiar en cada puntaje.
- **Tres formas de armar tu biblioteca** — buscando a mano, vía [MusicBrainz](https://musicbrainz.org),
  o importando tus artistas top de [Last.fm](https://last.fm).
- **Fechas de gira** — dónde toca cada artista, como link de búsqueda (ver *Estado*).
- **Modo demo** — probá todo el flujo antes de crear una cuenta.
- **Tres idiomas** — español, inglés y finlandés.
- **Panel de administración** — los usuarios pueden sugerir los festivales que faltan; un admin
  los revisa y los aprueba al catálogo.

## Stack

| Capa | Elección |
|---|---|
| Backend | Node.js + Express 4 (CommonJS) |
| Frontend | JS y CSS vanilla — **sin build step, sin framework, sin bundler** |
| Base de datos | PostgreSQL en Supabase, con `pg` (SQL crudo, sin ORM) |
| Auth | Google OAuth, bcrypt, sesiones en cookie |
| Hosting | Vercel (serverless functions) + Supabase |

## Dos decisiones que vale la pena explicar

**El frontend llama a URLs relativas.** Todo es `fetch('/api/...')`, sin ningún dominio
hardcodeado. Como la API y el frontend viven en el mismo dominio de Vercel, no hay CORS
que configurar y las cookies funcionan sin una sola línea extra. Local, preview y producción
se comportan igual.

**Sin build step.** `public/` se sirve tal cual está en disco. Todo el cliente son ~3.000
líneas de JS vanilla que se leen de una sentada, y no hay toolchain que instalar, versionar ni romper.

**El pool de Postgres está configurado para serverless.** `max: 1`, timeouts explícitos de
conexión e idle, y un `pool.on('error')`. Cada instancia de Vercel atiende requests
concurrentes pero debería tener una sola conexión, porque el pooler de Supabase multiplexa
las reales. El handler de error es el importante: sin listener, un `'error'` del pool es un
throw no capturado que tumba la instancia.

Una trampa que me costó una tarde, por si te ahorra una: la connection string **no** debe
llevar `?sslmode=require`. Con `pg` 8.16 ese parámetro resuelve a `rejectUnauthorized: true`,
y como la string se parsea *después* del objeto de config, pisa el `ssl` del pool — después
toda query falla con *self-signed certificate in certificate chain*. La config de TLS vive
en `server/db.js`, no en la URL.

## Correrlo local

```bash
npm install
npm start          # http://localhost:8080
```

Sin `DATABASE_URL` la app igual levanta y sirve todo lo que no necesita base de datos —
incluyendo el modo demo y la búsqueda de artistas. Para que funcionen las cuentas, apuntala
a cualquier Postgres y aplicá el schema:

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
```

## Estructura

```
app.js               # Entry point de Express — esto es lo que deploya Vercel
server/server.js     # Todas las rutas: auth, API, admin
server/db.js         # Pool de Postgres, queries
server/auth.js       # Google OAuth
migrations/          # Schema, aplicado una vez y no en cada arranque
public/              # Todo el frontend
```

## Estado

Vivo en Vercel, con Supabase como base de datos. Cuentas, favoritos, géneros y bibliotecas
de artistas funcionan.

Dos aclaraciones honestas:

- **Google muestra un cartel de "app no verificada"** antes del botón de login. Es lo que
  le pasa a cualquier app que no pasó por el proceso de verificación de Google, y no vale
  la pena pagarlo en un proyecto así. Clickeá *Advanced → Go to Festival Match* y te deja
  pasar.
- **Las fechas de gira son un link de búsqueda, no datos reales.** Venían de Bandsintown,
  que cerró su API pública en 2025. El endpoint sigue ahí y cae a una búsqueda en vez de
  fingir que tiene datos.

---

Hecho por [Nelson Cabrera](https://github.com/nelsoncabrera06).
