# MGM Design

A self-hosted workspace for your app designs. Organize projects and boards, explore HTML screens on a pan-and-zoom canvas, and switch to Interact mode to try them. Works in desktop and mobile browsers. No chatbot.

Each installation owns its accounts and projects. Mocks stay in the source app repository under `design/` and publish independently through a project-scoped API token. Updating the viewer does not replace mock storage.

## Run locally

Requires Node 22.12+ and pnpm.

To review mocks directly from one or more app repositories:

```sh
pnpm install
pnpm dev:mocks --directory ../my-app/design
# Add --directory ../another-app/design for another project, or --port 8791.
```

Open the printed `127.0.0.1` URL. This read-only workspace signs you in automatically, watches the listed directories, and reloads after a valid change. Each directory needs a different manifest project ID. It uses temporary local storage and the deployed bundle/sandbox rules; invalid changes leave the last good designs visible and print an error in the terminal. Stop the command to discard its local accounts and publications. It never publishes to a hosted site. Export/build source assets in the app repo before previewing them.

To develop the complete app with persistent local accounts and administration:

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

After cloning MGM Design and running `pnpm install --frozen-lockfile`, create the database and bucket using your own unique names. The database command returns the ID used above:

```sh
pnpm --dir /path/to/mgm-design exec wrangler login
pnpm --dir /path/to/mgm-design exec wrangler d1 create my-design
pnpm --dir /path/to/mgm-design exec wrangler r2 bucket create my-design-mocks
```

Use an existing Worker with the configured name or create it in the Cloudflare dashboard. Save a random setup key in the owning project's existing secret system; enter that same key at the `secret put` prompt below and at first-admin setup. Keep the bucket private.

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

### Automatic framework updates

Each installation owns its update pipeline and deployment credential. In that Worker's Cloudflare Builds settings, connect `proton-horizon/mgm-design`, select production branch `main`, and configure its own build token. Disable nonproduction/preview deployments. Copy the installation variables above from the owning project's settings into that Worker's build environment; synchronize them again when the owner changes settings. No private owner-repository checkout is needed during a framework build.

In GitHub's installed Cloudflare Workers and Pages app settings, include `proton-horizon/mgm-design` in the authorized repositories. If using selected repositories, preserve existing selections and add MGM explicitly. A public repository can clone successfully without this authorization, while push-triggered builds remain disconnected. Confirm Cloudflare shows the Git connection as connected before testing a main push.

Cloudflare Builds currently accepts [user-owned API tokens](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token). For this deployment, configure Workers Scripts edit and D1 edit, plus Workers R2 Storage read and Account Settings read on the destination account. For a custom hostname, add Workers Routes edit and Zone read only for its zone. These permissions are scoped to the account/zone, not an individual Worker, database, or bucket. Separate installation tokens allow independent revocation but do not restrict each token to that installation's resources within a shared account. Keep deployment tokens in Cloudflare Builds, separate from the project tokens used to publish mocks.

Set `NODE_VERSION=24.18.0`, `PNPM_VERSION=11.19.0`, and `SKIP_DEPENDENCY_INSTALL=1`. Use this build command:

```sh
pnpm install --frozen-lockfile && pnpm build && pnpm typecheck:worker && pnpm test
```

Use this deployment command. Cloudflare supplies `WORKERS_CI_COMMIT_SHA`; it becomes the site's framework build identifier. The guard skips superseded builds and fails visibly if the upstream commit cannot be resolved.

```sh
set -eu
ref=$(git ls-remote https://github.com/proton-horizon/mgm-design.git refs/heads/main)
sha=${ref%%[[:space:]]*}
case "$sha" in
  ""|*[!0-9a-f]*) echo "Cannot resolve upstream main" >&2; exit 1 ;;
esac
[ "${#sha}" -eq 40 ] || { echo "Invalid upstream commit" >&2; exit 1; }
if [ "${WORKERS_CI_COMMIT_SHA:?Missing build commit}" = "$sha" ]; then
  node scripts/deploy.mjs --deploy --output ../instance/wrangler.json
else
  echo "Skipping superseded framework commit"
fi
```

Serialize deployments per installation. The commit guard alone cannot prevent an already-running deployment from overtaking a newer deployment. If relying on the account's concurrent-build limit of one, verify that limit during setup and add explicit serialization before increasing it.

Creating instance variables alone does not enable automatic updates: each Worker needs a connected, enabled Builds trigger and an authorized build token. Once configured, pushes to MGM `main` update the framework without consumer version edits. The repository holds no customer credentials or destination registry. If your pipeline checks out the owning project instead, pass the actual MGM source commit as `WORKERS_CI_COMMIT_SHA` and keep the owner and framework checkouts as siblings.

## Publish designs

Register a project in Site administration. In the source app, create `design/manifest.json` describing boards and frames and explicitly listing all runtime files. Build/export any source assets in that app repository. MGM receives ready-to-run HTML/CSS/JS and assets.

```sh
# Supply MGM_PUBLISH_TOKEN through your existing secret mechanism.
MGM_SITE_URL=https://design.example.com MGM_PROJECT_ID=my-app \
  node /path/to/mgm-design/scripts/publish.mjs
```

Use a separate GitHub Actions workflow or independent job triggered by the app's `main` branch. A mock failure must not block production deployment. Each destination has a separate URL and token. The publisher reports failures when the site is reachable; GitHub Actions is the fallback. Source builds needing site-side failure reporting must register the attempt before the build, as described in the [API contract](docs/backend.md).

Copy [the publishing workflow](examples/design-publish.yml) into the app's `.github/workflows/design-publish.yml`. Configure its site URL and registered project ID as repository variables, and map its project token from your existing secrets. The template publishes checked-in browser-ready files; add any source build/export step before publication and adjust path triggers to include its inputs. It follows MGM `main` for the maintained publisher. Keep one sequence convention per project: the template uses this workflow's run number and retry number. Replacing an existing workflow/counter requires preserving monotonically increasing values, as explained in the API contract. For multiple destinations, use separate jobs with independent credentials and outcomes.

The complete latest successful set replaces the previous one atomically. Failed publications preserve visible designs. Mocks run in an opaque-origin sandbox and must bundle their runtime dependencies; no privileged storage, outside network requests, or embedded backend credentials. The supported v1 3D profile uses bundled classic Three.js JavaScript and self-contained, uncompressed GLB models. The current study works in Chromium, WebKit, iPhone and iPad; workers and WASM decoders are unsupported. See the [runtime contract](docs/backend.md#preview-isolation) for limits and [validation evidence](https://github.com/proton-horizon/mgm-design/issues/2).

## Guide and checks

- [Human guide](website/index.html) — open directly in a browser.
- [Backend and bundle contract](docs/backend.md) — exact manifest, API, limits, security, and recovery.
- [App architecture](docs/architecture.md) — UI behavior and local development.
- `pnpm build`, `pnpm typecheck:worker`, `pnpm test`.
- `node scripts/check-canvas.mjs` — after building and installing Playwright Chromium/WebKit, verifies a 75-screen fixture at phone, tablet, and desktop sizes against the real local Worker. GitHub checks run this browser regression too.

The build includes [third-party notices](public/third-party-notices.txt) for the viewer's installed runtime dependencies. Keep these notices with redistributed builds. Published design bundles own their asset and dependency notices separately.

The repository is public, but license selection is still tracked in [#3](https://github.com/proton-horizon/mgm-design/issues/3). No general redistribution or commercial license has been granted yet.
