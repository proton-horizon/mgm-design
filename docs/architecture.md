# App and canvas

MGM Design is a React/TypeScript web app built with Vite. `src/App.tsx` owns sign-in, project navigation, appearance, and board selection. `src/Admin.tsx` manages people and project tokens. `src/Canvas.tsx` displays browser-ready frames in isolated iframes. `src/api.ts` implements the `DesignService` boundary in `src/types.ts`; hosting credentials and storage bindings never enter frontend code.

The Worker serves built assets, checks accounts, and delivers private mocks. See [the backend contract](backend.md) for API and publication details. Source code has no built-in customer projects. The project list comes from the installation API.

## Navigation and presentation

The sidebar lists projects and their boards. Board selection uses `#board=project%2Fboard` links and browser history. Search matches project and board names. A compact drawer replaces the sidebar below 760 CSS pixels. Light/dark appearance persists in browser storage. Accounts have email/password credentials and either site-admin or viewer access.

Each board shows its complete frame set in Pan mode. Frames use manifest coordinates, or default to a horizontal sequence with 80 CSS pixels between screens. The camera stores translation and scale; `src/canvas-math.ts` computes fit and focal-point zoom. Scale ranges from 8% to 300%. Drag or two-finger scroll pans; two-touch pinch and modified wheel zoom keep the focal point fixed. F/0 fits all screens, 1 restores actual size, +/- zoom, and arrow keys pan when the canvas has focus.

Select a screen or use Jump to screen, then choose Interact. A separate single-frame view receives pointer input while preserving the declared viewport and fitting the available space. Back to canvas returns to navigation. Previous/next switches frames. The canvas blocks iframe pointer input in Pan mode. Offscreen canvas frames are unmounted with a 200-pixel margin, reducing unnecessary runtime work; re-entering or refreshing can reset a mock's transient state.

The overview map recenters the canvas. Responsive layouts and touch gestures are implemented; real-device rendering and browser-specific runtime support require separate verification. Preview grants refresh periodically, and Refresh designs fetches fresh publication data. Failed/unknown attempt status is separate from successfully active designs.

## Local development

Install dependencies with `pnpm install`. Put a randomly generated local `SETUP_SECRET` in ignored `.dev.vars`. Run `pnpm exec wrangler d1 migrations apply DB --local`, then `pnpm dev:site`. Open the printed localhost URL and create a local account with the setup key. Local accounts and mocks persist under ignored `.wrangler/`; they are separate from hosted data.

After frontend changes, run `pnpm build` while the Worker stays running; Wrangler picks up changed assets. The frontend and backend use one local origin, matching production sandbox and authentication behavior. Local preview uses the same account and publication contract; automatic sibling-folder watching and authentication bypass are not implemented.

Use `pnpm build`, `pnpm typecheck:worker`, and `pnpm test`. Backend tests run isolated D1/R2 in workerd; canvas tests verify camera geometry; deployment tests verify configuration isolation and failure order. The human guide in `website/index.html` opens directly without a server.
