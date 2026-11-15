import { createContext } from 'react';

/**
 * The accent the page shows, which the links in a message take. A message's frame reads the color
 * from the page itself, so this only tells it when to read again, and the page shows a new accent
 * before it comes here.
 */
export const MessageAccent = createContext<string | undefined>(undefined);
