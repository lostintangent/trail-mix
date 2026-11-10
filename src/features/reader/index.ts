// The reader as the workbench shows it. The commands come with the first screen, and the reader
// and its sanitizer load apart from it.
export { REST_MS } from './core/rest.ts';
export { sourceCommand } from './ui/commands.ts';
export { preloadReader, Reader, SourceDialog } from './ui/lazy.ts';
export type { ReaderProps } from './ui/Reader.tsx';
