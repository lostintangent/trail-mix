// The reader as the workbench shows it. The commands come with the first screen, and the reader
// and its sanitizer load apart from it.
export { sourceCommand } from './ui/commands.ts';
export { preloadReader, Reader, SourceDialog } from './ui/lazy.ts';
export type { ReaderProps } from './ui/Reader.tsx';
