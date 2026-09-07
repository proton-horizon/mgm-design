import type { DesignService, Project, Session } from './types';
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login')
    window.dispatchEvent(new Event('mgm-session-expired'));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}). Please try again.`);
  return data as T;
}
export const service: DesignService = {
  session: () => request<Session>('/api/session'),
  projects: async () => (await request<{ projects: Project[] }>('/api/projects')).projects,
  login: (email, password) =>
    request('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request('/api/logout', { method: 'POST', body: '{}' }),
};
