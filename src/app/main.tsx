import { StartClient } from '@tanstack/react-start/client';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { keepForOffline } from '../features/offline/index.ts';
import { deviceStorage } from '../shared/deviceStorage.ts';

// The browser entry. The document is the prerendered shell, so React adopts it and the router
// renders the app into it.
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});

// The installed app keeps what it needs to open with no network.
keepForOffline();

// The theme follows the system now, so a Light or Dark choice an earlier release saved is forgotten.
deviceStorage().removeItem('trail-mix.theme');
