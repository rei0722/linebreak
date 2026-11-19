import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './app.css';
import './neon.css';
import { creatorKey, prefs } from './prefs';
import { setDesign } from './game/render';
import { claimTipFromUrl } from './net/site';
import { toast } from './ui';

creatorKey.captureFromUrl();

// Back from Stripe's payment page: turn the paid session into the supporter name tag.
void claimTipFromUrl().then((r) => {
  if (r === 'thanks') toast('応援ありがとうございます！対戦ロビーで赤いネームタグが付きます');
  else if (r === 'failed') toast('支払いを確認できませんでした。時間をおいてページを再読み込みしてください');
});

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
