# Bitbase — community activity tracker

A real, self-hosted backend for Bitbase: a Node.js/Express server that stores
every account and every day's activity in plain **CSV files** on disk (plus a
small `settings.json`). No external database to set up — the files are
readable in Excel/Sheets and easy to back up by copying the `data/` folder.

The frontend is the same Bitbase UI you've already seen (Cloudy Sky Blue
theme, roles, leaderboard, CSV imports) — it now talks to this server over a
real API instead of your browser's local storage, so everyone sees the same
live data, on any device.

## What's in here

```
bitbase-server/
  server.js          the whole backend (Express + CSV storage)
  package.json
  public/            the frontend (served by the same server)
    index.html
    styles.css
    app.js
  data/              created automatically on first run — your real data
    users.csv
    daily_activity.csv
    audit_logs.csv
    payouts.csv
    settings.json
```

## Assigned targets, color status, and Premium payouts

- Every member has an **assigned target %** (10–100), set when they're added
  or edited by an admin/mod. Their daily activity is compared against it:
  - 🟢 green — at or above their target
  - 🟠 orange — below target, but within 15 points of it
  - 🔴 red — more than 15 points below target

  (That 15-point cutoff is a constant, `ORANGE_BAND`, near the top of
  `public/app.js` if you want it tighter or looser.)
- Whoever tops the **weekly leaderboard** (most days finishing #1) is
  eligible for a **Premium award**, given manually by an admin from the
  Leaderboard page. The server enforces a **30-day cooldown per member** —
  someone who already won Premium can't win it again for a month, though an
  admin can explicitly override that if needed.
- **Payouts** (amount, monetized or non-monetary, a note) are tracked in
  `payouts.csv`. The dashboard shows the community's total payout, your own
  total and recent payouts, and the last Premium winner; each member's
  detail page and profile shows their own payout history.
- **All Community Members** — a simple directory (name, username, X link)
  for every active member, visible to everyone, shown under the Leaderboard.

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd bitbase-server
npm install
npm start
```

Then open **http://localhost:3000** in your browser. The very first time,
you'll land on a **Setup** screen — that's where you name your community and
create your one real Admin account (no demo accounts exist). From there, log
in as Admin to add moderators and members, either one at a time or in bulk
via CSV (Members tab and Daily Activity tab under **Imports**).

Your data lives in `data/` next to `server.js`. Stop the server
(`Ctrl+C`), restart it, and everything is still there — nothing resets.

To reset completely and go back to Setup: stop the server, delete the
`data/` folder, and start it again.

## Deploying it for real (so it's reachable from anywhere)

This is a normal Node.js web app, so any Node host works — but since the
"database" here is CSV files on disk, **the host has to give you a real,
persistent disk**, not just ephemeral storage that resets on every restart.
That rules out most free tiers.

### Recommended — Render.com, Starter plan + a small persistent Disk (~$7.25/mo)

This is the one to use if you want something simple and predictably priced.
Render's **free** web service tier explicitly cannot attach a disk (your CSVs
would vanish on every restart), so this needs the paid **Starter** tier
(~$7/month, flat) plus a Disk (~$0.25/GB/month — 1GB is plenty for a long
time). Unlike usage-metered hosts, this bill doesn't move around.

1. Push this folder to a GitHub repo (Render deploys from Git).
2. On [render.com](https://render.com): **New → Web Service**, connect that repo.
3. Root directory: leave blank (this folder *is* the app root).
   Build command: `npm install`. Start command: `npm start`.
4. Pick the **Starter** instance type (the Free type can't attach a Disk).
5. Before deploying, go to the **Disks** tab and add one:
   - Name: `bitbase-data`
   - Mount path: `/var/data` (any path works — just remember it)
   - Size: 1 GB is plenty to start
6. Go to **Environment** and add a variable: `DATA_DIR` = `/var/data`
   (matching the mount path from step 5 — this is what makes the app write
   your CSVs onto the persistent disk instead of the app's own ephemeral copy).
7. Deploy. Render gives you a public `https://your-app.onrender.com` URL —
   open it, and you should land on the Setup screen to create your Admin account.
8. Restart or redeploy the service anytime — your `users.csv`, `daily_activity.csv`,
   `payouts.csv`, and `audit_logs.csv` all live on the Disk and survive it.

### Alternative — Railway.app or Fly.io (persistent Volumes)

Same idea: connect the repo, start command `npm start`, attach a **Volume**
at a mount path, set `DATA_DIR` to that same path. Railway's Hobby plan is
$5/month including $5 of usage, but it bills per-second for CPU/RAM/storage
on top — fine for a small app like this, but the bill can move around more
than Render's flat Starter price, so budget a little headroom.

### Alternative — Your own VPS (DigitalOcean, Linode, a home server, etc.) — most control, cheapest long-term
```bash
# on the server, one-time setup
sudo apt update && sudo apt install -y nodejs npm
git clone <your-repo-url> bitbase-server
cd bitbase-server
npm install --production

# keep it running permanently
sudo npm install -g pm2
pm2 start server.js --name bitbase
pm2 save
pm2 startup   # follow its printed instructions so it survives a reboot
```
No `DATA_DIR` needed here — a VPS's whole disk is already persistent, so the
default `./data` folder next to `server.js` is fine as-is.

Then put a reverse proxy (Nginx or Caddy) in front of it for a real domain
and HTTPS. A minimal Nginx site:
```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```
Caddy is even simpler — a `Caddyfile` with just:
```
your-domain.com {
    reverse_proxy localhost:3000
}
```
gives you free automatic HTTPS.

### Whichever option you pick
- Since the whole "database" is the `data/` folder, **back it up** regularly
  (it's just files — copy them anywhere).
- Set the `PORT` environment variable if your host requires a specific port
  (the server already reads `process.env.PORT`).
- The session cookie is `httpOnly` and `sameSite: lax`; if you serve over
  HTTPS in production, it's worth adding `secure: true` to `COOKIE_OPTS` in
  `server.js` so the cookie is never sent over plain HTTP.

## Security notes

- Passwords are hashed with bcrypt before they're ever written to
  `users.csv` — the plaintext password is never stored anywhere.
- Every write endpoint re-checks the logged-in user's role and permissions
  **on the server**, not just in the UI — a moderator cannot edit another
  moderator's members even by calling the API directly.
- Sessions are random tokens kept in server memory; restarting the server
  logs everyone out (accounts and data are unaffected — only sessions reset).

## If something goes wrong

- **"Could not reach the server"** in the browser: the Node process isn't
  running, or you're pointed at the wrong URL/port.
- **Forgot the admin password:** open `data/users.csv` in a spreadsheet,
  delete the admin's row (or the whole file to start over from Setup), and
  restart the server. There's intentionally no "reset password" flow yet —
  add one if you need it, or edit the CSV by hand for now.
