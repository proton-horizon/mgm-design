# MGM Design

Build a reusable design viewer with independent installations. Define interfaces at architectural boundaries; keep project mocks in their source app's `design/` directory.

## Project docs

Read only the documents relevant to the task:

- `docs/glossary.md` — project, board, frame, publication, and mode meanings. Read when changing navigation or the shared manifest.
- `docs/architecture.md` — frontend structure, canvas behavior, and local development. Read for UI or cross-cutting changes.
- `docs/backend.md` — authentication, publication API/schema, storage, and sandbox contracts. Read before backend or publisher changes.
- `website/index.html` — directly openable human guide. Update affected feature pages when user workflows change.

Keep this routing list synchronized with maintained files under `docs/`. Documentation describes implemented behavior; plans and investigations belong in GitHub issues. Use glossary definitions consistently. Keep technical explanations brief and plain. A change is complete when relevant tests pass and affected documentation is current.

## Development

- Node 22.12+ and pnpm. `pnpm build`, `pnpm typecheck:worker`, and `pnpm test` check the implementation.
- `pnpm dev` (or `pnpm dev:site`) builds and runs the complete app on localhost. Rebuild with `pnpm build` after frontend edits.
- Never commit `.dev.vars`, `.env*`, generated instance configuration, preview grant URLs, session cookies, or publishing tokens.
- Never grant mocks `allow-same-origin`, public R2 access, or authenticated CORS based on `Origin: null`.
- Each installation owns its database, bucket, accounts, and deployment configuration. Shared source contains no customer resource inventory.
- Keep documentation in `docs/`, the human guide in `website/`, and planned work in GitHub issues. Follow the github-issues skill for tickets.
