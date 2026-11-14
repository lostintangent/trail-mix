import { durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo, Suspense, type ReactNode } from 'react';
import { media } from '../../../app/theme/tokens.stylex.ts';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import type { Foldable } from './folds.ts';
import { NameField } from './lazy.ts';
import { folderName } from './name.ts';
import {
  accountLine,
  folderLine,
  folderTree,
  newFolderAt,
  type FolderNode,
  type TreeState,
} from './tree.ts';
import { AccountLine, FolderLine, FolderSkeletons, ViewLine } from './TreeLine.tsx';
import { UNIFIED_VIEWS, type ViewCounts } from './views.ts';

/**
 * The sidebar's tree: the unified views, then each account under its stamp, with its folders.
 * Accounts and folders with folders inside fold away under a chevron, and a folder being named
 * shows its name in a field in its line's place. `tree.ts` works out what each line shows, and
 * `TreeLine.tsx` draws it.
 */

/** The views that gather mail across every account, at the top of the tree. */
export const ViewRows = memo(function ViewRows({
  view,
  isViewHere,
  counts,
  onSelect,
}: {
  view: View;
  /** Whether a line of the tree lifts for the view. When none does, the first is its Tab stop. */
  isViewHere: boolean;
  counts: ViewCounts;
  onSelect: (view: View) => void;
}) {
  return (
    <ul {...stylex.props(styles.rows)}>
      {UNIFIED_VIEWS.map((unified, at) => (
        <li key={unified.in}>
          <ViewLine
            unified={unified}
            count={counts[unified.in]}
            isSelected={view.in === unified.in}
            isStop={view.in === unified.in || (!isViewHere && at === 0)}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
});

/**
 * An account: its stamp and name, which fold its folders away and back, with its menu at the end.
 * Folded, it shows the unread mail in its folders.
 */
export const AccountSection = memo(function AccountSection({
  account,
  folders,
  view,
  onSelect,
  folds,
  onFold,
  editing,
  onEdited,
  folderActions,
  accountActions,
}: {
  account: Account;
  folders: readonly Folder[];
  view: View;
  onSelect: (view: View) => void;
  folds: ReadonlySet<string>;
  onFold: (what: Foldable) => void;
  editing: FolderEdit | undefined;
  onEdited: (name: string | undefined) => void;
  folderActions: (folder: Folder) => readonly Command[];
  accountActions: (account: Account) => readonly Command[];
}) {
  const own = folders.filter((folder) => folder.account === account.id);
  const nodes = folderTree(own);
  const state = { view, folds, editing };
  const { isListing, ...line } = accountLine(account, nodes, state);
  return (
    <section aria-label={account.name} {...stylex.props(styles.account)}>
      <AccountLine {...line} account={account} onFold={onFold} accountActions={accountActions} />
      <Folding isOpen={line.isOpen}>
        {isListing && <FolderSkeletons account={account} />}
        <FolderRows
          nodes={nodes}
          depth={0}
          state={state}
          onSelect={onSelect}
          onFold={onFold}
          folders={own}
          onEdited={onEdited}
          folderActions={folderActions}
          account={account}
        />
      </Folding>
    </section>
  );
});

/**
 * An account's folders, each one followed by the folders inside it, a step further in. A folder
 * being renamed shows its name in a field, and a new one's field leads the folders it will join.
 */
function FolderRows({
  nodes,
  depth,
  state,
  onSelect,
  onFold,
  folders,
  onEdited,
  folderActions,
  account,
  parent,
}: {
  nodes: FolderNode[];
  depth: number;
  state: TreeState;
  onSelect: (view: View) => void;
  onFold: (what: Foldable) => void;
  /** The account's folders, whose names a new name can't take beside them. */
  folders: readonly Folder[];
  onEdited: (name: string | undefined) => void;
  folderActions: (folder: Folder) => readonly Command[];
  account: Account;
  /** The folder these sit inside, if any. */
  parent?: Folder;
}) {
  const row = (node: FolderNode) => {
    const { folder, children } = node;
    const { isRenaming, isNamingInside, ...line } = folderLine(node, state);
    return (
      <li key={folder.path}>
        {isRenaming ? (
          <Suspense>
            <NameField
              label={`New name for ${folderName(folder)}`}
              initial={folder.name}
              depth={depth}
              place={{
                folders,
                parent: folder.parent,
                delimiter: folder.delimiter,
                renaming: folder,
              }}
              onDone={onEdited}
            />
          </Suspense>
        ) : (
          <FolderLine
            {...line}
            folder={folder}
            depth={depth}
            onSelect={onSelect}
            onFold={onFold}
            folderActions={folderActions}
          />
        )}
        {(line.canFold || isNamingInside) && (
          <Folding isOpen={line.isOpen}>
            <FolderRows
              nodes={children}
              depth={depth + 1}
              state={state}
              onSelect={onSelect}
              onFold={onFold}
              folders={folders}
              onEdited={onEdited}
              folderActions={folderActions}
              account={account}
              parent={folder}
            />
          </Folding>
        )}
      </li>
    );
  };
  // One list of keyed lines, so a line keeps its place as the new folder's field comes and goes.
  const lines = nodes.map(row);
  const fieldAt = newFolderAt(nodes, state.editing, account.id, parent);
  if (fieldAt !== undefined) {
    lines.splice(
      fieldAt,
      0,
      <li key="new folder">
        <Suspense>
          <NameField
            label={`Name of the new folder in ${parent ? folderName(parent) : account.name}`}
            depth={depth}
            place={{ folders, parent: parent?.path, delimiter: parent?.delimiter }}
            onDone={onEdited}
          />
        </Suspense>
      </li>,
    );
  }
  return <ul {...stylex.props(styles.rows, depth > 0 && styles.inside)}>{lines}</ul>;
}

/** What folds away under a line, which slides shut and opens again. */
function Folding({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!isOpen || undefined}
      inert={!isOpen}
      {...stylex.props(styles.folding, !isOpen && styles.folded)}
    >
      <div {...stylex.props(styles.foldingInner)}>{children}</div>
    </div>
  );
}

const styles = stylex.create({
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-0-5'],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  inside: {
    marginTop: spacingVars['--spacing-0-5'],
  },
  // Folding slides what's inside shut by its own height, and keeps room for a lifted row's edge.
  folding: {
    display: 'grid',
    gridTemplateRows: '1fr',
    transitionProperty: 'grid-template-rows',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
  folded: {
    gridTemplateRows: '0fr',
  },
  foldingInner: {
    minHeight: 0,
    overflow: 'hidden',
    padding: '1px',
    margin: '-1px',
  },
  account: {
    marginTop: spacingVars['--spacing-3'],
  },
});
