import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

const host = document.getElementById('root');
if (!host) throw new Error('no #root');

// StrictMode on purpose: it mounts, unmounts and remounts every effect, which
// is exactly the double-attach that a binding to imperative listeners has to
// survive. If the hooks leaked a listener or a renderer, this is where it
// would show.
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
