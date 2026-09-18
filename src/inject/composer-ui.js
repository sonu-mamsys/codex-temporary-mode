// Injected into the supported renderer; all host dependencies are passed explicitly.
function tempCodexComposer(props, { React, jsx, Original, context, readMode, writeMode }) {
  const info = context();
  const [mode, setMode] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const mounted = React.useRef(false);
  const changing = React.useRef(false);
  const revision = React.useRef(0);
  React.useEffect(() => {
    mounted.current = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      const requestedRevision = revision.current;
      try {
        const result = await readMode();
        if (mounted.current && current === generation && requestedRevision === revision.current && !changing.current) setMode(result.enabled === true);
      } catch { /* Keep the control disabled until the host confirms its setting. */ }
    };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => { mounted.current = false; generation++; window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, []);
  const isNew = info.kind === 'new';
  const supported = (isNew || info.kind === 'local') && info.hostId === 'local';
  const active = supported && (isNew ? mode === true : info.ephemeral === true);
  const change = async () => {
    if (!isNew || mode === null || changing.current) return;
    changing.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      info.clearPrewarmed();
      const result = await writeMode(!mode);
      info.clearPrewarmed();
      if (mounted.current) setMode(result.enabled === true);
    } catch {
      if (mounted.current) setError('Could not change temporary mode. Please try again.');
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!supported) return jsx(Original, props);
  const control = isNew ? jsx('button', {
    type: 'button', role: 'switch', 'aria-label': 'Temporary chat', 'aria-checked': active,
    disabled: busy || mode === null, onClick: change,
    title: 'New temporary chats are excluded from history. File edits still apply.',
    style: { display: 'inline-flex', alignItems: 'center', gap: 7, cursor: busy ? 'wait' : 'pointer', color: 'inherit', background: 'transparent', border: 0, padding: '2px 0', font: 'inherit' },
    children: [jsx('span', { 'aria-hidden': true, style: { display: 'inline-flex', width: 25, height: 14, padding: 2, borderRadius: 12, background: active ? '#8b5cf6' : 'var(--vscode-descriptionForeground, #777)', justifyContent: active ? 'flex-end' : 'flex-start' }, children: jsx('span', { style: { width: 10, height: 10, borderRadius: '50%', background: '#fff' } }) }), busy ? 'Updating…' : 'Temporary']
  }) : active ? jsx('span', { title: 'This chat is temporary and excluded from history.', children: '◌ Temporary chat' }) : null;
  const row = control && jsx('div', { style: { display: 'flex', padding: '8px 12px 2px', fontSize: 12, color: 'var(--vscode-foreground, inherit)' }, children: control });
  return jsx('div', {
    'data-temp-codex-active': active ? 'true' : 'false',
    style: { borderRadius: 20, background: active ? 'rgba(139,92,246,0.10)' : undefined, boxShadow: active ? '0 0 0 1px rgba(139,92,246,0.45)' : undefined },
    children: [jsx('style', { children: '[data-temp-codex-active="true"] [data-composer-surface-variant]{background:rgba(139,92,246,0.09)!important} [data-temp-codex-active] button:focus-visible{outline:2px solid var(--vscode-focusBorder,#a78bfa);outline-offset:3px}' }),
      jsx(Original, { ...props, inert: props.inert || busy, children: [row, error && jsx('div', { role: 'alert', style: { padding: '4px 12px', fontSize: 12 }, children: error }), props.children] })]
  });
}
