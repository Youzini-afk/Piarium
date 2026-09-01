export const renderExtensionRecoveryPage = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Piarium Extension Recovery</title>
  <style>
    :root { color-scheme: dark; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101010; color: #ededed; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #242424 0, #121212 48rem); }
    main { width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 80px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 36px); letter-spacing: -.03em; }
    p { color: #aaa; margin: 8px 0 0; }
    button { font: inherit; color: inherit; border: 1px solid #3a3a3a; background: #252525; border-radius: 10px; padding: 9px 14px; cursor: pointer; }
    button:hover { background: #303030; }
    button:disabled { opacity: .5; cursor: wait; }
    button.danger { border-color: #713b3b; color: #ffb8b8; }
    #status { min-height: 24px; margin: 0 0 16px; color: #aaa; }
    #status.error { color: #ff9494; }
    #status.warning { color: #e9c46a; }
    .card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center; padding: 18px 20px; border: 1px solid #303030; border-radius: 14px; background: rgba(24,24,24,.92); margin-top: 10px; }
    .name { font-weight: 650; overflow-wrap: anywhere; }
    .meta { color: #8f8f8f; font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
    .states { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .pill { border: 1px solid #353535; background: #202020; border-radius: 999px; padding: 2px 8px; color: #aaa; font-size: 12px; }
    .switch { position: relative; width: 46px; height: 26px; border-radius: 999px; padding: 0; background: #353535; border: 0; }
    .switch::after { content: ""; position: absolute; width: 20px; height: 20px; border-radius: 50%; left: 3px; top: 3px; background: #ddd; transition: transform .15s ease; }
    .switch[aria-checked="true"] { background: #4b8f65; }
    .switch[aria-checked="true"]::after { transform: translateX(20px); background: white; }
    .empty { padding: 48px 24px; text-align: center; border: 1px dashed #363636; border-radius: 14px; color: #999; }
    details { margin-top: 18px; color: #aaa; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 14px; background: #181818; border-radius: 10px; }
    @media (max-width: 620px) { header { display: block; } header button { margin-top: 20px; } .card { padding: 16px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Piarium Extension Recovery</h1>
        <p>This host-owned page remains available when the main workbench or an extension cannot start.</p>
      </div>
      <button id="disable-all" class="danger" type="button">Disable all extensions</button>
    </header>
    <div id="status" role="status"></div>
    <section id="extensions" aria-live="polite"></section>
    <details>
      <summary>Catalog diagnostics</summary>
      <pre id="diagnostics">Loading…</pre>
    </details>
  </main>
  <script type="module">
    const list = document.querySelector('#extensions');
    const status = document.querySelector('#status');
    const diagnostics = document.querySelector('#diagnostics');
    const disableAll = document.querySelector('#disable-all');
    let snapshot = null;

    const setStatus = (message, tone = '') => {
      status.textContent = message;
      status.className = tone;
    };
    const request = async (path, options) => {
      const response = await fetch(path, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...options,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message || payload?.error || 'Request failed (' + response.status + ')';
        const error = new Error(message);
        error.conflict = response.status === 409;
        throw error;
      }
      return payload;
    };
    const render = () => {
      list.replaceChildren();
      if (!snapshot || snapshot.extensions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = snapshot?.storageState === 'missing'
          ? 'No Piarium extension catalog has been created on this host.'
          : 'No Piarium extensions are installed on this host.';
        list.append(empty);
      } else {
        for (const extension of snapshot.extensions) {
          const card = document.createElement('article');
          card.className = 'card';
          const body = document.createElement('div');
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = extension.manifest.displayName || extension.manifest.id;
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = extension.manifest.id + ' · ' + extension.manifest.version + ' · ' + extension.source.display;
          const states = document.createElement('div');
          states.className = 'states';
          const desired = document.createElement('span');
          desired.className = 'pill';
          desired.textContent = extension.desired.enabled ? 'enabled policy' : 'disabled policy';
          states.append(desired);
          for (const actual of extension.actual) {
            const pill = document.createElement('span');
            pill.className = 'pill';
            pill.textContent = actual.realmId + ': ' + actual.status;
            states.append(pill);
          }
          body.append(name, meta, states);
          const toggle = document.createElement('button');
          toggle.className = 'switch';
          toggle.type = 'button';
          toggle.setAttribute('role', 'switch');
          toggle.setAttribute('aria-label', 'Enable ' + extension.manifest.id);
          toggle.setAttribute('aria-checked', String(extension.desired.enabled));
          toggle.addEventListener('click', async () => {
            toggle.disabled = true;
            setStatus('Updating ' + extension.manifest.id + '…');
            try {
              const payload = await request('/api/piarium/extensions/v1/extensions/' + encodeURIComponent(extension.manifest.id) + '/enabled', {
                method: 'PATCH',
                body: JSON.stringify({ enabled: !extension.desired.enabled, expectedRevision: snapshot.revision }),
              });
              snapshot = payload.snapshot;
              setStatus('Desired state saved. No extension code is executed by this recovery foundation.');
              render();
            } catch (error) {
              setStatus(error.message, 'error');
              if (error.conflict) await load();
            } finally { toggle.disabled = false; }
          });
          card.append(body, toggle);
          list.append(card);
        }
      }
      disableAll.disabled = !snapshot || !snapshot.extensions.some((extension) => extension.desired.enabled);
      diagnostics.textContent = JSON.stringify({
        hostId: snapshot?.hostId,
        revision: snapshot?.revision,
        authoritative: snapshot?.authoritative,
        storageState: snapshot?.storageState,
        diagnostics: snapshot?.diagnostics,
      }, null, 2);
    };
    const load = async () => {
      setStatus('Loading extension catalog…');
      try {
        const payload = await request('/api/piarium/extensions/v1/catalog');
        if (payload.status !== 'ready') throw new Error(payload.error?.message || 'Catalog unavailable');
        snapshot = payload.snapshot;
        setStatus(snapshot.authoritative ? '' : 'Showing the last valid catalog because current storage could not be read.', snapshot.authoritative ? '' : 'warning');
        render();
      } catch (error) {
        setStatus(error.message, 'error');
        diagnostics.textContent = error.stack || String(error);
      }
    };
    disableAll.addEventListener('click', async () => {
      if (!snapshot) return;
      disableAll.disabled = true;
      setStatus('Disabling all extensions…');
      try {
        const payload = await request('/api/piarium/extensions/v1/disable-all', {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: snapshot.revision }),
        });
        snapshot = payload.snapshot;
        setStatus('All extension desired states are disabled.');
        render();
      } catch (error) {
        setStatus(error.message, 'error');
        if (error.conflict) await load();
      } finally { disableAll.disabled = false; }
    });
    await load();
  </script>
</body>
</html>`;
