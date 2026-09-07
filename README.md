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

Provision a dedicated Worker, D1 database, and private R2 bucket for each installation. The deploying project owns its instance settings, deployment workflow, and credentials; MGM Design supplies reusable source and scripts. Configure these nonsecret environment variables using that project's existing deployment configuration:

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
# Install dependencies and build in your MGM Design checkout first.
pnpm --dir /path/to/mgm-design install --frozen-lockfile
pnpm --dir /path/to/mgm-design build
# Run from the project that owns the installation.
node /path/to/mgm-design/scripts/deploy.mjs --config-only --output deployments/design/.local/wrangler.json
pnpm --dir /path/to/mgm-design exec wrangler secret put SETUP_SECRET --config /absolute/path/to/owner/deployments/design/.local/wrangler.json
node /path/to/mgm-design/scripts/deploy.mjs --deploy --output deployments/design/.local/wrangler.json
```

Ignore the generated configuration and private files in the owning project before generating them. The example directory is a convention, not a required secret location. `--output` accepts an absolute path or a path relative to the caller's working directory. Source, Worker TypeScript settings, assets, migration, and schema paths are rebased to that file; regenerate it if either checkout moves. Wrangler runs from the output directory using MGM Design's installed CLI. Without `--output`, standalone use writes `wrangler.instance.json` in the MGM checkout.

Deployment first checks bundling, then applies D1 migrations, then deploys; a failure stops later steps. The Worker serves the viewer, API, and protected mock paths on one hostname. Existing D1/R2 bindings must remain stable across updates. Back up both before schema changes.

Generated and local configurations enable `nodejs_compat` for native password hashing. Verify account setup and login on the deployed Worker under its configured CPU limits; passing local tests does not establish production CPU headroom. See the [authentication contract](docs/backend.md#authentication).

Each installation owns its update pipeline and deployment credential. A pipeline following MGM Design's `main` must fetch that source, install and build it, then invoke the script with its own settings and output path. A direct Cloudflare Builds checkout of MGM Design can use the standalone default, with installation settings held in that Worker's build configuration. When a pipeline instead checks out the owning project, pass the actual MGM source commit as `WORKERS_CI_COMMIT_SHA` to the deploy script so the site's build identifier describes the deployed framework. The repository holds no customer credentials or destination registry. Cross-account updates and automatic upstream-triggered updates through a separate owning repository still need validation.

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
