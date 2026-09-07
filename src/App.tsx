import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Folder,
  Grid2X2,
  Layers,
  LoaderCircle,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { request, service } from './api';
import type { Project, Session } from './types';
import Canvas from './Canvas';
import Admin from './Admin';

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
function initialSelection() {
  return new URLSearchParams(location.hash.slice(1)).get('board') ?? '';
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState(initialSelection);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebar, setSidebar] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState('');
  const [admin, setAdmin] = useState(false);
  const [help, setHelp] = useState(false);
  const [status, setStatus] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem('mgm-theme') === 'dark');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('mgm-theme', dark ? 'dark' : 'light');
  }, [dark]);
  async function load() {
    setError('');
    try {
      const current = await service.session();
      setSession(current);
      if (current.user) setProjects(await service.projects());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const expired = () => {
      setSession((previous) => (previous ? { ...previous, user: null } : previous));
      setProjects([]);
    };
    window.addEventListener('mgm-session-expired', expired);
    return () => window.removeEventListener('mgm-session-expired', expired);
  }, []);
  useEffect(() => {
    const change = () => setSelection(initialSelection());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    if (!session?.user) return;
    const timer = setInterval(
      () => {
        void service
          .projects()
          .then(setProjects)
          .catch(() => {});
      },
      25 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [session?.user]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSidebar(true);
        setMobileNav(true);
        setTimeout(() => search.current?.focus(), 0);
      }
      if (e.key === 'Escape') {
        setMobileNav(false);
        setHelp(false);
        setStatus(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const available = projects.flatMap((p) =>
    p.boards.map((b) => ({ project: p, board: b, key: `${p.id}/${b.id}` })),
  );
  const selected = available.find((b) => b.key === selection) ?? available[0];
  const navigate = (key: string) => {
    location.hash = new URLSearchParams({ board: key }).toString();
    setSelection(key);
    setMobileNav(false);
    setStatus(false);
  };
  async function refresh() {
    setRefreshing(true);
    try {
      setProjects(await service.projects());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  if (loading)
    return (
      <div className="boot">
        <Mark />
        <LoaderCircle className="spinning" size={20} />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!session)
    return (
      <div className="boot">
        <Mark />
        <h1>Couldn’t open this workspace</h1>
        <p role="alert">{error}</p>
        <button className="primary-button" onClick={load}>
          Try again
        </button>
      </div>
    );
  if (!session.user) return <SignIn session={session} onSuccess={load} />;
  const publication = selected?.project.publication;
  const failed = publication?.status === 'failed' || publication?.status === 'unknown';
  return (
    <div className={`workspace ${sidebar ? '' : 'sidebar-collapsed'}`}>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close projects"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`} aria-label="Projects">
        <div className="sidebar-brand">
          <Mark small />
          <span>
            MGM <b>Design</b>
          </span>
          <button
            className="icon-button collapse-button"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={() => {
              setSidebar(false);
              setMobileNav(false);
            }}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <div className="workspace-name">
          <span className="workspace-avatar">{session.siteName?.slice(0, 1) || 'P'}</span>
          <div>
            <strong>{session.siteName || 'Design workspace'}</strong>
            <span>Design workspace</span>
          </div>
        </div>
        <label className="sidebar-search">
          <Search size={15} />
          <input
            ref={search}
            placeholder="Find a project…"
            aria-label="Find a project"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="section-heading">
          <span>Projects</span>
          <span>{projects.length}</span>
          {session.user.role === 'admin' && (
            <button
              className="icon-button"
              aria-label="Add project"
              title="Add project"
              onClick={() => setAdmin(true)}
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        <nav className="project-tree">
          {projects
            .filter((p) =>
              `${p.name} ${p.boards.map((b) => b.name).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((p) => (
              <div key={p.id} className="project-group">
                <button
                  className="project-row"
                  aria-expanded={!collapsed.has(p.id) || !!query}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(p.id) && !query ? (
                    <ChevronRight size={13} />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                  <Folder size={16} />
                  <span>{p.name}</span>
                </button>
                {(!collapsed.has(p.id) || !!query) && (
                  <div className="board-list">
                    {p.boards.map((b) => (
                      <button
                        key={b.id}
                        className={`board-row ${selected?.key === `${p.id}/${b.id}` ? 'selected' : ''}`}
                        aria-current={selected?.key === `${p.id}/${b.id}` ? 'page' : undefined}
                        onClick={() => navigate(`${p.id}/${b.id}`)}
                      >
                        <Grid2X2 size={14} />
                        <span>{b.name}</span>
                        <span className="board-count">{b.frames.length}</span>
                      </button>
                    ))}
                    {!p.boards.length && (
                      <span className="no-boards">Awaiting first publication</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          {query &&
            !projects.some((p) =>
              `${p.name} ${p.boards.map((b) => b.name).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ) && <p className="search-empty">No projects match “{query}”.</p>}
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-link" onClick={() => setHelp(true)}>
            <CircleHelp size={16} /> Canvas shortcuts
          </button>
          <button className="sidebar-link" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}{' '}
            {dark ? 'Light appearance' : 'Dark appearance'}
          </button>
          {session.user.role === 'admin' && (
            <button className="sidebar-link" onClick={() => setAdmin(true)}>
              <Settings2 size={16} /> Site administration
            </button>
          )}
          <div className="account">
            <span className="account-avatar">
              {session.user.name?.slice(0, 1) || session.user.email[0]}
            </span>
            <div>
              <strong>{session.user.name || session.user.email}</strong>
              <span>{session.user.role === 'admin' ? 'Site admin' : 'Viewer'}</span>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                try {
                  await service.logout();
                  setProjects([]);
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <button
            className={`icon-button sidebar-toggle ${sidebar ? 'mobile-only' : ''}`}
            aria-label="Open projects"
            onClick={() => {
              setSidebar(true);
              setMobileNav(true);
            }}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>{selected?.project.name || 'Workspace'}</span>
            <ChevronRight size={13} />
            <strong>{selected?.board.name || 'Projects'}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className={`publication-status ${failed ? 'failed' : ''}`}
              onClick={() => setStatus(!status)}
            >
              <span className="status-dot" />
              {failed
                ? 'Publication needs attention'
                : publication?.status === 'pending' || publication?.status === 'uploading'
                  ? 'Publishing…'
                  : 'Latest designs'}
              <ChevronDown size={12} />
            </button>
            <button
              className="icon-button"
              title="Refresh designs"
              aria-label="Refresh designs"
              onClick={refresh}
            >
              <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            </button>
          </div>
        </header>
        {status && (
          <div className="status-panel">
            <strong>
              {publication
                ? publication.status === 'published'
                  ? 'Latest publication is live'
                  : `Publication: ${publication.status}`
                : 'No publication yet'}
            </strong>
            <p>
              {publication?.message ||
                'The canvas shows the latest successfully published designs.'}
            </p>
            {publication?.createdAt && (
              <small>
                {new Date(publication.createdAt).toLocaleString()}
                {publication.commit && ` · ${publication.commit.slice(0, 7)}`}
              </small>
            )}
            {publication?.runUrl?.startsWith('https://github.com/') && (
              <a href={publication.runUrl} target="_blank" rel="noreferrer">
                View publishing run <ArrowRight size={13} />
              </a>
            )}
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {selected ? (
          <>
            <section className="board-heading">
              <div>
                <div className="eyebrow">{selected.project.name}</div>
                <h1>
                  {selected.board.name}
                  <span className="board-type">Board</span>
                </h1>
                <p>
                  {selected.board.description ||
                    'A space to explore the details and see the whole picture.'}
                </p>
              </div>
              <span className="frame-summary">
                <Layers size={15} />
                {selected.board.frames.length} screens
              </span>
            </section>
            <Canvas key={selected.key} board={selected.board} />
          </>
        ) : (
          <div className="empty-state">
            <Layers size={34} />
            <h1>Your ideas belong here.</h1>
            <p>
              {projects.length
                ? 'Your projects are ready. Publish a board to start exploring.'
                : 'Add a project, then publish its designs from your app repository.'}
            </p>
            {session.user.role === 'admin' && (
              <button className="primary-button" onClick={() => setAdmin(true)}>
                <Plus size={16} /> Add a project
              </button>
            )}
          </div>
        )}
      </main>
      {admin && (
        <Admin
          currentUser={session.user}
          projects={projects}
          close={() => setAdmin(false)}
          onChange={refresh}
        />
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal shortcuts-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Canvas shortcuts"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>Make yourself at home.</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label="Close shortcuts"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>One canvas. A few simple gestures.</p>
            <dl>
              <div>
                <dt>Move around</dt>
                <dd>Drag or two-finger scroll</dd>
              </div>
              <div>
                <dt>Zoom in and out</dt>
                <dd>
                  Pinch or <kbd>⌘</kbd> + scroll
                </dd>
              </div>
              <div>
                <dt>Fit all screens</dt>
                <dd>
                  <kbd>F</kbd>
                </dd>
              </div>
              <div>
                <dt>Actual size</dt>
                <dd>
                  <kbd>1</kbd>
                </dd>
              </div>
              <div>
                <dt>Zoom</dt>
                <dd>
                  <kbd>+</kbd> <kbd>−</kbd>
                </dd>
              </div>
              <div>
                <dt>Find a project</dt>
                <dd>
                  <kbd>⌘ K</kbd>
                </dd>
              </div>
              <div>
                <dt>Use a screen</dt>
                <dd>Select it → Interact</dd>
              </div>
            </dl>
            <p className="hint">
              On mobile, drag with one finger and pinch with two. Open Projects using the top-left
              menu.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function SignIn({ session, onSuccess }: { session: Session; onSuccess: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="signin-page">
      <div className="signin-brand">
        <Mark small />
        <span>
          MGM <b>Design</b>
        </span>
      </div>
      <main className="signin-card">
        <div className="signin-emblem">
          <Command size={27} strokeWidth={1.3} />
        </div>
        <span className="eyebrow">{session.siteName || 'YOUR DESIGN WORKSPACE'}</span>
        <h1>{session.setupRequired ? 'Make room for your ideas.' : 'Welcome back.'}</h1>
        <p>
          {session.setupRequired
            ? 'Create the first admin account for this workspace.'
            : 'Sign in to see what’s taking shape.'}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            const data = new FormData(e.currentTarget);
            try {
              if (session.setupRequired)
                await request('/api/setup', {
                  method: 'POST',
                  body: JSON.stringify(Object.fromEntries(data)),
                });
              else await service.login(String(data.get('email')), String(data.get('password')));
              await onSuccess();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {session.setupRequired && (
            <label>
              Your name
              <input name="name" autoComplete="name" required placeholder="Your name" />
            </label>
          )}
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              required
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={session.setupRequired ? 'new-password' : 'current-password'}
              required
              minLength={session.setupRequired ? 12 : undefined}
              placeholder={session.setupRequired ? 'At least 12 characters' : 'Enter your password'}
            />
          </label>
          {session.setupRequired && (
            <label>
              Setup key
              <input
                name="setupSecret"
                type="password"
                autoComplete="off"
                required
                placeholder="Your installation’s setup key"
              />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spinning" size={17} />
            ) : (
              <>
                {session.setupRequired ? 'Create workspace' : 'Sign in'}
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>
        <p className="signin-note">
          {session.setupRequired
            ? 'You’ll manage projects and access from site administration.'
            : 'Need access? Ask your site administrator.'}
        </p>
      </main>
      <footer>A place for everything you’re designing.</footer>
    </div>
  );
}
