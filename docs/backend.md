# Backend and publication contract

Read this when changing authentication, Cloudflare bindings, publishing, or preview delivery. The Worker entry is `worker/index.ts`; `D1Store` implements the persistence interface. D1 and private R2 are installation-specific. The Worker never builds uploaded source.

## Required bindings and routing

Provide `DB` (D1), `MOCKS` (private R2), `ASSETS` (built viewer assets), `SETUP_SECRET` (secret), and optional `SITE_NAME` and `BUILD_COMMIT` strings. Apply every numbered SQL migration in order before serving the updated Worker. Route `/api/*` and `/mocks/*` through the Worker before static assets; running the Worker first for every request also applies the shell security headers. Never expose the R2 bucket publicly.

A daily scheduled event removes expired account links, sessions, preview grants, and rate-limit entries, plus inactive publication files older than 24 hours. It processes at most 100 obsolete attempts per run. Active files and publication metadata remain. Back up D1 and R2 before changing a deployed schema. Do not replace an installation's bindings during a framework update.

Cloudflare currently allows 1,000 internal-service subrequests per Free invocation, so the 400-file upload limit alone does not require a Paid plan. Free has a 10 ms CPU limit, however; password derivation and large buffered uploads must be measured on the target installation. Paid permits a larger CPU budget. These are distinct limits; consult [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/) when sizing an installation.

## Authentication

Accounts use email/password, reflecting the UI build requirements. Roles are `admin` and `viewer`; each enabled account can view the entire installation. There are no email deliveries. Passwords require 12–256 characters.

