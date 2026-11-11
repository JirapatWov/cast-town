// The chat's way into the built-in viewer: paths a person writes resolve against its folder (its job's own copy,
// else the house), and open in the viewer. Passed to transcript views as ItemViewContext.files.
import type { ImageRef } from '../../../shared/protocol';
import { cachedFileUrl, fileUrlOf } from '../net/files';
import { personRoots, resolvePath, type FileRef } from './file-paths';
import { openFile, openUpload } from './file-viewer';
import type { MdFiles } from './markdown';
import type { Shell } from './shell';

export interface FileLinks extends MdFiles {
  /** An image file's URL (asks for the folder's key when it isn't known yet). */
  src(ref: FileRef): Promise<string>;
  open(ref: FileRef): void;
  /** A chat image (an upload: sent by the user, or produced by a tool) in the viewer. */
  openUpload(ref: ImageRef, label?: string): void;
}

/** Links for one person's chat (agentId: whose folder relative paths are in). */
export function fileLinks(shell: Shell, agentId: string): FileLinks {
  const { store } = shell;
  const roots = () => personRoots(store.state.agents[agentId], (id) => store.project(id), (p, j) => store.job(p, j));
  return {
    resolve: (raw) => resolvePath(raw, roots()),
    srcNow: (ref) => cachedFileUrl(ref.folder, ref.path),
    src: (ref) => fileUrlOf(store, ref.folder, ref.path),
    open: (ref) => openFile(shell, ref),
    openUpload: (ref, label) => openUpload(shell, ref, label),
  };
}
