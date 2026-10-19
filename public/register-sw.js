// En archivo aparte y no inline: la CSP del sitio solo permite scripts propios ('self').
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
