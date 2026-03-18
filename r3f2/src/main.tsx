import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Global styles
const style = document.createElement('style');
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #root {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #000;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  }
  canvas { display: block; }
`;
document.head.appendChild(style);

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
