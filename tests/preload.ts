// Vite loads before any test file runs, so before any test compiles StyleX with Babel. Babel then
// installs its own `Error.prepareStackTrace`, after which Bun's `Error.captureStackTrace` rejects
// objects that are not errors (oven-sh/bun#46393). Vite builds some error classes that way as it
// loads, so loading it later fails.
import 'vite';
