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
- **Fechas de gira** — dónde toca cada artista.
- **Modo demo** — probá todo el flujo antes de crear una cuenta.
- **Tres idiomas** — español, inglés y finlandés.
- **Panel de administración** — los usuarios pueden sugerir los festivales que faltan; un admin
  los revisa y los aprueba al catálogo.

## Stack

| Capa | Elección |
|---|---|
| Backend | Node.js + Express 4 (CommonJS) |
| Frontend | JS y CSS vanilla — **sin build step, sin framework, sin bundler** |
| Base de datos | PostgreSQL con `pg` (SQL crudo, sin ORM) |
| Auth | Google OAuth, bcrypt, sesiones en cookie |
| Hosting | Vercel (serverless functions) + Supabase |

## Dos decisiones que vale la pena explicar

**El frontend llama a URLs relativas.** Todo es `fetch('/api/...')`, sin ningún dominio
hardcodeado. Como la API y el frontend viven en el mismo dominio de Vercel, no hay CORS
que configurar y las cookies funcionan sin una sola línea extra. Local, preview y producción
se comportan igual.

**Sin build step.** `public/` se sirve tal cual está en disco. Todo el cliente son ~3.000
líneas de JS vanilla que se leen de una sentada, y no hay toolchain que instalar, versionar ni romper.

## Correrlo local

```bash
npm install
npm start          # http://localhost:8080
```

`DATABASE_URL` es opcional. Sin base la app igual levanta y sirve todo lo que no necesita
base de datos — incluyendo el modo demo y la búsqueda de artistas.

## Estructura

```
app.js               # Entry point de Express — esto es lo que deploya Vercel
server/server.js     # Todas las rutas: auth, API, admin
server/db.js         # Pool de Postgres, schema, queries
server/auth.js       # Google OAuth
public/              # Todo el frontend
```

## Estado

Vivo en Vercel. La migración de PostgreSQL a Supabase está en curso, así que las cuentas,
los favoritos y las preferencias todavía no están activas; el resto de la app funciona.

Una aclaración honesta: las fechas de recarga venían de Bandsintown, que cerró su API
pública en 2025. Esa función ahora cae a un link de búsqueda.

---

Hecho por [Nelson Cabrera](https://github.com/nelsoncabrera06).
