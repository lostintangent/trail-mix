import type { Folder } from '../src/features/mail/core/index.ts';

/** An empty folder of `personal`, whose name and parent are read from a path `/` delimits. */
export function folder(path: string, extra: Partial<Folder> = {}): Folder {
  const at = path.lastIndexOf('/');
  return {
    account: 'personal',
    path,
    name: path.slice(at + 1),
    ...(at >= 0 ? { parent: path.slice(0, at) } : {}),
    delimiter: '/',
    unread: 0,
    total: 0,
    ...extra,
  };
}
