import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './Landing';
import { Portal } from './portal/Portal';
import { useHash } from './ui';
import './styles.css';

/** Rutas con hash: "#/..." es la portada (y sus secciones); "#/app/..." es el portal. */
function Root() {
  const hash = useHash();
  if (hash === '/app' || hash.startsWith('/app/') || hash.startsWith('/app?')) return <Portal path={hash} />;
  return <Landing section={hash.replace(/^\//, '').split(/[/?]/)[0]} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
