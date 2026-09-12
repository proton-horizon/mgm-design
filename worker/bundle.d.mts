export interface Frame {
  id: string;
  name: string;
  entry: string;
  preview?: string;
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
export interface Manifest {
  schemaVersion: 1;
  project: { id: string; name: string };
  boards: Board[];
  files: string[];
  empty?: boolean;
}
export const MAX_FILES: number;
export const MAX_BYTES: number;
export function contentType(path: string): string | undefined;
export function safePath(path: unknown): boolean;
export function validateManifest(manifest: unknown, projectId: string): Manifest;
export function decodeBundle(
  body: unknown,
  projectId: string,
): {
  manifest: Manifest;
  files: { path: string; bytes: Uint8Array; contentType: string }[];
  total: number;
};
