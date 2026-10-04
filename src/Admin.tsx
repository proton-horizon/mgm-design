import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Plus, Users, X } from 'lucide-react';
import { request } from './api';
import type { Project, User } from './types';
import { useDialog } from './useDialog';

export default function Admin({
  currentUser,
  projects,
  close,
  onChange,
}: {
  currentUser: User;
  projects: Project[];
  close: () => void;
  onChange: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [tab, setTab] = useState<'projects' | 'people'>('projects');
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<(User & { expiresAt: number })[]>([]);
  const [link, setLink] = useState<{
    url: string;
    email: string;
    expiresAt: string;
    kind: string;
  } | null>(null);
  async function createLink(path: string, data = {}) {
    setLink(await request(path, { method: 'POST', body: JSON.stringify(data) }));
    setCopied(false);
  }
  async function loadUsers() {
    try {
      const data = await request<{ users: User[] }>('/api/admin/users');
      setUsers(data.users);
      const pending = await request<{ invites: typeof invites }>('/api/admin/invites');
      setInvites(pending.invites);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void loadUsers();
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        ref={dialog}
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Site administration"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">WORKSPACE SETTINGS</span>
            <h2>Site administration</h2>
          </div>
          <button
            autoFocus
            className="icon-button"
            aria-label="Close administration"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <div className="tabs">
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
            Projects
          </button>
          <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
            <Users size={14} />
            People
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {token && (
          <div className="token-box">
            <strong>Copy this publishing token</strong>
            <p>It’s shown once. Store it in your source repository’s existing secrets system.</p>
            <code>{token}</code>
            <button
              className="plain-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token);
                  setCopied(true);
                } catch {
                  setError('Could not copy. Select and copy the token manually.');
                }
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy token'}
            </button>
            <button
              className="plain-button"
              onClick={() => {
                setToken('');
                setCopied(false);
              }}
            >
              Done
            </button>
          </div>
        )}
        {link && tab === 'people' && (
          <div className="token-box" role="status">
            <strong>
              {link.kind === 'invite' ? 'Invitation' : 'Password-reset link'} for {link.email}
            </strong>
            <p>
              Share privately with this person. Anyone with this link can set their password.
              Expires {new Date(link.expiresAt).toLocaleString()}.
            </p>
            <code>{link.url}</code>
            <button
              className="plain-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link.url);
                  setCopied(true);
                } catch {
                  setError('Could not copy. Select and copy the link manually.');
                }
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="plain-button" onClick={() => setLink(null)}>
              Done
            </button>
          </div>
        )}
        {tab === 'projects' ? (
          <>
            <p>Each project receives designs from its own app repository.</p>
            <div className="admin-list">
              {projects.map((project) => (
                <div key={project.id} className="admin-row">
                  <div>
                    <strong>{project.name}</strong>
                    <small>
                      {project.id} · {project.boards.length} boards
                    </small>
                  </div>
                  <button
                    className="plain-button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !confirm(
                          `Replace the publishing token for ${project.name}? Existing publishing jobs will need the new token.`,
                        )
                      )
                        return;
                      void action(async () => {
                        const data = await request<{ token: string }>(
                          `/api/admin/projects/${encodeURIComponent(project.id)}/token`,
                          { method: 'POST', body: '{}' },
                        );
                        setToken(data.token);
                        setCopied(false);
                      });
                    }}
                  >
                    <KeyRound size={14} />
                    Replace token
                  </button>
                </div>
              ))}
            </div>
            <h3>Add a project</h3>
            <form
              className="admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void action(async () => {
                  const result = await request<{ token: string }>('/api/admin/projects', {
                    method: 'POST',
                    body: JSON.stringify(Object.fromEntries(data)),
                  });
                  setToken(result.token);
                  setCopied(false);
                  form.reset();
                  await onChange();
                });
              }}
            >
              <label>
                Project name
                <input name="name" required placeholder="Rubber Ducky" />
              </label>
              <label>
                Project ID
                <input name="id" required pattern="[a-z0-9_-]+" placeholder="rubber-ducky" />
              </label>
              <button className="primary-button" disabled={busy}>
                {busy ? <LoaderCircle size={16} className="spinning" /> : <Plus size={16} />}Add
                project
              </button>
            </form>
          </>
        ) : (
          <>
            <p>
              Everyone can view all projects. Site admins also manage people and publishing access.
            </p>
            <div className="admin-list">
              {users.map((user) => (
                <div className="admin-row" key={user.id}>
                  <div>
                    <strong>
                      {user.name || user.email}
                      {user.id === currentUser.id ? ' (you)' : ''}
                    </strong>
                    <small>
                      {user.email} ·{' '}
                      {user.disabled ? 'Disabled' : user.role === 'admin' ? 'Site admin' : 'Viewer'}
                    </small>
                  </div>
                  <div className="row-actions">
                    <select
                      aria-label={`Role for ${user.email}`}
                      value={user.role}
                      disabled={busy || user.id === currentUser.id}
                      onChange={(event) => {
                        const role = event.target.value;
                        void action(async () => {
                          await request(`/api/admin/users/${user.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ role }),
                          });
                          setLink(null);
                          await loadUsers();
                        });
                      }}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="admin">Site admin</option>
                    </select>
                    <button
                      className="plain-button"
                      disabled={busy || !!user.disabled}
                      onClick={() =>
                        void action(() => createLink(`/api/admin/users/${user.id}/reset-link`))
                      }
                    >
                      Create reset link
                    </button>
                    {user.id !== currentUser.id && (
                      <button
                        className="plain-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await request(`/api/admin/users/${user.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ disabled: !user.disabled }),
                            });
                            setLink(null);
                            await loadUsers();
                          })
                        }
                      >
                        {user.disabled ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {invites.length > 0 && (
              <>
                <h3>Pending invitations</h3>
                <div className="admin-list">
                  {invites.map((invite) => (
                    <div className="admin-row" key={invite.id}>
                      <div>
                        <strong>{invite.name}</strong>
                        <small>
                          {invite.email} · {invite.role === 'admin' ? 'Site admin' : 'Viewer'} ·
                          Expires {new Date(invite.expiresAt).toLocaleDateString()}
                        </small>
                      </div>
                      <button
                        className="plain-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await request(`/api/admin/invites/${invite.id}`, { method: 'DELETE' });
                            setLink(null);
                            await loadUsers();
                          })
                        }
                      >
                        Revoke invite
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            <h3>Invite a person</h3>
            <p className="hint">
              They choose their own password. Create another invite for the same email to replace
              the link or change the pending role.
            </p>
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = Object.fromEntries(new FormData(form));
                void action(async () => {
                  await createLink('/api/admin/invites', data);
                  form.reset();
                  await loadUsers();
                });
              }}
            >
              <label>
                Name
                <input name="name" required maxLength={100} autoComplete="off" />
              </label>
              <label>
                Email
                <input name="email" type="email" required maxLength={254} autoComplete="off" />
              </label>
              <label>
                Role
                <select name="role" aria-label="Role">
                  <option value="viewer">Viewer</option>
                  <option value="admin">Site admin</option>
                </select>
              </label>
              <button className="primary-button" disabled={busy}>
                <Plus size={16} />
                Create invite
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
