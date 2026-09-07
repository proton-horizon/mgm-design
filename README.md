# MGM Design

A self-hosted workspace for your app designs. Organize projects and boards, explore HTML screens on a pan-and-zoom canvas, and switch to Interact mode to try them. Works in desktop and mobile browsers. No chatbot.

Each installation owns its accounts and projects. Mocks stay in the source app repository under `design/` and publish independently through a project-scoped API token. Updating the viewer does not replace mock storage.

## Run locally

Requires Node 22.12+ and pnpm.

```sh
pnpm install
# Set a random SETUP_SECRET in the ignored .dev.vars file.
pnpm exec wrangler d1 migrations apply DB --local
pnpm dev:site
```

Open the printed localhost URL. Create the first admin using your local setup key, email, and a password of at least 12 characters. Add a project in Site administration, copy its publishing token once, and publish a bundle from its app repository. There are no default accounts. Rebuild the frontend after edits with `pnpm build`; Wrangler notices the changed assets.

## Install on Cloudflare

Provision a dedicated Worker, D1 database, and private R2 bucket for each installation. Configure these nonsecret environment variables using your existing deployment configuration:

```text
MGM_WORKER_NAME
MGM_D1_DATABASE_NAME
MGM_D1_DATABASE_ID
MGM_R2_BUCKET_NAME
MGM_SITE_URL
MGM_SITE_NAME
```

`MGM_SITE_URL` is an HTTPS origin: your custom domain or the Worker's matching `workers.dev` address. `CLOUDFLARE_ACCOUNT_ID` is optional when your login selects one account. Authenticate Wrangler for your account and set the Worker's `SETUP_SECRET` as a secret. Do not put credentials in shared source.

```sh
pnpm build
node scripts/deploy.mjs --config-only
pnpm exec wrangler secret put SETUP_SECRET --config wrangler.instance.json
node scripts/deploy.mjs --deploy
```

The generator writes ignored `wrangler.instance.json`. Deployment first checks bundling, then applies D1 migrations, then deploys; a failure stops later steps. The Worker serves the viewer, API, and protected mock paths on one hostname. Existing D1/R2 bindings must remain stable across updates. Back up both before schema changes.

To follow `main`, connect this repository to each Worker's Cloudflare Builds integration. Configure the instance variables and a dedicated deployment credential in that installation. Build with `pnpm install --frozen-lockfile && pnpm build`; deploy with `node scripts/deploy.mjs --deploy`. The repository does not centrally hold customer credentials or a destination registry. Cross-account automatic-update installation has not been validated yet.

## Publish designs

Register a project in Site administration. In the source app, create `design/manifest.json` describing boards and frames and explicitly listing all runtime files. Build/export any source assets in that app repository. MGM receives ready-to-run HTML/CSS/JS and assets.

```sh
# Supply MGM_PUBLISH_TOKEN through your existing secret mechanism.
MGM_SITE_URL=https://design.example.com MGM_PROJECT_ID=my-app \
  node /path/to/mgm-design/scripts/publish.mjs
```

Use a separate GitHub Actions workflow or independent job triggered by the app's `main` branch. A mock failure must not block production deployment. Each destination has a separate URL and token. The publisher reports failures when the site is reachable; GitHub Actions is the fallback. Source builds needing site-side failure reporting must register the attempt before the build, as described in the [API contract](docs/backend.md).

The complete latest successful set replaces the previous one atomically. Failed publications preserve visible designs. Mocks run in an opaque-origin sandbox and must bundle their runtime dependencies; no privileged storage, outside network requests, or embedded backend credentials. Three.js, compression decoders, and full mobile browser coverage remain subject to [the runtime validation issue](https://github.com/proton-horizon/mgm-design/issues/2).

## Guide and checks

- [Human guide](website/index.html) — open directly in a browser.
- [Backend and bundle contract](docs/backend.md) — exact manifest, API, limits, security, and recovery.
- [App architecture](docs/architecture.md) — UI behavior and local development.
- `pnpm build`, `pnpm typecheck:worker`, `pnpm test`.

The repository is public, but license selection is still tracked in [#3](https://github.com/proton-horizon/mgm-design/issues/3). No general redistribution or commercial license has been granted yet.
