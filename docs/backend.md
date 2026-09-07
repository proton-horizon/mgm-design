# Backend and publication contract

Read this when changing authentication, Cloudflare bindings, publishing, or preview delivery. The Worker entry is `worker/index.ts`; `D1Store` implements the persistence interface. D1 and private R2 are installation-specific. The Worker never builds uploaded source.

## Required bindings and routing

Provide `DB` (D1), `MOCKS` (private R2), `ASSETS` (built viewer assets), `SETUP_SECRET` (secret), and optional `SITE_NAME` and `BUILD_COMMIT` strings. Apply `migrations/0001_initial.sql` before the first request. Route `/api/*` and `/mocks/*` through the Worker before static assets; running the Worker first for every request also applies the shell security headers. Never expose the R2 bucket publicly.

A daily scheduled event removes expired sessions, preview grants, and rate-limit entries, plus inactive publication files older than 24 hours. It processes at most 100 obsolete attempts per run. Active files and publication metadata remain. Back up D1 and R2 before changing a deployed schema. Do not replace an installation's bindings during a framework update.

Cloudflare currently allows 1,000 internal-service subrequests per Free invocation, so the 300-file upload limit alone does not require a Paid plan. Free has a 10 ms CPU limit, however; password derivation and large buffered uploads must be measured on the target installation. Paid permits a larger CPU budget. These are distinct limits; consult [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/) when sizing an installation.

## Authentication

