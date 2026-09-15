// Service worker mínimo — permite que el navegador ofrezca "Agregar a
// pantalla de inicio" / "Instalar app" y que la app abra como app real
// (sin barra de direcciones) en vez de como una pestaña de navegador.
const CACHE_NAME = "quiz-hijo-v1";
const FILES_TO_CACHE = ["index.html", "configuracion.html", "hijo.html", "style.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Estrategia simple: intenta la red primero (para tener siempre lo último),
// y si falla (sin internet), usa la copia guardada.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
