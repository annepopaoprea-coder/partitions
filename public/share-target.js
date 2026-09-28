// Receives files shared to Partitions from other apps (Android share menu).
// The browser POSTs them here; they wait in a cache until the app picks them
// up, then the app opens on its "add" screen.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.href !== new URL('share-target', self.registration.scope).href) return;
  event.respondWith(
    (async () => {
      const form = await event.request.formData();
      const cache = await caches.open('partitions-inbox');
      const files = form.getAll('files').filter((f) => f && typeof f !== 'string');
      let i = 0;
      for (const file of files) {
        const key = new URL(`inbox/${Date.now()}-${i++}`, self.registration.scope).href;
        await cache.put(
          key,
          new Response(file, {
            headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
          }),
        );
      }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })(),
  );
});
