import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './app.css';
import './neon.css';
import { creatorKey, prefs } from './prefs';
import { setDesign } from './game/render';

creatorKey.captureFromUrl();

// The skin is presentation only: one attribute for CSS, one flag for the canvas code.
const applyDesign = () => {
  const d = prefs.get().design;
  document.documentElement.dataset.design = d;
  setDesign(d);
};
applyDesign();
prefs.subscribe(applyDesign);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
