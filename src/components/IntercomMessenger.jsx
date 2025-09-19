import { useEffect } from 'react';

function bootIntercom(user) {
if (typeof window === 'undefined') return;

// injecte le script si absent
if (!window.Intercom) {
(function () {
const w = window; const ic = w.Intercom;
if (typeof ic === 'function') { ic('reattach_activator'); ic('update', {}); return; }
const d = document; const i = function () { i.c(arguments); };
i.q = []; i.c = function (args) { i.q.push(args); }; w.Intercom = i;
const l = function () {
const s = d.createElement('script');
s.type = 'text/javascript'; s.async = true;
s.src = 'https://widget.intercom.io/widget/' + process.env.REACT_APP_INTERCOM_APP_ID;
const x = d.getElementsByTagName('script')[0]; x.parentNode.insertBefore(s, x);
};
if (d.readyState === 'complete') l();
else if (w.attachEvent) w.attachEvent('onload', l);
else w.addEventListener('load', l, false);
})();
}

const payload = { app_id: process.env.REACT_APP_INTERCOM_APP_ID };

if (user && user.id) {
payload.user_id = user.id;
payload.name = user.name;
payload.email = user.email;
payload.created_at = user.createdAt ? Math.floor(new Date(user.createdAt).getTime() / 1000) : undefined;
if (user.user_hash) payload.user_hash = user.user_hash; // Secure mode (optionnel)
}

window.Intercom('boot', payload);
}

export default function IntercomMessenger({ user }) {
useEffect(() => {
if (typeof window === 'undefined') return;
bootIntercom(user);
return () => { if (window.Intercom) window.Intercom('shutdown'); };
}, [user?.id, user?.email, user?.user_hash]);

return null; // widget = rien à rendre
}
