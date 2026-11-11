import type { Page } from 'playwright';

/**
 * Waits until the mail a page shows is in: the page has caught up with its Mailroom, and no account
 * is being checked, as the sidebar tells assistive technology by no longer being busy.
 */
export function mailIsIn(page: Page, timeout = 30_000): Promise<void> {
  return page
    .locator('nav[aria-label="Mailboxes"][aria-busy="false"]')
    .waitFor({ state: 'attached', timeout });
}
