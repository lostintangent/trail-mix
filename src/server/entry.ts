import start from '@tanstack/react-start/server-entry';

/**
 * The Worker. Files from the build are served before it runs. Everything else reaches TanStack
 * Start: a page request gets the document shell, and server functions run.
 */
export default {
  fetch: (request: Request) => start.fetch(request),
};