Accounts use email/password, reflecting the UI build requirements. Roles are `admin` and `viewer`; each enabled account can view the entire installation. There are no email deliveries. Passwords require 12–256 characters and use salted PBKDF2-SHA256 with 600,000 iterations, following [OWASP's PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). `worker/passwords.ts` prefers native WebCrypto; when the platform returns `NotSupportedError`, it uses [@noble/hashes](https://github.com/paulmillr/noble-hashes) to compute identical standard PBKDF2 output at the same work factor. Local workerd and deployed Workers can have different native iteration limits, so a successful local login does not establish deployed compatibility or CPU headroom. Other native errors propagate; there is no weaker fallback. Password hashes include their algorithm parameters; the initial development build's 100,000-iteration hashes remain readable and password resets use 600,000. Login is rate-limited to 30 attempts per IP and 10 attempts per email/IP pair per 15 minutes; setup allows 10 per IP. A Cloudflare edge rate-limit can provide additional protection.

Sessions contain 256 random bits and only their SHA-256 hashes are stored. Cookies are `HttpOnly; SameSite=Strict`, with `Secure` on HTTPS and a seven-day expiry. The server checks account enablement and session expiry on every protected request. Editing an account invalidates all of its sessions and preview grants. Every browser state-changing API requires an exact same-origin `Origin` header. Publishing uses a separate project bearer credential and does not accept account cookies as authorization.

`POST /api/setup` atomically records a permanent bootstrap marker and creates the first admin. It requires `{email,password,name,setupSecret}`. The marker closes setup even if accounts later change. Keep the deployment setup secret configured for repeatable deployments; it is inert once the permanent marker exists. Bootstrap and login return an account and set the session cookie. `POST /api/login` accepts `{email,password}`. `POST /api/logout` clears the session and its grants.

For owner lockout recovery, use the installation's privileged D1 access to re-enable a known admin or promote an existing account whose password the owner knows, then sign in and reset the intended account through the admin UI. For example, bind a verified account id to `UPDATE users SET disabled=0, role='admin' WHERE id=?`. This preserves the bootstrap marker. If every password is lost, restore an owner-controlled D1 backup or generate a password hash with the same documented algorithm and update the verified account through privileged D1 access; never remove the bootstrap marker to reopen public setup. Revoke that account's existing sessions with `DELETE FROM sessions WHERE user_id=?` and rotate the recovery password after signing in.

## Browser API

All responses use JSON and `Cache-Control: no-store`. Errors are `{error:string}` with an appropriate 4xx/5xx status. API responses do not enable CORS.

| Method and path                      | Behavior                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/session`                   | `{user: {id,email,name,role} \| null, setupRequired, siteName, buildCommit}`                                                                                                                                                                       |
| `GET /api/projects`                  | Signed-in accounts receive `{projects:[...]}`; each project contains `id`, `name`, `description`, `boards`, latest-attempt `publication`, `activePublication`, and `previewExpiresAt`. Each frame's `entry` is replaced with a scoped preview URL. |
| `GET /api/admin/users`               | Admin-only `{users:[{id,email,name,role,disabled,createdAt}]}`. `disabled` is 0 or 1.                                                                                                                                                              |
| `POST /api/admin/users`              | Admin-only `{email,password,name,role}` creates an account. Returns `{user}`.                                                                                                                                                                      |
| `PATCH /api/admin/users/:id`         | Admin-only `{name?,role?,disabled?:boolean,password?}` edits an account and revokes its sessions. An admin cannot disable or demote their own account. The database guards the last enabled admin against concurrent changes.                      |
| `POST /api/admin/projects`           | Admin-only `{id,name,description?}` registers a project and returns `{project,token}`. Show the publishing token once.                                                                                                                             |
| `POST /api/admin/projects/:id/token` | Admin-only, immediately replaces the publishing credential and returns `{token}`. Previously published mocks remain.                                                                                                                               |

## Bundle schema 1

The source repository owns `design/manifest.json` and every published file. The publisher reads only the explicit `files` whitelist. Do not list secrets, editable Blender masters, briefs, source-only files, or build inputs. Keep required third-party notices in the bundle.

```json
{
  "schemaVersion": 1,
  "project": { "id": "rubber-ducky", "name": "Rubber Ducky" },
  "boards": [
    {
      "id": "app",
      "name": "App",
      "frames": [
        {
          "id": "home",
          "name": "Home",
          "entry": "app/home.html",
          "width": 390,
          "height": 844,
          "x": 0,
          "y": 0
        }
      ]
    }
  ],
  "files": ["app/home.html", "app/styles.css", "app/main.js", "assets/duck.glb"]
}
```

A **project** is registered on the installation. A **board** is a named canvas within it, such as App or Wardrobe. A **frame** is one independently loaded HTML screen with its own viewport. Array order defines sidebar/frame order. Coordinates are optional canvas positions, not CSS offsets inside a document. IDs use lowercase ASCII letters, numbers, underscores, and hyphens, begin with a letter or number, and have at most 64 characters. Board and frame names have at most 100 characters. Optional board descriptions have at most 1,000 characters. Frame IDs are unique within each board; board IDs are unique within the project.

Limits: 50 boards, 200 frames, 300 files, 20 MiB of decoded files, and a 29 MiB JSON upload body. Frame dimensions are integer CSS pixels from 100 to 4096; coordinates are finite values between -100000 and 100000. Files use case-sensitive, relative ASCII paths up to 240 characters, with no empty, dot, hidden, or parent segments. Use the exact listed paths. The local publisher rejects file paths resolving outside `design/`, including escaping symlinks.

Permitted extensions and authoritative MIME types live in `worker/bundle.mjs`. They include HTML/CSS/JS modules, JSON, common images, fonts, GLB/glTF, binary data, WASM, audio/video, and text notices. Extension acceptance does not prove a runtime capability; compression workers and WASM compilation are currently blocked by the preview CSP and are not supported. Every frame entry must be a listed `.html` file. Files are base64-encoded only for upload and stored as their original bytes.

The publication replaces the entire set. To intentionally clear a project, send `empty: true`, `boards: []`, and `files: []`. Missing manifests or an accidentally empty boards list fail validation. Schema mismatches and unrecognized manifest/project/board/frame properties fail before activation. The maintained validator is shared by Worker and publisher.

## Publisher and API

Run the checked-out MGM Design script with Node 22 or newer from the source repository:

```sh
MGM_SITE_URL=https://design.example.com MGM_PROJECT_ID=rubber-ducky \
  node /path/to/mgm-design/scripts/publish.mjs
```

Supply `MGM_PUBLISH_TOKEN` through the repository's existing secret mechanism. `--site`, `--project`, and `--directory` override their nonsecret defaults. Map existing secret names into the publisher environment; do not relocate secrets to fit these example names. Use separate jobs or independent outcomes for separate sites and keep mock publication independent from production application deployment. The script registers an attempt before reading/validating its bundle, reports failures when possible, and exits nonzero on failure. Source compilation/export must happen before invoking this bundled-file publisher; a workflow that needs build failures on the site's status should register the attempt through the API before its build and report completion/failure itself.

Every publishing request uses `Authorization: Bearer <project token>`. Tokens contain 256 random bits, are hashed in D1, and can modify only the registered project's publication content and status.

1. `POST /api/publish/:projectId/attempts` accepts `{id?,sequence?,commit?,ref?,runUrl?}` and returns `{attemptId}`. Caller-supplied ids make registration idempotent. `runUrl`, when provided, must be a direct HTTPS `github.com/.../actions/runs/...` URL. Register before preparing a bundle if preparation failures should be visible.
2. `PUT /api/publish/:projectId/attempts/:attemptId` accepts `{manifest,files:{"path":"base64"}}`. Validation happens before writing. One uploader claims the attempt, writes its private immutable prefix, and atomically changes the active pointer only if it is still the newest attempt.
3. `POST /api/publish/:projectId/attempts/:attemptId/failure` marks an unfinished attempt failed. The server deliberately stores a generic message and source workflow link rather than caller-supplied logs, which may contain secrets.

An already published upload is idempotently acknowledged; it never rewrites its immutable files. An interrupted or concurrent upload requires a new attempt. Failed, superseded, or incomplete uploads preserve the active publication. New attempts use an increasing site-assigned sequence by default. For workflows that may register out of source order, supply a positive, unique, monotonically increasing source `sequence` (or `MGM_PUBLISH_SEQUENCE` for the script) under one consistent project-wide ordering convention. Do not mix unrelated counters or reuse a sequence for a new attempt. A stale sequence can register but cannot activate. Concurrent registration with the same sequence is rejected by the database.

The latest attempted record is separate from the active successful record. Status is `pending`, `uploading`, `published`, `failed`, `superseded`, or `unknown`. Unfinished attempts without an update for 30 minutes display as unknown, not failed. If the site never receives the attempt or cannot receive the failure report, the source GitHub Actions result is the fallback. Browser rendering errors are not publication failures.

## Preview isolation

The projects API creates one-hour, 256-bit random preview grants for each active immutable publication. A grant is tied to the requesting session and only that project/publication. URL shape is `/mocks/<grant>/<relative-file>`. Relative imports/assets therefore remain within the same snapshot across publication changes. The iframe must use `sandbox="allow-scripts"`, without `allow-same-origin`. Every resource response also enforces a `Content-Security-Policy: sandbox allow-scripts` header, including directly navigated HTML/SVG.

Grant URLs are short-lived bearer capabilities: anyone possessing one can replay that publication's URLs until expiry or session revocation. They are not upload tokens. Do not log or send them to analytics. Responses use `no-store`, `Referrer-Policy: no-referrer`, and CORS `*` without credential permission. The grant authorizes a request, never `Origin: null` or an ambient cookie. Grant lookups check session/account status on every resource. Logout, account reset, disablement, and session expiry revoke access immediately. Refresh the projects API before grants expire to get new iframe URLs.

Mock CSP allows inline scripts/styles and resources under the exact grant prefix, images via data/blob URLs, and blob URLs for model loading. It blocks frames, forms, plugins, workers, arbitrary external networks, and privileged app storage/origin access. Bundles must contain their compatible renderer, loader, fonts, models, textures and modules and use relative resource URLs. There is no host-side runtime dependency installation.

Transport/security integration tests exercise real D1/R2 in workerd. Browser-specific ES module, font, WebGL texture/GLB, and direct-navigation behavior still requires the browser validation recorded in issue #2. Do not infer general Three.js, decoder, Safari, or mobile support solely from successful uploads.
