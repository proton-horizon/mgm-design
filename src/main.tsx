import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
// Fragments are never sent to the server. Remove the bearer link from browser history before rendering.
const accountToken = new URLSearchParams(location.hash.slice(1)).get('account') || '';
if (accountToken) history.replaceState(null, '', location.pathname + location.search);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App initialAccountToken={accountToken} />
  </React.StrictMode>,
);
