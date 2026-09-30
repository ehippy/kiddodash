# Working on KiddoDash

Notes for coding agents (Claude Code, Codex, etc.) working in this repo.

## Workflow

- **Commit as you go.** Once a change is done and `npm test` passes, commit it on `main` with a descriptive message. Don't ask first.
- **Push after committing.** `git push` to `origin` once the commit is in. No need to ask.
- **Keep the live app current.** The family uses the production container every day. After pushing a change that affects the app, redeploy it:

  ```sh
  docker compose up -d --build app
  ```

  Then check it came back up, e.g. `curl -s -o /dev/null -w "%{http_code}\n" localhost:8321/`.
- **Report what happened:** the commit hash, whether it was pushed and deployed, and anything that failed or was skipped.

## Project shape

- `server.js`: Express + built-in `node:sqlite` (Node 22+), no build step.
- `public/`: plain HTML/CSS/JS front end. Third-party browser libraries are vendored in `public/vendor/` (no CDN), so the app works offline.
- `test/`: `npm test` runs the suite.

## Live data

- Production runs as the `kiddodash` container on port 8321; data (SQLite DB + `settings.json`) lives in the `kiddodash_data` volume at `/data`.
- Never ask for the parent PIN in chat. To make a data change the user asked for, run a script inside the container: `docker exec -i kiddodash node -`, using `node:sqlite` against `/data/kiddodash.db`.
- To check UI changes against real data, copy `/data` to a temp dir, strip the PINs, run `DATA_DIR=<copy> PORT=3999 node server.js` and look at it there, not on the live app. Afterwards, stop only that server.
