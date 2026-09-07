export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'viewer';
  disabled?: boolean;
}
export interface Frame {
  id: string;
  name: string;
  entry: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}
export interface Board {
  id: string;
  name: string;
  description?: string;
  frames: Frame[];
}
export interface Project {
  id: string;
  name: string;
  description?: string;
  boards: Board[];
  publication?: {
    status: string;
    createdAt: string;
    commit?: string;
    runUrl?: string;
    message?: string;
  };
}
export interface Session {
  user: User | null;
  setupRequired: boolean;
  siteName: string;
}
/** Site access is replaceable; UI never reads hosting credentials or storage bindings. */
export interface DesignService {
  session(): Promise<Session>;
  projects(): Promise<Project[]>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}
