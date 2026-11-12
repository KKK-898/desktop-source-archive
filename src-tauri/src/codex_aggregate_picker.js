// Decorate Codex's native model rows. Codex alone owns selection and persistence.
// 26.1103: ModelList > Item(role=menuitemradio, aria-checked,
// data-model-selected); the complete model ID is the Item's React key.
function installGaogeAggregateNativePicker(catalog, options = {}) {
  const win = options.window || window;
  const doc = win.document;
  const revision = Number(options.revision || 21);
  const marker = 'gaoge-native-picker-v2';
  const styleId = 'gaoge-aggregate-native-picker-style';
  const diagnosticKey = 'gaoge.aggregate.picker-diagnostic';
  const bridgeBase = String(options.bridgeBase || '');
  const bridgeToken = String(options.bridgeToken || '');
  const stable = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  };
  const signature = stable(catalog || {});
  const previous = win.__gaogeAggregateModelPickerRuntime;
  if (previous?.implementation === marker && previous.matches(revision, signature, bridgeBase, bridgeToken)) {
    return { ...previous.status(), reused: true };
  }
  try { previous?.dispose?.(); } catch (_) {}
  // Only upgrade-time cleanup. Never destroy a live selection on a same-catalog reinjection.
  for (const id of ['gaoge-aggregate-model-picker-style', 'gaoge-aggregate-model-picker',
    'gaoge-aggregate-model-trigger', 'gaoge-aggregate-speed-row', 'gaoge-aggregate-speed-popup', styleId]) {
    doc.getElementById(id)?.remove();
  }
  doc.querySelectorAll('.gaoge-aggregate-native-badge').forEach(node => node.remove());
  doc.querySelectorAll('[data-gaoge-aggregate-picker],.gaoge-aggregate-native-hidden,.gaoge-aggregate-native-model-hidden').forEach(node => {
    node.removeAttribute('data-gaoge-aggregate-picker');
    node.classList.remove('gaoge-aggregate-native-hidden', 'gaoge-aggregate-native-model-hidden');
  });

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const routes = [];
  for (const provider of Array.isArray(catalog?.providers) ? catalog.providers : []) {
    if (provider?.enabled === false) continue;
    for (const group of Array.isArray(provider?.groups) ? provider.groups : []) {
      if (group?.enabled === false) continue;
      for (const model of Array.isArray(group?.models) ? group.models : []) {
        if (model?.enabled === false || !model?.publicModel) continue;
        const source = (model.source || group.source || provider.source) === 'custom' ? 'custom' : 'builtin';
        const providerId = String(model.providerId || group.providerId || provider.id || '');
        const groupId = String(model.groupId || group.id || '');
        const providerName = String(model.providerName || provider.label || provider.name || providerId);
        const vendorId = String(model.vendorId || group.vendorId || provider.vendorId || providerId);
        const vendorLabel = String(model.vendorLabel || group.vendorLabel || provider.vendorLabel || providerName);
        routes.push({ id: String(model.publicModel), source, providerId, groupId,
          providerKey: source + ':' + providerId, groupKey: source + ':' + providerId + ':' + groupId,
          // Vendor filtering never changes the full model/route identity. Several
          // user-owned endpoints may serve the same vendor under different keys.
          filterProviderKey: source + ':' + (source === 'custom' ? vendorId : providerId),
          providerName: source === 'custom' ? vendorLabel : providerName,
          groupName: String(model.groupName || group.name || groupId), model,
          label: normalize(model.nativeLabel || ''),
          search: normalize([model.nativeLabel, model.upstreamModel, model.publicModel,
            vendorId, vendorLabel, model.providerName, provider.label, provider.name, model.groupName, group.name].filter(Boolean).join(' ')) });
      }
    }
  }
  const enabled = catalog?.enabled === true && routes.length > 0;
  const duplicateIds = new Set();
  const byId = new Map();
  const byLabel = new Map();
  for (const route of routes) {
    if (byId.has(route.id)) duplicateIds.add(route.id);
    else byId.set(route.id, route);
    if (route.label) {
      const list = byLabel.get(route.label) || [];
      list.push(route); byLabel.set(route.label, list);
    }
  }
  for (const id of duplicateIds) byId.delete(id);
  const menuSelector = '[role="menu"],[role="listbox"],[data-radix-menu-content],[data-model-picker-view]';
  const rowSelector = '[role="menuitemradio"],[role="option"],[role="menuitem"]';
  const triggerSelector = '[data-composer-navigation-target="reasoning"],[data-codex-intelligence-trigger="true"]';
  const routeAttributes = ['data-model', 'data-model-id', 'data-public-model', 'data-gaoge-aggregate-public-model', 'data-value'];
  const controllers = new Map();
  const portalObservers = new Map();
  const touchedRows = new Map();
  const history = [];
  const stats = { scans: 0, reconciles: 0, diagnosticWrites: 0 };
  const selectedDefault = byId.get(String(catalog?.defaultModel || ''));
  const filters = { source: selectedDefault?.source || (routes.some(route => route.source === 'builtin') ? 'builtin' : 'custom'),
    provider: '', group: '', query: '' };
  let disposed = false, scanTimer = 0, diagnosticTimer = 0, pendingTimer = 0;
  let pending = null, observedModel = '', lastDiagnostic = null;
  let style = null, bodyObserver = null;
  const isElement = node => node instanceof win.HTMLElement;
  const visible = node => isElement(node) && node.isConnected
    && !node.closest('[hidden],[inert],[aria-hidden="true"],[data-state="closed"]')
    && win.getComputedStyle(node).display !== 'none' && win.getComputedStyle(node).visibility !== 'hidden'
    && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  const disabled = row => row.matches(':disabled,[disabled],[aria-disabled="true"],[data-disabled]');

  function diagnostic(event, detail = {}) {
    if (disposed) return;
    const entry = { event, at: Date.now(), ...detail };
    const last = history[history.length - 1];
    if (last && last.event === event && stable({ ...last, at: 0 }) === stable({ ...entry, at: 0 })) return;
    history.push(entry); if (history.length > 24) history.shift();
    lastDiagnostic = entry;
    if (!diagnosticTimer) diagnosticTimer = win.setTimeout(() => {
      diagnosticTimer = 0;
      if (disposed) return;
      try {
        win.localStorage.setItem(diagnosticKey, JSON.stringify({ version: revision, enabled,
          ...lastDiagnostic, selectedModel: observedModel, pendingModel: pending?.id || '',
          providerCount: new Set(routes.map(route => route.providerKey)).size,
          groupCount: new Set(routes.map(route => route.groupKey)).size, modelCount: routes.length,
          history: history.slice() }));
        stats.diagnosticWrites++;
      } catch (_) {}
    }, Math.max(100, Number(options.diagnosticDelay || 500)));
  }

  function routeFromRow(row) {
    if (!isElement(row) || row.closest('[data-gaoge-aggregate-toolbar]')) return null;
    const explicit = new Set();
    let authoritativeId = false, unknownId = false;
    for (const name of routeAttributes) {
      const id = row.getAttribute(name);
      if (id && name !== 'data-value') { authoritativeId = true; if (!byId.has(id)) unknownId = true; }
      if (byId.has(id)) explicit.add(id);
    }
    if (authoritativeId || explicit.size) return !unknownId && explicit.size === 1 ? byId.get(explicit.values().next().value) : null;
    // Read-only row identity, bounded at the next DOM ancestor. Never invoke any
    // React callback, access a composer/store, or infer an ID from a model slug.
    const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
    let fiber = fiberKey ? row[fiberKey] : null;
    const seen = new Set();
    for (let depth = 0; fiber && depth < 64 && !seen.has(fiber); depth++, fiber = fiber.return) {
      seen.add(fiber);
      if (depth && isElement(fiber.stateNode) && fiber.stateNode !== row) break;
      const props = fiber.memoizedProps;
      const ids = [fiber.key, props?.['data-model'], props?.['data-model-id'],
        props?.gaoge_aggregate_public_model, props?.model?.gaoge_aggregate_public_model,
        typeof props?.model === 'string' ? props.model : props?.model?.model];
      const matches = new Set(ids.filter(id => typeof id === 'string' && byId.has(id)));
      if (matches.size) return matches.size === 1 ? byId.get(matches.values().next().value) : null;
    }
    const labels = new Set([normalize(row.getAttribute('aria-label')), normalize(row.textContent)]);
    row.querySelectorAll(':scope > span,:scope > div > span,[data-model-label]').forEach(node => labels.add(normalize(node.textContent)));
    const matches = new Map();
    for (const label of labels) {
      const choices = byLabel.get(label);
      if (choices?.length > 1) return null;
      if (choices?.length === 1 && byId.has(choices[0].id)) matches.set(choices[0].id, choices[0]);
    }
    return matches.size === 1 ? matches.values().next().value : null;
  }

  function restoreRow(row) {
    const original = touchedRows.get(row);
    if (!original) return;
    for (const [attribute, value] of Object.entries(original)) {
      if (value === null) row.removeAttribute(attribute); else row.setAttribute(attribute, value);
    }
    touchedRows.delete(row);
  }
  function setFiltered(row, hide) {
    if (hide) {
      if (!touchedRows.has(row)) touchedRows.set(row, {
        'data-gaoge-aggregate-filtered': row.getAttribute('data-gaoge-aggregate-filtered'),
        hidden: row.getAttribute('hidden'),
      });
      if (row.getAttribute('data-gaoge-aggregate-filtered') !== 'true') row.setAttribute('data-gaoge-aggregate-filtered', 'true');
      // Native 26.1103 keyboard navigation excludes hidden/inert rows, but does
      // not exclude display:none. Use its own visibility contract as well.
      if (!row.hasAttribute('hidden')) row.setAttribute('hidden', '');
    } else restoreRow(row);
  }
  function matchesFilters(route) {
    return route.source === filters.source && (!filters.provider || route.filterProviderKey === filters.provider)
      && (filters.source === 'custom' || !filters.group || route.groupKey === filters.group)
      && (!filters.query || route.search.includes(normalize(filters.query)));
  }
  function nativeSelected(row) {
    return row.getAttribute('aria-checked') === 'true' || row.getAttribute('aria-selected') === 'true'
      || row.getAttribute('data-model-selected') === 'true';
  }
  function observeSelection() {
    const chosen = new Set();
    for (const controller of controllers.values()) {
      // Native selection returns the picker to its simple view. The advanced
      // list becomes inert but its native checked state still identifies the
      // chosen model. A closed/detached menu is not fresh evidence.
      if (!controller.root.isConnected || controller.root.closest('[hidden],[aria-hidden="true"],[data-state="closed"]')) continue;
      for (const [row, route] of controller.rows) if (row.isConnected && nativeSelected(row)) chosen.add(route.id);
    }
    if (chosen.size !== 1) return;
    const id = chosen.values().next().value;
    if (observedModel !== id || pending?.id === id) {
      observedModel = id;
      const selectedRoute = byId.get(id);
      if (selectedRoute && selectedRoute.source !== filters.source) {
        filters.source = selectedRoute.source; filters.provider = ''; filters.group = ''; applyFilters();
      }
      if (pending?.id === id) {
        win.clearTimeout(pendingTimer); pendingTimer = 0; pending = null;
      }
      // This is only native UI evidence, never an invented persistence ACK.
      diagnostic('native-selection-observed', { publicModel: id, evidence: 'native-row-selected', persisted: 'unknown' });
    }
  }
  function requestObserved(row, route) {
    if (disabled(row) || !visible(row) || row.getAttribute('data-gaoge-aggregate-filtered') === 'true') return false;
    win.clearTimeout(pendingTimer);
    pending = { id: route.id, at: Date.now() };
    diagnostic('native-selection-requested', { publicModel: route.id });
    pendingTimer = win.setTimeout(() => {
      if (!pending || disposed) return;
      const id = pending.id; pending = null; pendingTimer = 0;
      diagnostic('native-selection-unconfirmed', { publicModel: id, reason: 'no-native-selected-evidence' });
    }, Math.max(200, Number(options.confirmationTimeout || 8000)));
    return true;
  }
  function selectModel(id) {
    const route = byId.get(String(id));
    if (!route) return { requested: false, confirmed: false, reason: 'unknown-or-ambiguous-model' };
    for (const controller of controllers.values()) for (const [row, item] of controller.rows) {
      if (item.id !== route.id || !visible(row) || row.getAttribute('data-gaoge-aggregate-filtered') === 'true') continue;
      if (disabled(row)) return { requested: false, confirmed: false, reason: 'native-model-disabled' };
      row.click();
      return { requested: true, confirmed: false };
    }
    diagnostic('native-model-missing', { publicModel: route.id });
    return { requested: false, confirmed: false, reason: 'native-model-missing' };
  }

  function element(tag, props = {}) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    return node;
  }
  function setOptions(select, choices, value) {
    const key = stable(choices);
    if (select.__gaogeChoices !== key) {
      select.replaceChildren(...choices.map(([id, name]) => element('option', { value: id, text: name })));
      select.__gaogeChoices = key;
    }
    if (select.value !== value) select.value = value;
  }
  function updateControls(controller) {
    const available = routes.filter(route => route.source === filters.source);
    const providers = new Map(available.map(route => [route.filterProviderKey, route.providerName]));
    if (filters.provider && !providers.has(filters.provider)) filters.provider = '';
    const custom = filters.source === 'custom';
    const groups = new Map((custom ? [] : available).filter(route => !filters.provider || route.filterProviderKey === filters.provider)
      .map(route => [route.groupKey, route.groupName]));
    if (custom || (filters.group && !groups.has(filters.group))) filters.group = '';
    controller.group.hidden = custom;
    controller.group.disabled = custom;
    for (const button of controller.sourceButtons) {
      const selected = button.dataset.source === filters.source;
      if (button.getAttribute('aria-pressed') !== String(selected)) button.setAttribute('aria-pressed', String(selected));
    }
    setOptions(controller.provider, [['', '全部供应商'], ...providers], filters.provider);
    setOptions(controller.group, [['', '全部账号分组'], ...groups], filters.group);
    if (controller.search.value !== filters.query) controller.search.value = filters.query;
    return available;
  }
  function emptyMessage(available) {
    if (!available.length) return filters.source === 'custom' ? '尚未添加自有供应商' : '暂无内置聚合模型';
    if (!available.some(matchesFilters)) return '没有匹配的模型';
    return '已配置模型尚未出现在列表中，请重新打开菜单';
  }
  function applyFilters() {
    for (const controller of controllers.values()) {
      if (!controller.toolbar?.isConnected) continue;
      const available = updateControls(controller);
      let count = 0;
      for (const [row, route] of controller.rows) {
        const show = matchesFilters(route); setFiltered(row, !show); if (show) count++;
      }
      const message = count ? '' : emptyMessage(available);
      if (controller.empty.textContent !== message) controller.empty.textContent = message;
    }
  }
  function createControls(controller, parent, before) {
    const toolbar = element('div', { 'data-gaoge-aggregate-toolbar': '', role: 'group', 'aria-label': '聚合模型筛选' });
    const tabs = element('div', { class: 'gaoge-aggregate-sources' });
    const sourceButtons = [['builtin', '内置聚合'], ['custom', '自有聚合']].map(([source, name]) => {
      const button = element('button', { type: 'button', 'data-source': source, text: name, 'aria-pressed': 'false' });
      button.addEventListener('click', () => { filters.source = source; filters.provider = ''; filters.group = ''; applyFilters(); });
      tabs.appendChild(button); return button;
    });
    const search = element('input', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索聚合模型', autocomplete: 'off', spellcheck: 'false' });
    const selects = element('div', { class: 'gaoge-aggregate-selects' });
    const provider = element('select', { 'aria-label': '模型供应商' });
    const group = element('select', { 'aria-label': '账号分组' });
    const empty = element('div', { class: 'gaoge-aggregate-empty', role: 'status' });
    selects.append(provider, group); toolbar.append(tabs, search, selects, empty);
    search.addEventListener('input', () => { filters.query = search.value; applyFilters(); });
    provider.addEventListener('change', () => { filters.provider = provider.value; filters.group = ''; applyFilters(); });
    group.addEventListener('change', () => { filters.group = filters.source === 'builtin' ? group.value : ''; applyFilters(); });
    // Radix typeahead must not consume search/select key input. Escape still
    // bubbles to the native dismiss handler. Arrow keys can enter native rows.
    toolbar.addEventListener('keydown', event => {
      if (event.key === 'Escape') return;
      event.stopPropagation();
      if (event.target === search && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        const rows = Array.from(controller.rows.keys()).filter(row => visible(row) && !disabled(row));
        const next = event.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1];
        if (next) { event.preventDefault(); next.focus({ preventScroll: true }); }
      }
      if (event.target === search && event.key === 'Enter') event.preventDefault();
    });
    for (const name of ['pointerdown', 'click']) toolbar.addEventListener(name, event => event.stopPropagation());
    parent.insertBefore(toolbar, before);
    Object.assign(controller, { toolbar, sourceButtons, search, provider, group, empty });
  }
  function reconcile(controller) {
    if (disposed || !controller.root.isConnected) return;
    stats.reconciles++;
    const rows = new Map();
    for (const row of controller.root.querySelectorAll(rowSelector)) {
      if (row.closest('[data-gaoge-aggregate-toolbar]')) continue;
      const route = routeFromRow(row); if (route) rows.set(row, route);
    }
    for (const old of controller.rows.keys()) if (!rows.has(old)) restoreRow(old);
    controller.rows = rows;
    const first = rows.keys().next().value;
    if (first && (!controller.toolbar || !controller.toolbar.isConnected)) {
      createControls(controller, first.parentElement, first);
    }
    if (controller.toolbar?.isConnected) applyFilters();
    observeSelection();
  }
  function attach(root) {
    if (!isElement(root) || controllers.has(root)) return;
    // Nested model view belongs to an already observed native menu.
    if (Array.from(controllers.keys()).some(parent => parent.contains(root))) return;
    const controller = { root, rows: new Map(), timer: 0, toolbar: null };
    controllers.set(root, controller);
    const schedule = () => {
      if (!disposed && !controller.timer) controller.timer = win.setTimeout(() => {
        controller.timer = 0; reconcile(controller);
      }, 60);
    };
    controller.observer = new win.MutationObserver(records => {
      if (records.some(record => !record.target.closest?.('[data-gaoge-aggregate-toolbar]'))) schedule();
    });
    controller.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['aria-checked', 'aria-selected', 'data-model-selected', 'data-state', 'data-model-picker-view',
        'aria-hidden', 'inert', 'data-model', 'data-model-id', 'data-value', 'aria-disabled', 'data-disabled'] });
    controller.click = event => {
      const row = isElement(event.target) ? event.target.closest(rowSelector) : event.target?.parentElement?.closest(rowSelector);
      const route = controller.rows.get(row);
      if (route && requestObserved(row, route)) schedule();
    };
    controller.keydown = event => {
      if (!['Enter', ' '].includes(event.key)) return;
      const row = event.target?.closest?.(rowSelector);
      const route = controller.rows.get(row);
      if (route && requestObserved(row, route)) schedule();
    };
    root.addEventListener('click', controller.click, true);
    root.addEventListener('keydown', controller.keydown, true);
    reconcile(controller);
  }
  function removeController(controller) {
    controller.observer.disconnect(); win.clearTimeout(controller.timer);
    controller.root.removeEventListener('click', controller.click, true);
    controller.root.removeEventListener('keydown', controller.keydown, true);
    for (const row of controller.rows.keys()) restoreRow(row);
    controller.rows.clear(); controller.toolbar?.remove(); controllers.delete(controller.root);
  }
  function scan() {
    scanTimer = 0; if (disposed || !enabled) return;
    stats.scans++;
    for (const [root, controller] of controllers) if (!root.isConnected) removeController(controller);
    for (const [root, observer] of portalObservers) if (!root.isConnected) { observer.disconnect(); portalObservers.delete(root); }
    // Discovery occurs only at install, an opening input, or portal insertion.
    // It never runs on pointermove or a polling interval.
    for (const root of doc.querySelectorAll(menuSelector)) {
      if (!root.closest('[data-gaoge-aggregate-toolbar]')) attach(root);
    }
    for (const portal of doc.querySelectorAll('[data-radix-popper-content-wrapper],[data-radix-portal]')) {
      if (portalObservers.has(portal) || Array.from(controllers.keys()).some(root => root.contains(portal))) continue;
      const observer = new win.MutationObserver(records => {
        if (records.some(record => Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(node => node.nodeType === 1
          && (node.matches?.(menuSelector) || node.querySelector?.(menuSelector))))) scheduleScan();
      });
      observer.observe(portal, { childList: true, subtree: true }); portalObservers.set(portal, observer);
    }
  }
  function scheduleScan() {
    if (!disposed && !scanTimer) scanTimer = win.setTimeout(scan, 60);
  }
  function openingInput(event) {
    const target = event.target?.closest?.(triggerSelector + ',[data-model-picker-view-toggle],[aria-haspopup="menu"]');
    if (!target) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'ArrowRight'].includes(event.key)) return;
    scheduleScan();
  }
  function status() {
    return { enabled: enabled && !disposed, ready: !disposed, version: revision,
      providerCount: new Set(routes.map(route => route.providerKey)).size,
      groupCount: new Set(routes.map(route => route.groupKey)).size, modelCount: routes.length,
      nativeMenuFound: Array.from(controllers.values()).some(controller => controller.rows.size > 0),
      selectedModel: observedModel, pendingModel: pending?.id || '' };
  }
  const runtime = {
    implementation: marker, version: revision, enabled, ready: true,
    matches: (version, value, base, token) => !disposed && version === revision && value === signature && base === bridgeBase && token === bridgeToken,
    status, selectModel, refresh: scheduleScan,
    diagnostic: () => ({ ...lastDiagnostic, history: history.slice(), ...stats,
      trackedRowCount: touchedRows.size, controllerCount: controllers.size, portalObserverCount: portalObservers.size }),
    openFallback() { if (!enabled || disposed) return false; const trigger = Array.from(doc.querySelectorAll(triggerSelector)).find(visible); trigger?.click(); return !!trigger; },
    dispose() {
      if (disposed) return;
      disposed = true; runtime.ready = false;
      for (const timer of [scanTimer, diagnosticTimer, pendingTimer]) win.clearTimeout(timer);
      bodyObserver?.disconnect(); for (const observer of portalObservers.values()) observer.disconnect(); portalObservers.clear();
      for (const controller of Array.from(controllers.values())) removeController(controller);
      for (const row of Array.from(touchedRows.keys())) restoreRow(row);
      style?.remove();
      for (const name of ['pointerdown', 'click', 'keydown']) doc.removeEventListener(name, openingInput, true);
      if (win.__gaogeAggregateModelPickerRuntime === runtime) delete win.__gaogeAggregateModelPickerRuntime;
    },
  };
  win.__gaogeAggregateModelPickerRuntime = runtime;
  if (enabled) {
    style = element('style', { id: styleId });
    style.textContent = '[data-gaoge-aggregate-filtered="true"]{display:none!important}'
      + '[data-gaoge-aggregate-toolbar]{padding:8px 6px 10px;min-width:0;width:100%;box-sizing:border-box;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);margin-bottom:5px;color:inherit;font:inherit;--gaoge-aggregate-control-bg:var(--gaoge-theme-surface,var(--color-background-control-opaque,var(--color-background-surface,Canvas)));--gaoge-aggregate-control-fg:var(--gaoge-theme-text,var(--color-text-foreground,CanvasText))}'
      + '.gaoge-aggregate-sources,.gaoge-aggregate-selects{display:flex;gap:5px}.gaoge-aggregate-sources{margin-bottom:7px}'
      + '[data-gaoge-aggregate-toolbar] button,[data-gaoge-aggregate-toolbar] input,[data-gaoge-aggregate-toolbar] select{font:inherit;color:inherit;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:7px;background:transparent;padding:5px 8px;min-width:0}'
      + '[data-gaoge-aggregate-toolbar] button{flex:1;cursor:pointer}[data-gaoge-aggregate-toolbar] button[aria-pressed="true"]{background:color-mix(in srgb,currentColor 10%,transparent);font-weight:600}'
      + '[data-gaoge-aggregate-toolbar] input{display:block;width:100%;margin-bottom:6px}[data-gaoge-aggregate-toolbar] select{flex:1;width:0;font-size:12px;color-scheme:inherit}'
      // Windows renders the native popup separately. Explicit option colors
      // prevent inherited pale text landing on the OS's default white popup.
      + '[data-gaoge-aggregate-toolbar] select,[data-gaoge-aggregate-toolbar] option{color:var(--gaoge-aggregate-control-fg);background-color:var(--gaoge-aggregate-control-bg)}'
      + '[data-gaoge-aggregate-toolbar] select[hidden]{display:none!important}'
      + '@media (forced-colors:active){[data-gaoge-aggregate-toolbar] select,[data-gaoge-aggregate-toolbar] option{color:CanvasText;background-color:Canvas}}'
      + '[data-gaoge-aggregate-toolbar] input:focus-visible,[data-gaoge-aggregate-toolbar] button:focus-visible,[data-gaoge-aggregate-toolbar] select:focus-visible{outline:2px solid currentColor;outline-offset:1px}'
      + '.gaoge-aggregate-empty{font-size:12px;opacity:.7;white-space:normal}.gaoge-aggregate-empty:not(:empty){padding-top:8px}';
    (doc.head || doc.documentElement).appendChild(style);
    bodyObserver = new win.MutationObserver(records => {
      if (records.some(record => Array.from(record.addedNodes).concat(Array.from(record.removedNodes))
        .some(node => node.nodeType === 1 && !node.matches?.('[data-gaoge-aggregate-toolbar]')))) scheduleScan();
    });
    bodyObserver.observe(doc.body || doc.documentElement, { childList: true });
    for (const name of ['pointerdown', 'click', 'keydown']) doc.addEventListener(name, openingInput, true);
    scan();
  }
  diagnostic('runtime-installed', { mode: 'native-rows', duplicateModelCount: duplicateIds.size });
  return status();
}
