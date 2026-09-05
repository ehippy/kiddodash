# KiddoDash

A self-hosted household chore chart for kids and families. Kids complete chores on a weekly chart, earn points, and work toward redeemable rewards.

## Features

- **Weekly chore chart** — daily, weekly (day-of-week), and "each kid, daily" (personal) chores
- **Kid picker** — tap a cell to credit the chore to a kid; kids who already did a chore that day are hidden
- **Points & rewards** — kids earn points from chores and spend their balance on a rewards menu; redemptions are recorded and the balance (earned − spent) drives the goal progress and 🏆 flag
- **Light/dark theme** — follows system preference, with a manual toggle
- **Zero external services** — Node.js + Express + built-in SQLite (`node:sqlite`), no build step

## Quick start

```sh
npm start
# KiddoDash chore chart running on http://localhost:3000
```

Requires Node.js 22+ (uses the built-in `node:sqlite` module).

### Docker

```sh
# Production
docker compose up -d --build

# Development (hot reload on :8322, shared data volume; reuses the app image)
docker compose --profile dev up -d
```

Production serves on port **8321**; the dev container on **8322**. Data (SQLite DB + settings) lives in the `kiddodash_data` volume, so code updates never wipe your data.

To go from dev back to production:

```sh
docker compose stop app-dev
docker compose up -d --build app
```

## Configuration

| Env var     | Default   | Description                    |
| ----------- | --------- | ------------------------------ |
| `PORT`      | `3000`    | Listen port                    |
| `DATA_DIR`  | `./data`  | Where the DB and settings live |

- `kiddodash.db` — kids, chores, completions (SQLite, WAL mode)
- `settings.json` — points per completion, goal points, rewards

## API (summary)

| Method & path             | Description                                  |
| ------------------------- | -------------------------------------------- |
| `GET /api/health`         | Health check                                 |
| `GET/POST /api/kids`      | List (with point totals) / add kids          |
| `PUT/DELETE /api/kids/:id`| Update / remove a kid                        |
| `GET/POST /api/chores`    | List (with done-today counts) / add chores   |
| `PUT/DELETE /api/chores/:id` | Update / remove a chore                   |
| `GET/POST /api/completions` | Completions for a date / mark done         |
| `DELETE /api/completions/:id` | Undo a completion                        |
| `GET /api/week?offset=N`  | Week grid for the chart (±26 weeks)          |
| `GET /api/totals`         | Per-kid earned / spent / balance vs. goal    |
| `POST /api/redeem`        | Spend a kid's points on a reward (400 if balance too low) |
| `GET /api/redeemptions`   | Recent reward redemptions                    |
| `GET/PUT /api/settings`   | Points, goal, rewards                        |
