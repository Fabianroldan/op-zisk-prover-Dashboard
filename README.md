# OP-ZiSK Prover — live proving tracker

A static, real-time dashboard for OP range proving (range proofs → aggregation →
on-chain settlement). Pure HTML/CSS/JS — no backend, no build step.

## Files
- `index.html` — entry point
- `prover.css` — theme + styles
- `prover-data.js` — data layer (mock feed; **websocket-ready**)
- `prover-util.js` — formatters/helpers
- `prover-charts.jsx` — charts (sparkline, timeline, histogram)
- `prover-app.jsx` — app shell + views (Live / Blocks / Block detail)
- `.nojekyll` — tells GitHub Pages to serve files as-is

---

## Deploy to GitHub Pages

### Option A — GitHub website (no terminal)
1. Go to github.com → **New repository** → name it e.g. `op-zisk-prover` → **Create**.
2. On the new repo page, click **uploading an existing file**.
3. Drag in **all the files in this folder** (including `index.html` and `.nojekyll`). Commit.
4. Go to **Settings → Pages**.
5. Under **Build and deployment → Source**, choose **Deploy from a branch**.
6. Set branch to **main** and folder to **/ (root)** → **Save**.
7. Wait ~1 minute. Your site appears at:
   `https://<your-username>.github.io/<repo-name>/`

### Option B — git command line
```bash
cd path/to/this-folder
git init
git add .
git commit -m "OP-ZiSK Prover"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```
Then do steps 4–7 above (Settings → Pages → main / root).

### Option C — auto-deploy with GitHub Actions (recommended)
A workflow is included at `.github/workflows/deploy.yml`. It rebuilds and
publishes the site on every push to `main`.
1. Push this folder to a repo (Option B steps, or the web upload in Option A).
2. Go to **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions** (not "Deploy from a branch").
3. That's it — every push to `main` auto-deploys. Watch progress under the
   repo's **Actions** tab; the live URL shows in the workflow summary.

---

## Notes
- **Needs internet:** React, Babel, and fonts load from CDNs. (Ask for a single
  self-contained `index.html` if you want a fully offline build.)
- **The data is a live simulation.** To show real data, replace the simulator in
  `prover-data.js` with your stream — the UI only depends on the snapshot shape:
  ```js
  const ws = new WebSocket("wss://your-prover/stream");
  ws.onmessage = (e) => proverFeed.ingest(JSON.parse(e.data));
  // (and don't call proverFeed.startSimulation())
  ```
- Routing is hash-based (`#/`, `#/blocks`, `#/block/JOB-xxxx`), so it works on
  GitHub Pages with no server config and survives refresh.
