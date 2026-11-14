// The Mailroom checks folder changes by these rules, from here rather than the browser's index.
export {
  canHoldFolders,
  childPath,
  inside,
  isOwn,
  placeOf,
  renamedPath,
  type Place,
} from './names.ts';
export { createProblem, deleteProblem, nameProblem, renameProblem } from './problems.ts';
export { changed, followed, isShown, standing, type FolderChange } from './changes.ts';
export { deleteSaid, whatGoes } from './question.ts';
