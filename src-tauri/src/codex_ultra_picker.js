// Read the choices owned by each visible composer, not unrelated model queries.
// Shapes below are from the native 26.1013 Power picker and its local wrapper.
function codexUltraVisiblePickerState() {
  const result = { pickers: [], unresolvedCount: 0, chains: [] };
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return result;
  const selector = '[data-codex-intelligence-trigger="true"],'
    + '[data-composer-navigation-target="reasoning"]';
  const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  const visible = element => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden'
          || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const committedAncestors = element => {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$')
      || name.startsWith('__reactInternalInstance$'));
    let attached = key ? element[key] : null;
    const climbed = new Set();
    while (attached?.return && !climbed.has(attached) && climbed.size < 200) {
      climbed.add(attached);
      attached = attached.return;
    }
    const current = attached?.stateNode?.current;
    if (!current) return null;
    // React's DOM pointer can refer to either alternate. Locate the DOM owner
    // in root.current instead of trusting that pointer or pending work.
    const stack = [[current, null]];
    const parents = new Map();
    while (stack.length && parents.size < 20000) {
      const [fiber, parent] = stack.pop();
      if (!fiber || parents.has(fiber)) continue;
      parents.set(fiber, parent);
      if (fiber.stateNode === element) {
        const ancestors = [];
        for (let node = fiber; node; node = parents.get(node)) ancestors.push(node);
        return ancestors;
      }
      if (fiber.sibling && fiber !== current) stack.push([fiber.sibling, parent]);
      if (fiber.child) stack.push([fiber.child, fiber]);
    }
    return null;
  };
  const rootsFrom = ancestors => {
    const roots = new Set();
    const inspect = value => {
      const chain = value instanceof Map ? value : value?.chain;
      if (!(chain instanceof Map)) return;
      if (!result.chains.includes(chain)) result.chains.push(chain);
      for (const root of chain.values()) {
        if (root && typeof root === 'object') roots.add(root);
      }
    };
    for (const fiber of ancestors) {
      inspect(fiber.memoizedProps?.value);
      const visited = new Set();
      for (let context = fiber.dependencies?.firstContext;
        context && !visited.has(context) && visited.size < 32; context = context.next) {
        visited.add(context);
        inspect(context.memoizedValue);
      }
    }
    return [...roots];
  };
  const localModelData = (props, model) => {
    if (!props || typeof props.onSelectModel !== 'function' || props.model !== model
        || typeof props.reasoningEffort !== 'string'
        || !Array.isArray(props.powerSelections) || !Array.isArray(props.models)) return null;
    const matches = props.models.filter(candidate => candidate?.model === model
      && Array.isArray(candidate.supportedReasoningEfforts));
    return matches.length === 1 ? matches[0] : null;
  };
  // Both native local wrappers reject onSelectPower while the daybreak change
  // is saving or the selected model has a disabled reason, even if its Power
  // choices remain rendered by the shared picker.
  // 26.1029 may veto model selection through an opaque callback. Do not invoke
  // it during diagnostics or certify choices whose actual eligibility is unknown.
  const localSelectionBlocked = (props, model) => Boolean(props?.daybreak?.isSaving
    || props?.modelOptions?.some(option => option?.model?.model === model
      && option.disabledReason != null));
  const readOwner = ancestors => {
    for (let index = 0; index < ancestors.length; index += 1) {
      const fiber = ancestors[index];
      const props = fiber.memoizedProps;
      if (!props || !Array.isArray(props.powerSelections)) continue;
      if (typeof props.onSelectPower === 'function') {
        const selected = props.selectedPowerSelection;
        const label = props.selectedLabelCandidate;
        const model = selected?.model ?? label?.model;
        if (typeof model !== 'string' || !model
            || (selected?.model && label?.model && selected.model !== label.model)) return null;
        let selectedModelData = localModelData(props, model);
        let localProps = selectedModelData ? props : null;
        const wrapper = ancestors[index + 1]?.memoizedProps;
        // Native t7e returns r5e directly and forwards the same trigger config.
        // A model list on an arbitrary ancestor is not this consumer's data.
        if (!selectedModelData && props.triggerConfig != null
            && wrapper?.modelPickerTriggerConfig === props.triggerConfig) {
          selectedModelData = localModelData(wrapper, model);
          if (selectedModelData) localProps = wrapper;
        }
        return { props, model, selectedModelData, guardUnverified: typeof localProps?.onBeforeSelectModel === 'function'
          && localProps.reasoningEffort !== 'ultra', disabled: props.disabled === true
          || props.powerSelectionDisabled === true || props.active === false
          || localSelectionBlocked(localProps, model) };
      }
      if (typeof props.onSelectModel === 'function'
          && typeof props.model === 'string' && props.model
          && typeof props.reasoningEffort === 'string') {
        return { props, model: props.model, selectedModelData: localModelData(props, props.model),
          guardUnverified: typeof props.onBeforeSelectModel === 'function' && props.reasoningEffort !== 'ultra',
          disabled: props.disabled === true
          || props.reasoningEffortDisabled === true || props.daybreak?.disabled === true
          || props.showReasoningEffortControls === false || localSelectionBlocked(props, props.model) };
      }
    }
    return null;
  };
  for (const element of new Set(document.querySelectorAll(selector))) {
    try {
      if (!visible(element)) continue;
      const ancestors = committedAncestors(element);
      const owner = ancestors && readOwner(ancestors);
      const roots = ancestors ? rootsFrom(ancestors) : [];
      if (!owner || owner.guardUnverified || !roots.length || element.getAttribute('aria-busy') === 'true') {
        result.unresolvedCount += 1;
        continue;
      }
      const available = owner.disabled ? [] : owner.props.powerSelections
        .filter(option => option?.model === owner.model && option.isLocked !== true
          && !(owner.props.selectionMode !== 'model'
            && owner.props.lockedModelSlug === option.model)
          && efforts.has(option.reasoningEffort))
        .map(option => option.reasoningEffort);
      result.pickers.push({
        model: owner.model, efforts: [...new Set(available)], roots,
        selectedModelData: owner.selectedModelData,
      });
    } catch (_) {
      // An incomplete/unmounted composer must never turn into a success signal.
      result.unresolvedCount += 1;
    }
  }
  return result;
}
