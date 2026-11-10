/**
 * How long the member stays before the reader takes it that they mean to read. While keys move the
 * selection quicker than this, the reader waits for it to rest before following it, and the rest
 * of long mail is written only once its start has been shown this long, so mail passed by costs
 * only what showed.
 */
export const REST_MS = 150;
