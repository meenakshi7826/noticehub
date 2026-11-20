# NoticeHub

NoticeHub is a lightweight campus notice portal built with plain HTML, CSS, and JavaScript, an Express API, and MongoDB. Students can browse, search, filter, and sort notices without signing in. The admin can create, edit, and delete notices and attach an optional public PDF link.

## Requirements

- Node.js 20 or newer
- A MongoDB database (MongoDB Atlas free tier works)

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `MONGODB_URI`, `JWT_SECRET`, `ADMIN_USERNAME`, and the frontend URL.
3. Generate an admin password hash with `npm run hash-password`, then set the printed bcrypt hash as `ADMIN_PASSWORD_HASH` in `.env`.
4. Configure `ADMIN_EMAIL` plus the SMTP host, port, username, and password for the mailbox or transactional email service that will deliver reset links.
5. Start the server with `npm run dev` (or `npm start`).
6. Open `http://localhost:3000`.

Use a unique, random `JWT_SECRET` of at least 32 characters. The admin account is created on first startup only; changing `ADMIN_PASSWORD_HASH` later does not overwrite the live password. Use the email recovery flow to rotate the password. Password input in the hash utility is not echoed, the plaintext admin password is never stored in MongoDB, and bcrypt passwords must be at least 12 characters and no more than 72 UTF-8 bytes.

## Data and deployment notes

The app uses exactly two MongoDB collections: `admins` (`username`, bcrypt-hashed `password`, `sessionVersion`, and temporary hashed recovery-token metadata) and `notices` (`title`, `description`, `category`, optional `fileUrl`, optional `postedBy`, and `createdAt`). The supported categories are Notice, Event, Exam, Result, and Download. PDFs are linked from a public HTTP(S) URL rather than uploaded, so the app does not need a file-storage collection or upload service.

The public feed supports case-insensitive search across notice titles and descriptions, category filtering, newest-first or oldest-first sorting, and manual refresh. `Ctrl+K` (or `⌘+K`) focuses the search field. The `notices` collection has a category/date index to support feed filtering and ordering.

For local development, the Express server serves both the frontend and API at `http://localhost:3000`.

## Deploy with GitHub Pages, Render, and Atlas

The GitHub Actions workflow in `.github/workflows/pages.yml` publishes only the `public` directory to GitHub Pages when changes are pushed to `main`. It uses the repository variable `NOTICEHUB_API_URL` when set, or defaults to `https://noticehub-api.onrender.com`, and injects that API origin into the frontend at deploy time. Do not commit credentials into the source.

1. **Prepare MongoDB Atlas.** Create a production database user with a strong, unique password and copy the connection URI. Replace its database name and URL-encode any special characters in the username or password. Restrict Network Access to the outbound IP ranges for your Render service when possible; avoid opening the database to all IPs unless you understand and accept that exposure.
2. **Deploy the API to Render.** Create a Web Service from this repository, with the repository root as the root directory, `npm install` as the build command, `npm start` as the start command, and `/api/health` as the health check path. Choose an always-on plan if you need to avoid cold starts. Set these environment variables in Render's dashboard:
   - `NODE_ENV=production`
   - `MONGODB_URI` — the Atlas connection URI
   - `JWT_SECRET` — a unique random value of at least 32 characters
   - `ADMIN_USERNAME` — the staff sign-in username
   - `ADMIN_PASSWORD_HASH` — generate locally with `npm run hash-password`; never use a plaintext password here
   - `ADMIN_EMAIL` — the admin mailbox for password recovery
   - `FRONTEND_URL` — the full GitHub Pages home URL, including the repository path, e.g. `https://OWNER.github.io/REPOSITORY/`
   - `FRONTEND_ORIGINS` — the frontend origin only, e.g. `https://OWNER.github.io` (no path or trailing slash)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` — credentials for a transactional email provider; use `SMTP_PORT=587` and `SMTP_SECURE=false` for STARTTLS, unless your provider specifies otherwise
   - `SMTP_SECURE=false` for port 587, or `true` when your provider requires implicit TLS

   Render supplies `PORT` automatically. The API health check returns success only while MongoDB is connected. Confirm `https://YOUR-RENDER-SERVICE.onrender.com/api/health` reports `{"status":"ok"}` after deployment.
3. **Configure GitHub Pages.** In the repository's Settings → Pages, select **GitHub Actions** as the build and deployment source. The workflow defaults to `https://noticehub-api.onrender.com`; for another Render service, set the repository variable `NOTICEHUB_API_URL` to that service's HTTPS origin (no path). Push to `main` or run the workflow manually. For repositories whose default branch is not `main`, update the workflow branch filter before pushing.
4. **Verify the live site.** Open the GitHub Pages URL, confirm the public feed loads, then sign in through **Post a notice** and test creating, editing, and deleting a test notice. Also check password recovery using the configured admin mailbox. Remove test content afterward.

For a GitHub Pages custom domain, use that complete URL (including any path) for `FRONTEND_URL`, and only its origin for `FRONTEND_ORIGINS`. Never put MongoDB, JWT, admin password, or SMTP values in GitHub Pages variables, the frontend, or committed files. Keep those values only in Render's secret environment settings.

Forgot-password requests return the same response whether or not the submitted address matches the admin email. Valid requests receive a random, single-use reset token that expires after 30 minutes; only its SHA-256 hash and expiry are stored on the existing admin document. Requests and token submissions are rate limited. A password reset increments the admin session version, invalidating all outstanding JWTs; JWTs expire after one hour, are restricted to HS256, and are checked against the current admin record on every protected request. Logout also revokes outstanding sessions. Keep `.env` and SMTP credentials out of version control.
