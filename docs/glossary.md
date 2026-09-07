# Shared language

- **Installation / site** — an independently hosted MGM Design workspace, with its own hostname, accounts, projects, database, and private files.
- **Project** — a top-level product in that installation, such as Rubber Ducky. Its source repository owns the mocks.
- **Board** — a subproject such as App or Clothing. Selecting it opens one canvas.
- **Frame** — an HTML screen at a specified viewport, positioned on a board. It can contain its own interactive app mock.
- **Pan mode** — canvas navigation. Frames do not receive clicks or gestures.
- **Interact mode** — a focused, sandboxed screen preview that receives clicks and touch gestures.
- **Publication** — a complete set of a project's boards and runtime files. The latest successful publication is visible.
- **Attempt** — a publishing operation whose status is tracked independently from the visible publication.
- **Publishing token** — project-scoped credential held by the source repository's publishing job.
- **Preview grant** — a short-lived URL capability for reading one publication, tied to a signed-in session. It cannot publish or administer the site.
