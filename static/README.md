# Hostel Desk: static demo (no server)

This folder is a complete Hostel Desk that runs only in the browser, so it can be
hosted for free on GitHub Pages. The Java + Oracle version in the folder above
is unchanged.

**How it works**

- `sql-wasm.js` and `sql-wasm.wasm` are [sql.js](https://sql.js.org) (SQLite
  compiled to WebAssembly), copied from `node_modules/sql.js/dist/`. Nothing
  is loaded from a CDN.
- `schema.sql` is the SQLite version of `../hostel_schema.sql`: the same tables,
  constraints and sample data.
- `api.js` does the work of `HostelServer.java`. Every `/api/...` route is
  reimplemented in JavaScript on top of sql.js and returns the same JSON. The
  `api()` function in `core.js` calls `HostelAPI.request()` instead of `fetch()`.
  The other pages are the same files as `../web/`.
- The database is saved to the browser's IndexedDB after every change. If the
  browser blocks storage (some private modes do), the site still works, but
  only until the tab is closed.
- The account menu has **Download database (.db)**, **Export SQL** and
  **Reset to sample data**. Reset is for admins only; the login screen also
  has a reset link in case the password is forgotten.

The first login is `admin` / `admin123`. The data lives in each visitor's own
browser: nobody else sees your changes, and clearing site data deletes them.

## Publish on GitHub Pages

The workflow `.github/workflows/pages.yml` publishes this folder every time
something in `static/` changes on `main`.

1. Push the repository to GitHub, including `static/` and `.github/workflows/pages.yml`.
2. On GitHub, open the repository's **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Open the **Actions** tab. Run **Deploy static site to GitHub Pages**
   (**Run workflow**), or push any change to `static/`.
5. When it finishes, the site is at `https://<your-user>.github.io/<repo-name>/`.
   The link is also shown in the workflow run and in Settings → Pages.

Pages for private repositories need a paid GitHub plan. On a free account,
make the repository public.

## Run it on your own computer

The page must be served over `http://localhost` (or https). Browsers block
WebAssembly and password hashing on `file://`. From the repository root:

```
npm install
node tests/serve.js static 8000
```

Then open <http://localhost:8000>. Any static server works (`python -m http.server`
inside `static/` too). Use `localhost`, not a LAN IP over plain http, because
Web Crypto needs a secure context.

## Tests

```
npm install
npx playwright install chromium
npm test                       # end-to-end test of this folder in Chromium
node tests/compare-java.js     # compare with the Java server (needs it running on :8099)
```

`compare-java.js` copies the current Oracle rows (read-only) into a SQLite file,
loads it into the browser, and sends the same ~540 GET and rejected-write
requests to both servers to check that the JSON is identical.

## Updating sql.js

```
npm install sql.js@latest
npm run copy-sqljs
```

## Differences from the Java + Oracle version

- **Login is cosmetic.** Passwords are still hashed (PBKDF2-SHA256, 65,536
  rounds, the same as the Java server, using Web Crypto). But anyone can open
  the browser's developer tools and edit the database, so do not use this
  build for real data. A sign-in lasts for the browser tab (sessionStorage,
  2-hour idle timeout) instead of a server cookie.
- **One database per browser.** There is no shared server, so two people or
  two browsers never see each other's changes.
- **Dates use the browser's local time.** Oracle used the database server's
  `SYSDATE`.
- **SQLite instead of Oracle.** Sequences become `AUTOINCREMENT`, `LISTAGG`
  becomes `group_concat`, and `ROWNUM` paging becomes `LIMIT/OFFSET`. Money is
  stored as `REAL` and sums are rounded to 2 decimals. `UPPER()` only folds
  ASCII letters, so searches on non-English letters can be case-sensitive.
- **Audit details** print decimal amounts without trailing zeros
  (`Amount=3500.5`, where Oracle printed `3500.50`).
