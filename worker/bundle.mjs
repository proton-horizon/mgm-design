export const MAX_FILES = 300;
export const MAX_BYTES = 20 * 1024 * 1024;
export const MIME_TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  txt: 'text/plain; charset=utf-8',
});
export function contentType(path) {
  return MIME_TYPES[path.split('.').pop().toLowerCase()];
}
export function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 240 &&
    /^[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.')) &&
    Boolean(contentType(path))
  );
}
function text(value, max = 100) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function id(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}
function keys(value, allowed, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(`Unknown or invalid fields in ${label}.`);
}
export function validateManifest(manifest, projectId) {
  if (!manifest || manifest.schemaVersion !== 1)
    throw new Error('Unsupported manifest schemaVersion; expected 1.');
  keys(manifest, ['schemaVersion', 'project', 'boards', 'files', 'empty'], 'manifest');
  keys(manifest.project, ['id', 'name'], 'project');
  if (
    !manifest.project ||
    !id(manifest.project.id) ||
    manifest.project.id !== projectId ||
    !text(manifest.project.name)
  )
    throw new Error('Manifest project must match the registered project.');
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length > MAX_FILES ||
    manifest.files.some((path) => !safePath(path)) ||
    new Set(manifest.files).size !== manifest.files.length
  )
    throw new Error('Manifest files must contain unique permitted relative paths (maximum 300).');
  if (!Array.isArray(manifest.boards) || manifest.boards.length > 50)
    throw new Error('Manifest boards must be an array (maximum 50).');
  if (!manifest.boards.length && manifest.empty !== true)
    throw new Error('An empty publication requires empty: true.');
  if (
    manifest.empty !== undefined &&
    (manifest.empty !== true || manifest.boards.length || manifest.files.length)
  )
    throw new Error('empty: true requires boards: [] and files: [].');
  const boards = new Set();
  let frameCount = 0;
  for (const board of manifest.boards) {
    keys(board, ['id', 'name', 'description', 'frames'], 'board');
    if (
      !id(board.id) ||
      boards.has(board.id) ||
      !text(board.name) ||
      (board.description !== undefined && !text(board.description, 1000)) ||
      !Array.isArray(board.frames)
    )
      throw new Error('Invalid or duplicate board.');
    boards.add(board.id);
    const frames = new Set();
    for (const frame of board.frames) {
      keys(frame, ['id', 'name', 'entry', 'preview', 'width', 'height', 'x', 'y'], 'frame');
      if (
        !id(frame.id) ||
        frames.has(frame.id) ||
        !text(frame.name) ||
        !manifest.files.includes(frame.entry) ||
        !frame.entry.endsWith('.html')
      )
        throw new Error('Every frame needs a unique id, name, and listed HTML entry.');
      if (
        frame.preview !== undefined &&
        (typeof frame.preview !== 'string' ||
          !manifest.files.includes(frame.preview) ||
          !/\.(png|jpg|jpeg|webp)$/.test(frame.preview))
      )
        throw new Error('Frame preview must be a listed PNG, JPEG, or WebP image.');
      if (![frame.width, frame.height].every((n) => Number.isInteger(n) && n >= 100 && n <= 4096))
        throw new Error('Frame dimensions must be integers from 100 to 4096.');
      if (
        [frame.x, frame.y].some(
          (n) => n !== undefined && (!Number.isFinite(n) || Math.abs(n) > 100000),
        )
      )
        throw new Error('Frame coordinates must be finite and within 100000.');
      frames.add(frame.id);
      frameCount++;
    }
  }
  if (frameCount > 200) throw new Error('Maximum 200 frames per publication.');
  return manifest;
}
export function decodeBundle(body, projectId) {
  const manifest = validateManifest(body?.manifest, projectId);
  if (
    !body.files ||
    typeof body.files !== 'object' ||
    Array.isArray(body.files) ||
    Object.keys(body.files).length !== manifest.files.length
  )
    throw new Error('Bundle files must exactly match the manifest whitelist.');
  const decoded = [];
  let total = 0;
  for (const path of manifest.files) {
    const value = body.files[path];
    if (
      typeof value !== 'string' ||
      value.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      value.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(value) ||
      (value.includes('=') && !/^={1,2}$/.test(value.slice(value.indexOf('='))))
    )
      throw new Error('Invalid base64 file.');
    let binary;
    try {
      binary = atob(value);
    } catch {
      throw new Error('Invalid base64 file.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Bundle exceeds 20 MiB.');
    decoded.push({ path, bytes, contentType: contentType(path) });
  }
  return { manifest, files: decoded, total };
}
