# Festival Match

**Match your music taste against real festival lineups.**

Live: https://festivalmatch.vercel.app/ · Español: [README_es.md](README_es.md)

Add the artists you actually listen to. Festival Match compares your list against
the lineup of every festival in its catalogue and scores each one — so instead of
"what's on in Europe this summer" you get "which of these festivals is actually
about you".

## What it does

- **Match score** — the share of your artists that appear in each lineup, ranked best first.
- **58 festivals, 648 artists** across Europe, the USA and Latin America. Lineups are flagged
  as *confirmed*, *partial* or *unannounced*, so you know how much to trust a score.
- **Three ways to build your library** — search by hand, via [MusicBrainz](https://musicbrainz.org),
  or import your top artists from [Last.fm](https://last.fm).
- **Tour dates** — see where an artist is playing.
- **Demo mode** — try the whole flow before creating an account.
- **Three languages** — English, Spanish and Finnish.
- **Admin panel** — users can suggest missing festivals; an admin reviews and approves them
  into the catalogue.

## Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express 4 (CommonJS) |
| Frontend | Vanilla JS + CSS — **no build step, no framework, no bundler** |
| Database | PostgreSQL through `pg` (raw SQL, no ORM) |
| Auth | Google OAuth, bcrypt, cookie sessions |
| Hosting | Vercel (serverless functions) + Supabase |

## Two decisions worth explaining

**The frontend calls relative URLs.** Everything is `fetch('/api/...')`, with no domain
hardcoded anywhere. Because the API and the frontend share the same Vercel domain, there
is no CORS to configure and cookies work without a single line of extra code. Local,
preview and production behave identically.

**No build step.** `public/` is served exactly as it is on disk. The entire client is
~3,000 lines of vanilla JS you can read in one sitting, and there is no toolchain to
install, version or break.

## Run it locally

```bash
npm install
npm start          # http://localhost:8080
```

`DATABASE_URL` is optional. Without it the app still boots and serves everything that
does not need a database — including demo mode and artist search.

## Layout

```
app.js               # Express entrypoint — this is what Vercel deploys
server/server.js     # All routes: auth, API, admin
server/db.js         # Postgres pool, schema, queries
server/auth.js       # Google OAuth
public/              # The entire frontend
```

## Status

Live on Vercel. The PostgreSQL migration to Supabase is in progress, so accounts,
favourites and preferences are not active yet; the rest of the app works.

One honest note: tour dates used to come from Bandsintown, which closed its public API
in 2025. That feature now falls back to a search link instead.

---

Built by [Nelson Cabrera](https://github.com/nelsoncabrera06).