`worker/passwords.ts` implements the `PasswordHasher` boundary using native `node:crypto.scrypt` with N=16384, r=8, p=5, a 32-byte result, and a 24 MiB allocation cap. This is [OWASP's listed 16 MiB scrypt profile](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt); deployment requires `nodejs_compat` and verification of actual CPU use under the installation's existing limits.

Each new record has the form `scrypt:16384:8:5:<64 lowercase hex salt>:<64 lowercase hex digest>`. The salt contains 256 random bits; the KDF receives the UTF-8 bytes of its hexadecimal text, not decoded hexadecimal bytes. Passwords are encoded as UTF-8 without Unicode normalization or NUL truncation.

Verification accepts only this exact bounded scrypt profile and the existing `pbkdf2-sha256:100000:...` / `pbkdf2-sha256:600000:...` formats; digest comparison uses native constant-time comparison. Legacy PBKDF2 verification uses native WebCrypto at the stored work factor. A successful legacy verification requests an atomic rehash to scrypt. If the deployed runtime cannot verify that legacy work factor, the stored hash remains unchanged and an admin must reset the account password through the admin screen or the owner recovery procedure below. There is no expensive JavaScript derivation fallback or automatic reduction of a stored work factor. Nonexistent accounts use a current-format dummy verification.

Login is rate-limited to 30 attempts per IP and 10 attempts per email/IP pair per 15 minutes; setup allows 10 per IP. A Cloudflare edge rate-limit can provide additional protection.

Sessions contain 256 random bits and only their SHA-256 hashes are stored. Cookies are `HttpOnly; SameSite=Strict`, with `Secure` on HTTPS and a seven-day expiry. The server checks account enablement and session expiry on every protected request. Editing an account invalidates all of its sessions and preview grants. Every browser state-changing API requires an exact same-origin `Origin` header. Publishing uses a separate project bearer credential and does not accept account cookies as authorization.

`POST /api/setup` atomically records a permanent bootstrap marker and creates the first admin. It requires `{email,password,name,setupSecret}`. The marker closes setup even if accounts later change. Keep the deployment setup secret configured for repeatable deployments; it is inert once the permanent marker exists. Bootstrap and login return an account and set the session cookie. `POST /api/login` accepts `{email,password}`. `POST /api/logout` clears the session and its grants.

Site admins invite people using a seven-day, single-use link and choose `viewer` or `admin`. Invites reserve no account until redemption; issuing another invite for the same email invalidates the old one. Admins can revoke pending invites. Existing accounts keep their credentials and can use password-reset links. Roles apply to every project on the installation.

Account links contain 256 random bits; only SHA-256 hashes are stored in `account_links`. The returned URL puts the token in `#account=…`; the client captures it in memory and removes it from browser history before rendering. It is sent only in same-origin POST bodies, never query strings. Refreshing before redemption loses the in-memory token; reopen the original link. Link inspection does not consume it. Redemption atomically claims the link and sets the password, so concurrent redemption has one winner. Disabled accounts cannot reset passwords. Links issued by disabled or demoted admins are revoked. Never log or persist plaintext links in analytics, documentation, or error reports.

Every signed-in account can change its password using its current password. Admins issue one-hour single-use reset links for enabled accounts, replacing any previous reset link. Issuing a reset link leaves the existing password and sessions working until redemption. Successful password changes and resets revoke all of the target account’s sessions, preview grants, and outstanding reset links; the user signs in again. Editing account permissions or enablement also revokes target sessions and reset links. Link operations allow 30 attempts per IP per 15 minutes; password changes allow 10 per account/IP and admin reset issuance allows 30 per admin/IP in that window. Invalid/expired/revoked/consumed links return the same 410 error. Share links privately with the intended recipient: possession of a link grants the ability to set that account’s password. No email is sent and possession does not verify ownership of the email address.

For owner lockout recovery, use the installation's privileged D1 access to re-enable a known admin or promote an existing account whose password the owner knows, then sign in and reset the intended account through the admin UI. For example, bind a verified account id to `UPDATE users SET disabled=0, role='admin' WHERE id=?`. This preserves the bootstrap marker. If every password is lost, restore an owner-controlled D1 backup or generate a password hash with the same documented algorithm and update the verified account through privileged D1 access; never remove the bootstrap marker to reopen public setup. Revoke that account's reset links with `DELETE FROM account_links WHERE user_id=?` and existing sessions with `DELETE FROM sessions WHERE user_id=?` and rotate the recovery password after signing in.

## Browser API

All responses use JSON and `Cache-Control: no-store`. Errors are `{error:string}` with an appropriate 4xx/5xx status. API responses do not enable CORS.

| Method and path                        | Behavior                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/session`                     | `{user: {id,email,name,role} \| null, setupRequired, siteName, buildCommit}`                                                                                                                                                                                              |
| `GET /api/projects`                    | Signed-in accounts receive `{projects:[...]}`; each project contains `id`, `name`, `description`, `boards`, latest-attempt `publication`, `activePublication`, and `previewExpiresAt`. Each frame's `entry` and optional `preview` are replaced with scoped preview URLs. |
| `GET /api/admin/users`                 | Admin-only `{users:[{id,email,name,role,disabled,createdAt}]}`. `disabled` is 0 or 1.                                                                                                                                                                                     |
| `PATCH /api/admin/users/:id`           | Admin-only `{name?,role?,disabled?:boolean}` edits an account and revokes its sessions. An admin cannot disable or demote their own account. The database guards the last enabled admin against concurrent changes.                                                       |
| `POST /api/admin/invites`              | Admin-only `{email,name,role}` creates/replaces an invite; returns `{url,email,kind,expiresAt}` once. Email must not already have an account.                                                                                                                             |
| `GET /api/admin/invites`               | Admin-only `{invites:[{id,email,name,role,expiresAt}]}`; expiry is Unix milliseconds. No tokens or hashes.                                                                                                                                                                |
| `DELETE /api/admin/invites/:id`        | Admin-only, revokes the pending invitation.                                                                                                                                                                                                                               |
| `POST /api/admin/users/:id/reset-link` | Admin-only, creates/replaces a reset link for an enabled account. Returns `{url,email,kind,expiresAt}` once. Link creation expiry is an ISO timestamp.                                                                                                                    |
| `POST /api/account-link`               | `{token}` inspects a usable link; returns `{kind,email,name,role,expiresAt}`. No session required.                                                                                                                                                                        |
| `POST /api/account-link/accept`        | `{token,password}` sets the password atomically, returns `{ok:true}`, and clears the browser session cookie. No session required.                                                                                                                                         |
| `POST /api/account/password`           | Signed-in `{currentPassword,password}` changes the caller’s password and clears the session cookie; returns `{ok:true}`.                                                                                                                                                  |
| `POST /api/admin/projects`             | Admin-only `{id,name,description?}` registers a project and returns `{project,token}`. Show the publishing token once.                                                                                                                                                    |
| `POST /api/admin/projects/:id/token`   | Admin-only, immediately replaces the publishing credential and returns `{token}`. Previously published mocks remain.                                                                                                                                                      |

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

Limits: 50 boards, 200 frames, 400 files, 24 MiB of decoded files, and a 34 MiB JSON upload body. Frame dimensions are integer CSS pixels from 100 to 4096; coordinates are finite values between -100000 and 100000. Files use case-sensitive, relative ASCII paths up to 240 characters, with no empty, dot, hidden, or parent segments. Use the exact listed paths. The local publisher rejects file paths resolving outside `design/`, including escaping symlinks.

Generated previews share the file and decoded-byte budgets. The JSON allowance covers base64 expansion and manifest overhead; it is not additional asset capacity. Update both the destination Worker and the publisher checkout before using these limits; older installations keep their lower caps. The publishing command and schema are unchanged. The Worker counts streamed request bytes before parsing and decodes base64 in bounded blocks, validates the whole bundle before writing, and activates only after every file is stored. Larger bundles still require sufficient CPU time; the Free plan's 10 ms CPU allowance is not a supported near-limit upload budget. Workers memory remains 128 MB on both plans and is shared by concurrent requests. See [capacity verification](https://github.com/proton-horizon/mgm-design/issues/12) for measured runtime evidence and its scope.

Permitted extensions and authoritative MIME types live in `worker/bundle.mjs`. They include HTML/CSS/JS modules, JSON, common images, fonts, GLB/glTF, binary data, WASM, audio/video, and text notices. Extension acceptance does not prove a runtime capability; compression workers and WASM compilation are currently blocked by the preview CSP and are not supported. Every frame entry must be a listed `.html` file. Optional frame `preview` is a listed `.png`, `.jpg`, `.jpeg`, or `.webp` image showing the initial screen at the declared viewport. It uses the same private storage and revocable grant as the HTML. Keep preview images small (the generator uses a 640-pixel longest edge). Files are base64-encoded only for upload and stored as their original bytes.

The publication replaces the entire set. To intentionally clear a project, send `empty: true`, `boards: []`, and `files: []`. Missing manifests or an accidentally empty boards list fail validation. Schema mismatches and unrecognized manifest/project/board/frame properties fail before activation. The maintained validator is shared by Worker and publisher.

## Publisher and API

Run the checked-out MGM Design script with Node 22 or newer from the source repository:

```sh
MGM_SITE_URL=https://design.example.com MGM_PROJECT_ID=rubber-ducky \
  node /path/to/mgm-design/scripts/publish.mjs
```

Supply `MGM_PUBLISH_TOKEN` through the repository's existing secret mechanism. `--site`, `--project`, and `--directory` override their nonsecret defaults. Map existing secret names into the publisher environment; do not relocate secrets to fit these example names. Use separate jobs or independent outcomes for separate sites and keep mock publication independent from production application deployment. The script registers an attempt before reading/validating its bundle, reports failures when possible, and exits nonzero on failure. Source compilation/export must happen before invoking this bundled-file publisher; a workflow that needs build failures on the site's status should register the attempt through the API before its build and report completion/failure itself.

For automatic overview images, install the MGM checkout’s dependencies with `pnpm install --frozen-lockfile`, install Chromium with `pnpm exec playwright install --with-deps chromium`, and add `--previews` to the publisher command. No frontend build is required for capture. The [example workflow](../examples/design-publish.yml) includes these steps. Deploy a viewer/backend supporting the optional `preview` field before publishing it; older strict validators reject this extension.

`scripts/generate-previews.mjs` captures missing previews sequentially from a frozen copy of the validated source bundle through the ephemeral local Worker and its production sandbox. A fresh browser context per frame receives only that publication’s network access, never publishing credentials. Captures use reduced motion, wait for network idle, fonts, and images, then allow a short rendering settle. A mock with asynchronous initialization may set `data-mgm-preview-ready="false"` on an element and change it to `"true"` when ready; readiness times out after 15 seconds. Static previews show initial state, not live animation.

Generated JPEGs live under `mgm-previews/<board>/<frame>.jpg` in the uploaded bundle; source files are untouched. Existing declared previews are preserved. Images count toward the same 400-file / 24 MiB limits. Capture, resource, script, and size-limit failures fail the registered publication attempt and preserve the previous active set. Local preview without generated or declared images uses the Open screen fallback.

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

The supported v1 3D profile uses bundled classic JavaScript with Three.js/GLTFLoader and self-contained, uncompressed GLB models. The accepted character study uses ordinary materials, separate clothing meshes, and whole-model animation; its pipeline does not require textures or skeletal deformation. Chromium/WebKit checks cover protected model loading, direct navigation, controls, reduced motion, and context-loss fallback; the owner confirmed iPhone/iPad use. No minimum browser version is promised. Module/dynamic-import, font, textured/skinned model and decoder pipelines need their own runtime checks before use. See [the completed validation](https://github.com/proton-horizon/mgm-design/issues/2) for exact coverage.

## Live appearance

MGM supplies the viewer's Light/Dark preference while a frame is open in Interact. The app determines which appearances it supports: light only, dark only, or both. The header reports the viewer preference, which can differ from a fixed-theme app. No manifest fields, per-site settings, or publication schema changes are required. The viewer sets the iframe’s `color-scheme`; native CSS `prefers-color-scheme` and JavaScript `matchMedia` inherit it, including changes while open. JavaScript consumers must listen for media-query changes if they cache the result. See [browser inheritance behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme#embedded_elements).

Apps that support appearance switching through explicit classes, theme providers, or a 3D palette can consume the following messages once in their shared runtime:

| Direction                                     | Message                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Mock → viewer, after registering its listener | `{type:'mgm:appearance:ready', version:1}`                       |
| Viewer → active mock                          | `{type:'mgm:appearance', version:1, appearance:'light'\|'dark'}` |

The viewer sends current appearance on iframe load, valid readiness, and preference changes. It accepts readiness only from the active iframe’s `contentWindow` with the sandbox’s `event.origin === 'null'`. It never accepts an appearance choice from a mock. The outbound message contains only appearance, with `targetOrigin: '*'` because the receiving sandbox has an opaque origin. No credentials, grants, user information, or other capabilities cross this channel.

The mock registers its listener before sending readiness to the exact viewer origin, obtained from `new URL(location.href).origin` under MGM’s same-host protected delivery contract. Accept replies only when `parent !== window`, `event.source === parent`, `event.origin` equals that expected origin, the message type/version match, and appearance is exactly `light` or `dark`. Reject malformed values. Do not trust `Origin: null`, query parameters, or messages from unrelated windows as viewer authority.

For a supported appearance, apply accepted state through the mock's existing shared theme function without reloading, clearing drafts, or rebuilding navigation. Apps following MGM use its preference over the browser or initial fixture choice during Interact. A fixed-theme app keeps its supported appearance and can ignore this channel; an unsupported preference never requires creating another theme. New documents repeat the readiness handshake. Outside Interact, including standalone screenshots, retain the authored initial appearance or browser fallback. Pan images are fixed publication assets; changing MGM appearance does not regenerate them.

The viewer does not rewrite mock CSS or access its DOM. An app's styles determine its palette; a fixed-theme document can declare its own CSS `color-scheme` to keep native controls consistent too. Choose theme support from the product's requirements, not from MGM's toggle. When a custom theme integration is useful, implement it once per app runtime. Test native media inheritance with browser automation’s forced color-scheme emulation disabled; Playwright’s per-frame override otherwise masks native inheritance. `scripts/check-appearance.mjs` verifies both browser engines, live changes, state retention, navigation, message validation, and unchanged static previews.
