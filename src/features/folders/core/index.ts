// The Mailroom checks folder changes by these rules, from here rather than the browser's index.
export {
  canHoldFolders,
  childPath,
  inside,
  isOwn,
  placeOf,
  renamedPath,
  whatGoes,
  type Place,
} from './names.ts';
export { createProblem, deleteProblem, nameProblem, renameProblem } from './problems.ts';
export { changed, followed, isShown, type FolderChange } from './changes.ts';
export { deleteSaid } from './question.ts';
