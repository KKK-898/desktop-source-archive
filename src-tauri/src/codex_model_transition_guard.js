var CODEX_MODEL_TRANSITION_GUARD_VERSION = 5;

async function installCodexModelTransitionGuard(options) {
  const previous = window.__gaogeCodexModelTransitionGuard;
  if (previous?.dispose) previous.dispose();

  const state = options?.state || {};
  // Aggregation uses native model rows and native effort fallback. Do not wrap
  // its callbacks or load a second private model-persistence implementation.
  const protectTransitions = state.enabled === true && String(state.mode || "") === "relay";
  const recoveryState = state.aggregateModelRecovery || {};
  const recoveryModels = new Map();
  const ambiguousRecoveryModels = new Set();
  if (recoveryState.enabled === true && String(state.mode || "") !== "aggregate") {
    for (const model of Array.isArray(recoveryState.models) ? recoveryState.models : []) {
      const publicModel = typeof model?.publicModel === "string" ? model.publicModel.trim() : "";
      const upstreamModel = typeof model?.upstreamModel === "string" ? model.upstreamModel.trim() : "";
      if (!publicModel.startsWith("gaoge/") || !upstreamModel || publicModel === upstreamModel) continue;
      if (recoveryModels.has(publicModel) && recoveryModels.get(publicModel) !== upstreamModel) {
        ambiguousRecoveryModels.add(publicModel);
      }
      recoveryModels.set(publicModel, upstreamModel);
    }
    for (const model of ambiguousRecoveryModels) recoveryModels.delete(model);
  }
  const recoveryEnabled = recoveryModels.size > 0;
  const enabled = protectTransitions || recoveryEnabled;
  if (!enabled) {
    return {
      enabled: false,
      ready: true,
      version: CODEX_MODEL_TRANSITION_GUARD_VERSION,
      error: "",
    };
  }

  let disposed = false;
  let timer = 0;
  let bindings = null;
  let operation = null;
  let lastOwner = null;
  let runtime = null;
  const settledByOwner = new Map();
  const recoveryFailures = new Map();
  const wrappedControllers = new Map();
  const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const dangerousEfforts = new Set(["max", "ultra"]);

  const effortFields = [
    "reasoningEffort",
    "reasoning_effort",
    "effort",
    "reasoning",
  ];
  const modelFields = [
    "model",
    "modelSlug",
    "model_slug",
    "modelId",
    "model_id",
    "publicModel",
    "public_model",
    "slug",
    "id",
    "upstreamModel",
    "upstream_model",
  ];
  const supportedEffortFields = [
    "supportedReasoningEfforts",
    "supported_reasoning_efforts",
    "supportedReasoningEffort",
    "supported_reasoning_effort",
    "supportedReasoningLevels",
    "supported_reasoning_levels",
    "reasoningEfforts",
    "reasoning_efforts",
    "reasoningLevelOptions",
    "reasoning_level_options",
    "availableReasoningEfforts",
    "available_reasoning_efforts",
    "enabledReasoningEfforts",
    "enabled_reasoning_efforts",
    "supportedEfforts",
    "supported_efforts",
    "reasoningLevels",
    "reasoning_levels",
  ];
  const defaultEffortFields = [
    "defaultReasoningEffort",
    "default_reasoning_effort",
    "defaultEffort",
    "default_effort",
  ];
  const scalarString = value => (
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : ""
  );
  const nestedValue = (value, fields) => {
    if (!value || typeof value !== "object") return "";
    for (const field of fields) {
      const direct = scalarString(value[field]);
      if (direct) return direct;
      const nested = value[field];
      if (nested && typeof nested === "object") {
        const resolved = nestedValue(nested, fields);
        if (resolved) return resolved;
      }
    }
    return "";
  };
  const normalizeEffort = value => {
    if (value && typeof value === "object") {
      value = nestedValue(value, [
        "reasoningEffort",
        "reasoning_effort",
        "effort",
        "value",
        "id",
        "name",
      ]);
    }
    return scalarString(value).toLowerCase();
  };
  const modelIdValues = value => {
    const scalar = scalarString(value);
    if (scalar) return [scalar];
    if (!value || typeof value !== "object") return [];
    const values = [];
    for (const field of modelFields) {
      const direct = scalarString(value[field]);
      if (direct) {
        values.push(direct);
        continue;
      }
      if (value[field] && typeof value[field] === "object") {
        values.push(...modelIdValues(value[field]));
      }
    }
    return Array.from(new Set(values));
  };
  const modelId = value => {
    const values = modelIdValues(value);
    return values.find(item => item.includes("/")) || values[0] || "";
  };
  const selectionModel = selection => modelId(selection);
  const selectionEffort = selection => {
    if (!selection || typeof selection !== "object") return normalizeEffort(selection);
    for (const field of effortFields) {
      const value = selection[field];
      const direct = normalizeEffort(value);
      if (direct) return direct;
    }
    return "";
  };
  const canonicalModel = value => {
    const normalized = modelId(value).toLowerCase().replace(/_/g, "-");
    const parts = normalized.split("/");
    const routed = parts[0] === "gaoge" && parts.length >= 4
      ? parts.slice(3).join("/")
      : normalized;
    return routed.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  };
  const effortValues = value => {
    if (Array.isArray(value) || value instanceof Set) {
      return Array.from(value)
        .map(item => normalizeEffort(item))
        .filter(Boolean);
    }
    const direct = normalizeEffort(value);
    if (direct && effortOrder.includes(direct)) return [direct];
    if (value && typeof value === "object") {
      return Object.entries(value)
        .filter(([, enabled]) => enabled !== false && enabled != null)
        .map(([key]) => normalizeEffort(key))
        .filter(item => effortOrder.includes(item));
    }
    return [];
  };
  const modelEffortInfo = model => {
    const sources = [model, model?.capabilities, model?.capability, model?.reasoning];
    const efforts = new Set();
    let known = false;
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const field of supportedEffortFields) {
        if (!Object.prototype.hasOwnProperty.call(source, field)
            || source[field] == null) continue;
        known = true;
        for (const effort of effortValues(source[field])) efforts.add(effort);
      }
    }
    const result = Array.from(efforts);
    const canonical = canonicalModel(modelId(model));
    if (canonical === "gpt-5.5" || canonical.startsWith("gpt-5.5-")) {
      return {
        known,
        efforts: result.filter(effort => !["max", "ultra"].includes(effort)),
      };
    }
    return { known, efforts: result };
  };
  const modelEfforts = model => modelEffortInfo(model).efforts;
  const modelEffortsKnown = model => modelEffortInfo(model).known;
  const supportsEffort = (model, effort) => modelEfforts(model).includes(normalizeEffort(effort));
  const modelIdentity = value => canonicalModel(value);
  const isDangerousTransition = (fromModel, targetModel, effort) => {
    const normalizedEffort = normalizeEffort(effort);
    if (!dangerousEfforts.has(normalizedEffort)) return false;
    const from = modelId(fromModel);
    const target = modelId(targetModel);
    return Boolean(target && from !== target);
  };
  const modelById = (controller, model) => {
    const targetIds = new Set(modelIdValues(model));
    const candidates = [
      controller?.models,
      controller?.availableModels,
      controller?.modelOptions,
    ].filter(Array.isArray).flat();
    return candidates.find(item => modelIdValues(item).some(id => targetIds.has(id))) || null;
  };
  const modelDefaultEffort = model => {
    const sources = [model, model?.defaults, model?.capabilities, model?.capability];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const field of defaultEffortFields) {
        const effort = normalizeEffort(source[field]);
        if (effort) return effort;
      }
    }
    return "";
  };
  const transitionEffort = (currentModel, targetModel, settledEffort, excludedEffort = "") => {
    const current = new Set(modelEfforts(currentModel));
    const target = new Set(modelEfforts(targetModel));
    const common = effortOrder.filter(effort => current.has(effort) && target.has(effort));
    if (!common.length) return "";
    const excluded = normalizeEffort(excludedEffort);
    const preferred = [
      normalizeEffort(settledEffort),
      "medium",
      "low",
      "high",
      "xhigh",
      "minimal",
      "none",
      modelDefaultEffort(targetModel),
    ];
    return preferred.find(effort => common.includes(effort) && effort !== excluded)
      || common.find(effort => effort !== excluded)
      || "";
  };

  const liveFiberFrom = node => {
    if (!(node instanceof Element)) return null;
    const key = Object.keys(node).find(
      item => item.startsWith("__reactFiber$") || item.startsWith("__reactInternalInstance$"),
    );
    let fiber = key ? node[key] : null;
    let root = fiber;
    while (root?.return) root = root.return;
    if (!root?.stateNode?.current || root.stateNode.current === root) return fiber;
    const alternate = fiber?.alternate;
    let alternateRoot = alternate;
    while (alternateRoot?.return) alternateRoot = alternateRoot.return;
    return alternate && alternateRoot?.stateNode?.current === alternateRoot ? alternate : null;
  };
  const visible = node => {
    if (!(node instanceof HTMLElement) || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 2 && rect.height > 2
      && style.display !== "none" && style.visibility !== "hidden";
  };
  const findButton = () => Array.from(document.querySelectorAll(
    '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"],'
      + '[data-codex-intelligence-trigger="true"],'
      + '[data-composer-navigation-target="reasoning"]',
  )).filter(visible)[0] || null;
  const composerOwner = () => {
    const button = findButton();
    if (!button) return null;
    const start = liveFiberFrom(button);
    const contexts = new Set();
    const chains = new Map();
    const compilerCaches = [];
    let controller = null;
    let threadId = null;
    const isPendingLocalDraft = value => value?.kind === "local"
      && value.conversationId === null
      && typeof value.clientThreadId === "string" && value.clientThreadId.trim().length > 0;
    const isLocalComposer = value => (value?.kind === "local"
      && typeof value.conversationId === "string" && value.conversationId.length > 0)
      || value?.kind === "new" || isPendingLocalDraft(value);
    const inspect = candidate => {
      const chain = candidate instanceof Map ? candidate : candidate?.chain;
      if (!(chain instanceof Map)) return;
      if (bindings?.composerScope?.id) {
        const node = chain.get(bindings.composerScope.id);
        const value = node?.value;
        if (isLocalComposer(value)) {
          contexts.add(node);
          chains.set(node, chain);
        }
        return;
      }
      for (const node of chain.values()) {
        const value = node?.value;
        if (isLocalComposer(value)) {
          contexts.add(node);
          chains.set(node, chain);
        }
      }
    };
    for (let fiber = start, depth = 0; fiber && depth < 70; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      const caches = fiber.updateQueue?.memoCache?.data;
      if (Array.isArray(caches)) {
        for (const cache of caches.slice(0, 32)) {
          if (Array.isArray(cache) && cache.length <= 2000) compilerCaches.push(cache);
        }
      }
      if (!controller
          && (typeof props?.onSelectModel === "function"
            || typeof props?.onSelectReasoningEffort === "function")
          && Array.isArray(props.models)) {
        controller = props;
      }
      if (threadId == null) threadId = props?.conversationId ?? props?.threadId ?? null;
      inspect(props?.value);
      for (let context = fiber.dependencies?.firstContext, index = 0;
        context && index < 24; context = context.next, index += 1) {
        inspect(context.memoizedValue);
      }
    }
    if (!controller || contexts.size > 1) return null;
    const node = contexts.values().next().value || null;
    const value = node?.value;
    // 26.1103's public onSelectModel callback discards the native Promise.
    // The exact composer's compiler cache also retains the permission-aware
    // selector and its ownership wrapper. Read only that committed ancestor
    // cache: never inspect alternate/pending props or call private writers.
    const nativeSelections = new Map();
    for (const cache of compilerCaches) {
      if (cache.some(item => item?.isAeon === true)) continue;
      for (const wrapper of cache) {
        if (!wrapper || typeof wrapper !== "object"
            || !Object.prototype.hasOwnProperty.call(wrapper, "conversationId")
            || wrapper.executionHostId !== "local") continue;
        if (value?.kind === "local" ? wrapper.conversationId !== value.conversationId
          : value?.kind !== "new" || wrapper.conversationId != null) continue;
        const selection = wrapper.modelSelection;
        if (!selection || !cache.includes(selection)
            || typeof selection.selectComposerModelAndReasoningEffort !== "function"
            || typeof selection.setModelAndReasoningEffort !== "function"
            || typeof selection.setDefaultModelAndReasoningEffort !== "function"
            || selection.modelSettings?.isLoading
            || selectionModel(selection.modelSettings) !== selectionModel(controller)
            || selectionEffort(selection.modelSettings) !== selectionEffort(controller)) continue;
        const effective = cache.filter(item => item && typeof item === "object"
          && Object.prototype.hasOwnProperty.call(item, "conversationId")
          && item.conversationId === wrapper.conversationId
          && item.hostId === wrapper.executionHostId
          && Object.prototype.hasOwnProperty.call(item, "cwd"));
        const paths = new Set(effective.map(item => item.cwd));
        // Older fixtures/native compilers can retain the effective arguments
        // rather than a separate permission context. Accept an explicit local
        // override only when it agrees with the current scope when available.
        if (!paths.size) {
          for (const item of cache) {
            if (item && item.conversationId === wrapper.conversationId
                && item.hostId === "local"
                && Object.prototype.hasOwnProperty.call(item, "cwdOverride")) paths.add(item.cwdOverride);
          }
        }
        if (paths.size !== 1) continue;
        const cwd = paths.values().next().value;
        if (typeof cwd !== "string" && cwd !== null) continue;
        const scopeHost = value?.hostId ?? controller.hostId;
        const scopeCwd = value?.cwd ?? controller.cwd;
        if (scopeHost != null && scopeHost !== wrapper.executionHostId) continue;
        if (scopeCwd != null && scopeCwd !== cwd) continue;
        nativeSelections.set(selection, { selection, hostId: wrapper.executionHostId, cwd });
      }
    }
    const nativeSelection = nativeSelections.size === 1
      ? nativeSelections.values().next().value : null;
    // A local draft has no persisted conversation yet. Resolve its default
    // target only from the exact committed local host/cwd selector metadata.
    if (isPendingLocalDraft(value) && !nativeSelection) return null;
    const hostId = value?.hostId ?? controller.hostId ?? nativeSelection?.hostId;
    const cwd = value?.cwd ?? controller.cwd ?? nativeSelection?.cwd;
    return {
      button,
      controller,
      node,
      chain: chains.get(node),
      url: location.href,
      key: node
        ? JSON.stringify([
          value.kind,
          value.conversationId,
          value.clientThreadId,
          hostId,
          cwd,
          value.routeKind,
          value.focusComposerNonce,
        ])
        : JSON.stringify([threadId]),
      conversationId: value?.kind === "local" ? String(value.conversationId || "") : "",
      isNew: value?.kind === "new" || isPendingLocalDraft(value),
      hostId,
      cwd,
      nativeSelection: nativeSelection?.selection || null,
    };
  };
  const sameOwner = (left, right) => Boolean(
    left && right && left.url === right.url && left.key === right.key
      && (!left.node && !right.node || left.node === right.node),
  );
  const targetMatchesOwner = (target, owner, candidates) => {
    const serialized = typeof target === "string" ? target : JSON.stringify(target);
    if (owner.conversationId) {
      return serialized.includes(JSON.stringify(owner.conversationId))
        || serialized.includes(owner.conversationId);
    }
    return owner.isNew === true && candidates.length === 1;
  };
  const ownerEntries = (details, owner, field) => {
    const candidates = Array.isArray(details?.[field]) ? details[field] : [];
    return candidates.filter(entry => targetMatchesOwner(entry.target, owner, candidates));
  };
  const ownerPending = (details, owner) => ({
    queued: ownerEntries(details, owner, "queued"),
    inFlight: ownerEntries(details, owner, "inFlight"),
  });
  const latestSelection = entries => entries.map(entry => entry.selection).findLast(Boolean) || null;
  const record = (event, detail = {}) => {
    window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__ = {
      event,
      at: Date.now(),
      ...detail,
    };
  };
  const publishRuntimeStatus = () => {
    const count = wrappedControllers.size;
    window.__GAOGE_CODEX_MODEL_TRANSITION_GUARD_CONTROLLER_COUNT__ = count;
    window.__GAOGE_CODEX_MODEL_TRANSITION_GUARD_READY__ = count > 0 && !disposed;
    if (runtime) {
      runtime.wrappedControllerCount = count;
      runtime.ready = count > 0 && !disposed;
    }
  };
  const markBusy = busy => {
    const root = document.documentElement;
    if (!root) return;
    if (busy) root.dataset.gaogeModelTransitionPending = "true";
    else delete root.dataset.gaogeModelTransitionPending;
    document.querySelectorAll('[data-reasoning-slider], [role="slider"]').forEach(node => {
      if (!(node instanceof HTMLElement)) return;
      if (busy) {
        node.dataset.gaogeModelTransitionPending = "true";
        node.title = "模型正在切换，推理强度将在模型确认后继续保存";
      } else {
        delete node.dataset.gaogeModelTransitionPending;
        if (node.title === "模型正在切换，推理强度将在模型确认后继续保存") {
          node.removeAttribute("title");
        }
      }
    });
  };
  const controllerReady = controller => Boolean(
    controller
      && !controller.disabled
      && !controller.modelOptionsDisabled
      && !controller.daybreak?.disabled,
  );
  const controllerModel = controller => selectionModel(controller);
  const controllerEffort = controller => selectionEffort(controller);
  const nativeModelSelector = controller => {
    const wrapped = wrappedControllers.get(controller);
    if (wrapped?.modelWrapper === controller?.onSelectModel
        || wrapped?.wrapper === controller?.onSelectModel) {
      return wrapped.originalModel || wrapped.original;
    }
    return controller?.onSelectModel;
  };
  const nativeReasoningSelector = controller => {
    const wrapped = wrappedControllers.get(controller);
    if (wrapped?.reasoningWrapper === controller?.onSelectReasoningEffort) {
      return wrapped.originalReasoning;
    }
    return controller?.onSelectReasoningEffort;
  };
  const trackResult = (result, phase, message) => {
    if (result === false) throw new Error(message);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).then(value => {
        if (operation?.phase === phase && value === false) {
          operation.error = new Error(message);
        }
      }, error => {
        if (operation?.phase === phase) {
          operation.error = error || new Error(message);
        }
      });
    }
    return result;
  };
  const invokeSelection = (owner, model, effort, phase) => {
    const controller = owner?.controller;
    if (!controllerReady(controller)) throw new Error("Codex 模型选择当前不可用。");
    const selector = nativeModelSelector(controller);
    if (typeof selector !== "function") throw new Error("Codex 模型选择回调不可用。");
    const result = Reflect.apply(selector, controller, [model, effort]);
    controller.onSelectModelOption?.();
    return trackResult(result, phase, "Codex 拒绝了模型切换。");
  };
  const invokeReasoningEffort = (owner, effort, phase) => {
    const controller = owner?.controller;
    if (!controllerReady(controller)) throw new Error("Codex 推理强度选择当前不可用。");
    const selector = nativeReasoningSelector(controller);
    if (typeof selector !== "function") {
      return invokeSelection(owner, operation.targetModel, effort, phase);
    }
    const result = Reflect.apply(selector, controller, [effort]);
    return trackResult(result, phase, "Codex 拒绝了推理强度切换。");
  };
  // Aggregate aliases are identities, not prefixes that can safely be stripped.
  // Only backend-recorded aliases that disappeared from the native directory
  // are eligible. A valid user choice is never replaced by a global default.
  const nativeModelId = model => {
    if (typeof model === "string") return model.trim();
    for (const field of ["model", "slug", "modelSlug", "model_slug", "modelId", "model_id", "id"]) {
      const value = scalarString(model?.[field]);
      if (value) return value;
    }
    return "";
  };
  const nativeModels = controller => [
    controller?.models, controller?.availableModels, controller?.modelOptions,
  ].filter(Array.isArray).flat();
  const exactNativeModel = (controller, id) => nativeModels(controller)
    .find(model => nativeModelId(model) === id) || null;
  const staleAggregateSelection = owner => {
    const model = controllerModel(owner?.controller);
    return recoveryEnabled && recoveryModels.has(model)
      && !exactNativeModel(owner?.controller, model) ? model : "";
  };
  const recoveryPlan = owner => {
    const fromModel = staleAggregateSelection(owner);
    if (!fromModel) return null;
    const models = nativeModels(owner.controller).filter(model => (
      nativeModelId(model) && !recoveryModels.has(nativeModelId(model))
    ));
    const target = models.find(model => nativeModelId(model) === recoveryModels.get(fromModel))
      || models.find(model => nativeModelId(model) === scalarString(recoveryState.defaultModel))
      || models.find(model => model.isDefault === true || model.is_default === true)
      || models[0];
    if (!target) return null;
    const fromEffort = controllerEffort(owner.controller);
    const info = modelEffortInfo(target);
    const defaultEffort = modelDefaultEffort(target);
    const requestedEffort = info.efforts.includes(fromEffort) ? fromEffort
      : info.efforts.includes(defaultEffort) ? defaultEffort
        : effortOrder.slice().reverse().find(effort => info.efforts.includes(effort))
          || (!info.known ? defaultEffort : "");
    const bridgeEffort = dangerousEfforts.has(requestedEffort)
      ? ["medium", "low", "high", "xhigh", "minimal", "none"]
        .find(effort => info.efforts.includes(effort)) || ""
      : requestedEffort;
    return {
      fromModel, fromEffort, targetModel: nativeModelId(target), requestedEffort,
      bridgeEffort, target,
    };
  };
  const nativeTarget = target => {
    try {
      const value = typeof target === "string" ? JSON.parse(target) : target;
      return Array.isArray(value) ? value : null;
    } catch (_) { return null; }
  };
  const exactRecoveryTarget = (target, owner) => {
    const value = nativeTarget(target);
    if (!value) return "";
    if (owner.conversationId) {
      return value.length === 2 && value[0] === "conversation"
        && value[1] === owner.conversationId ? JSON.stringify(value) : "";
    }
    if (!owner.isNew || value.length !== 3 || value[0] !== "default"
        || typeof owner.hostId !== "string" || owner.cwd === undefined) return "";
    if (value[1] !== owner.hostId || value[2] !== owner.cwd) return "";
    return JSON.stringify(value);
  };
  const observeRecoverySave = (owner, details) => {
    if (!operation?.recovery || !details?.known) return false;
    for (const entry of [...details.queued, ...details.inFlight]) {
      const target = exactRecoveryTarget(entry.target, owner);
      if (!target || selectionModel(entry.selection) !== operation.expectedModel
          || (operation.expectedEffort && selectionEffort(entry.selection) !== operation.expectedEffort)) continue;
      if (operation.saveTarget && operation.saveTarget !== target) {
        operation.error = new Error("Codex 模型保存目标不唯一。");
        return false;
      }
      operation.saveTarget = target;
      operation.saveObserved = true;
    }
    return true;
  };
  const invokeRecoverySelection = (owner, effort, reasoningOnly = false) => {
    const active = operation;
    const controller = owner.controller;
    const permissionSelection = owner.nativeSelection;
    const selector = permissionSelection?.selectComposerModelAndReasoningEffort
      || (reasoningOnly ? nativeReasoningSelector(controller) : nativeModelSelector(controller));
    active.saveTarget = "";
    active.saveObserved = false;
    active.saveResolved = false;
    active.stable = 0;
    active.expectedEffort = effort;
    active.error = null;
    if (typeof selector !== "function" || !controllerReady(controller)) {
      throw new Error("Codex 原生模型选择当前不可用。");
    }
    if (!reasoningOnly && controller.onBeforeSelectModel?.(active.targetModel) === false) {
      throw new Error("Codex 当前不允许切换到目标模型。");
    }
    const result = permissionSelection
      ? Reflect.apply(selector, permissionSelection, [active.targetModel, effort || undefined, () => {}])
      : reasoningOnly
        ? Reflect.apply(selector, controller, [effort || undefined])
        : Reflect.apply(selector, controller, [active.targetModel, effort || undefined]);
    if (result === false) throw new Error("Codex 拒绝了模型恢复。");
    const acceptResult = value => {
      if (value !== true) {
        active.error = new Error("Codex 未确认恢复后的模型已保存。");
        return;
      }
      active.saveResolved = true;
      // Do not change another composer's mode if the user navigated while a
      // native permission dialog or save was in flight.
      const live = composerOwner();
      if (!reasoningOnly && sameOwner(active.owner, live)) live.controller.onSelectModelOption?.();
    };
    if (result === true) acceptResult(true);
    if (result && typeof result.then === "function") {
      const phase = active.phase;
      Promise.resolve(result).then(value => {
        if (operation !== active || active.phase !== phase) return;
        acceptResult(value);
      }, error => {
        if (operation === active && active.phase === phase) {
          active.error = error || new Error("Codex 未保存恢复后的模型。");
        }
      });
    } else if (result !== true) {
      active.error = new Error("Codex 原生模型选择未提供保存结果。");
    }
    observeRecoverySave(owner, readAggregateNativeSelectionDetails(bindings, owner.chain));
    return result;
  };
  const startAggregateRecovery = (owner, details, explicitSelection = null) => {
    if (!recoveryEnabled || !details?.known || details.busy
        || !owner.node || (!owner.conversationId && !owner.isNew)
        || owner.controller.daybreak?.isSaving || !controllerReady(owner.controller)) return false;
    let plan = recoveryPlan(owner);
    if (explicitSelection) {
      const target = exactNativeModel(owner.controller, modelId(explicitSelection.model));
      const effort = normalizeEffort(explicitSelection.reasoningEffort);
      const info = modelEffortInfo(target);
      if (!target || (effort && info.known && !info.efforts.includes(effort))) return false;
      plan = {
        fromModel: controllerModel(owner.controller), fromEffort: controllerEffort(owner.controller),
        targetModel: nativeModelId(target), requestedEffort: effort, bridgeEffort: effort, target,
      };
    }
    if (!plan || (!explicitSelection && recoveryFailures.get(owner.key)?.fromModel === plan.fromModel)) return false;
    operation = {
      ...plan, recovery: true, owner, ownerKey: owner.key, startedAt: Date.now(),
      phase: "recovery-model", expectedModel: plan.targetModel,
      expectedEffort: plan.bridgeEffort, stable: 0, error: null,
    };
    markBusy(true);
    record("aggregate-recovery-started", {
      fromModel: plan.fromModel, targetModel: plan.targetModel,
      requestedEffort: plan.requestedEffort,
    });
    try { operation.result = invokeRecoverySelection(owner, plan.bridgeEffort); }
    catch (error) { operation.error = error; }
    return true;
  };
  const finishOperation = (event, detail = {}) => {
    const completed = operation;
    operation = null;
    markBusy(false);
    record(event, {
      fromModel: completed?.fromModel || "",
      targetModel: completed?.targetModel || "",
      requestedEffort: completed?.requestedEffort || "",
      ...detail,
    });
  };
  const beginRollback = (owner, reason) => {
    if (!operation || operation.phase === "rollback") return;
    const controller = owner.controller;
    if (controllerModel(controller) === operation.fromModel
        && controllerEffort(controller) === operation.fromEffort) {
      finishOperation("transition-failed", { reason });
      return;
    }
    operation.phase = "rollback";
    operation.expectedModel = operation.fromModel;
    operation.expectedEffort = operation.fromEffort;
    operation.stable = 0;
    operation.error = null;
    try {
      invokeSelection(owner, operation.fromModel, operation.fromEffort, "rollback");
    } catch (error) {
      finishOperation("transition-rollback-failed", {
        reason,
        rollbackError: String(error?.message || error),
      });
    }
  };
  const inspectTransition = (owner, requested, settled) => {
    const targetModel = selectionModel(requested);
    const requestedEffort = selectionEffort(requested);
    const fromModel = modelId(settled?.model);
    const dangerous = isDangerousTransition(fromModel, targetModel, requestedEffort);
    const current = modelById(owner.controller, fromModel);
    const target = modelById(owner.controller, targetModel);
    const sameModel = Boolean(fromModel && targetModel && fromModel === targetModel);
    const modelSwitch = Boolean(targetModel && !sameModel);
    if (!targetModel || !requestedEffort) {
      return { dangerous: false, targetModel, requestedEffort, current, target };
    }
    const metadataKnown = Boolean(
      current
        && target
        && modelEffortsKnown(current)
        && modelEffortsKnown(target),
    );
    if (!metadataKnown) {
      // The guard exists to stop the capability-sensitive highest efforts
      // from being paired with the wrong model. If a future Codex build moves
      // its metadata again, keep ordinary native selections usable and let
      // the client validate its own low-through-xhigh choices.
      if (!dangerousEfforts.has(requestedEffort)) {
        return {
          dangerous: false,
          targetModel,
          requestedEffort,
          fromModel,
          current,
          target,
        };
      }
      return {
        dangerous,
        blocked: true,
        reason: "model-metadata-unavailable",
        targetModel,
        requestedEffort,
        fromModel,
        current,
        target,
      };
    }
    const currentSupports = supportsEffort(current, requestedEffort);
    const targetSupports = supportsEffort(target, requestedEffort);
    if (!targetSupports) {
      return {
        dangerous,
        blocked: true,
        reason: "target-effort-unsupported",
        targetModel,
        requestedEffort,
        fromModel,
        current,
        target,
      };
    }
    if (sameModel) {
      return {
        dangerous: false,
        targetModel,
        requestedEffort,
        fromModel,
        current,
        target,
      };
    }
    if (!modelSwitch) {
      return {
        dangerous: false,
        targetModel,
        requestedEffort,
        fromModel,
        current,
        target,
      };
    }
    if (!dangerous && currentSupports) {
      return {
        dangerous: false,
        targetModel,
        requestedEffort,
        fromModel,
        current,
        target,
      };
    }
    const bridge = transitionEffort(
      current,
      target,
      settled?.effort,
      dangerous ? requestedEffort : "",
    );
    if (!bridge || bridge === requestedEffort) {
      return {
        dangerous,
        blocked: true,
        reason: "no-common-bridge-effort",
        targetModel,
        requestedEffort,
        fromModel,
        current,
        target,
      };
    }
    return {
      dangerous,
      targetModel,
      requestedEffort,
      fromModel,
      current,
      target,
      bridge,
    };
  };
  const snapshotSelection = selection => ({
    model: selectionModel(selection),
    reasoningEffort: selectionEffort(selection),
  });
  const rewriteSelectionEffort = (selection, effort) => {
    if (!selection || (typeof selection !== "object" && typeof selection !== "function")) {
      return false;
    }
    const normalized = normalizeEffort(effort);
    try {
      const key = effortFields.find(candidate => (
        Object.prototype.hasOwnProperty.call(selection, candidate)
      )) || "reasoningEffort";
      if (key === "reasoning" && selection[key] && typeof selection[key] === "object") {
        const nestedKey = [
          "reasoningEffort",
          "reasoning_effort",
          "effort",
          "value",
        ].find(candidate => Object.prototype.hasOwnProperty.call(selection[key], candidate))
          || "effort";
        selection[key][nestedKey] = normalized;
      } else {
        selection[key] = normalized;
      }
    } catch (_) {
      return false;
    }
    return selectionEffort(selection) === normalized;
  };
  const repairPendingTransitions = (owner, pending, settled) => {
    if (!settled) return null;
    let selected = null;
    for (const entry of [...pending.inFlight, ...pending.queued]) {
      const requested = snapshotSelection(entry.selection);
      const inspection = inspectTransition(owner, requested, settled);
      const requestedEffort = normalizeEffort(requested.reasoningEffort);
      const sameModel = Boolean(
        inspection.fromModel
          && inspection.targetModel
          && inspection.fromModel === inspection.targetModel,
      );
      const unsafePending = inspection.dangerous
        || (inspection.blocked && (
          dangerousEfforts.has(requestedEffort)
          || sameModel
        ));
      if (!unsafePending) continue;
      if (inspection.blocked) {
        // A menu callback captured before installation can still enqueue an
        // unsupported effort on the current model (for example gpt-5.5 +
        // max). Rewrite that pending object to a known-safe common effort
        // before the native save observes it. The normal wrapper rejects the
        // action synchronously; this branch protects only stale callbacks.
        const bridge = transitionEffort(
          inspection.current,
          inspection.target,
          settled.effort,
          requestedEffort,
        );
        if (bridge
            && bridge !== requestedEffort
            && rewriteSelectionEffort(entry.selection, bridge)) {
          // Keep the optimistic controller value consistent with the
          // rewritten native selection. Otherwise the native commit would be
          // safe while the visible slider still reports the rejected effort.
          rewriteSelectionEffort(owner.controller, bridge);
          return {
            blocked: true,
            reason: inspection.reason || "unsafe-transition",
            requested,
            source: pending.inFlight.includes(entry) ? "in-flight" : "queued",
          };
        }
        return {
          blocked: true,
          reason: inspection.reason || "unsafe-transition",
          requested,
          source: pending.inFlight.includes(entry) ? "in-flight" : "queued",
        };
      }
      if (!rewriteSelectionEffort(entry.selection, inspection.bridge)) {
        return {
          blocked: true,
          reason: "pending-selection-read-only",
          requested,
          source: pending.inFlight.includes(entry) ? "in-flight" : "queued",
        };
      }
      selected ||= { requested, source: pending.inFlight.includes(entry) ? "in-flight" : "queued" };
    }
    return selected;
  };
  const startOperation = (owner, requested, settled) => {
    const inspection = inspectTransition(owner, requested, settled);
    if (inspection.blocked) return inspection;
    if (!inspection.bridge) return null;
    const {
      targetModel,
      requestedEffort,
      bridge,
      fromModel,
    } = inspection;
    const fromEffort = normalizeEffort(settled?.effort);
    if (!fromModel || !fromEffort) {
      return inspection.dangerous
        ? { ...inspection, blocked: true, reason: "settled-selection-unavailable" }
        : null;
    }
    operation = {
      owner,
      ownerKey: owner.key,
      startedAt: Date.now(),
      phase: "transition",
      fromModel,
      fromEffort,
      targetModel,
      requestedEffort,
      bridgeEffort: bridge,
      expectedModel: targetModel,
      expectedEffort: bridge,
      stable: 0,
      error: null,
    };
    markBusy(true);
    record("transition-intercepted", {
      fromModel,
      fromEffort,
      targetModel,
      requestedEffort,
      bridgeEffort: bridge,
    });
    let result;
    try {
      result = invokeSelection(owner, targetModel, bridge, "transition");
    } catch (error) {
      operation.error = error;
      result = false;
    }
    return { result };
  };
  const guardController = owner => {
    const controller = owner?.controller;
    if (!controller) return false;
    let wrapped = wrappedControllers.get(controller) || {};
    const existingModelWrapper = wrapped.modelWrapper || wrapped.wrapper;
    const existingModelOriginal = wrapped.originalModel || wrapped.original;
    const settledFor = liveOwner => {
      const saved = settledByOwner.get(liveOwner.key);
      return saved || {
        model: controllerModel(controller),
        effort: controllerEffort(controller),
      };
    };
    const recordBlocked = (intercepted, settled, fallbackTarget, fallbackEffort) => {
      record("transition-blocked", {
        fromModel: intercepted?.fromModel || settled?.model || "",
        targetModel: intercepted?.targetModel || modelId(fallbackTarget),
        requestedEffort: intercepted?.requestedEffort
          || normalizeEffort(fallbackEffort),
        reason: intercepted?.reason || "unsafe-transition",
      });
    };

    if (typeof controller.onSelectModel === "function") {
      if (controller.onSelectModel === existingModelWrapper && existingModelOriginal) {
        wrapped = {
          ...wrapped,
          originalModel: existingModelOriginal,
          modelWrapper: existingModelWrapper,
          original: existingModelOriginal,
          wrapper: existingModelWrapper,
        };
      } else if (controller.onSelectModel !== existingModelWrapper) {
        const originalModel = controller.onSelectModel;
        const modelWrapper = function guardedCodexModelSelection(model, effort) {
          const liveOwner = composerOwner();
          if (!liveOwner || liveOwner.controller !== controller) {
            return Reflect.apply(originalModel, this, [model, effort]);
          }
          if (operation) {
            if (sameOwner(operation.owner, liveOwner)) {
              record("transition-input-blocked", {
                targetModel: operation.targetModel,
                requestedEffort: operation.requestedEffort,
              });
              return false;
            }
            return Reflect.apply(originalModel, this, [model, effort]);
          }
          const settled = settledFor(liveOwner);
          if (recoveryFailures.has(liveOwner.key)) {
            const details = readAggregateNativeSelectionDetails(bindings, liveOwner.chain);
            if (!startAggregateRecovery(liveOwner, details, { model, reasoningEffort: effort })) return false;
            return operation?.result;
          }
          if (!protectTransitions || staleAggregateSelection(liveOwner)) {
            // An explicit valid native selection always remains a way out if
            // automatic recovery could not be saved on this client.
            return Reflect.apply(originalModel, this, [model, effort]);
          }
          const intercepted = startOperation(liveOwner, {
            model,
            reasoningEffort: effort,
          }, settled);
          if (intercepted?.blocked) {
            recordBlocked(intercepted, settled, model, effort);
            return false;
          }
          if (!intercepted) return Reflect.apply(originalModel, this, [model, effort]);
          return intercepted.result;
        };
        modelWrapper.__gaogeCodexModelTransitionGuard = true;
        try {
          controller.onSelectModel = modelWrapper;
        } catch (_) {
          return false;
        }
        if (controller.onSelectModel !== modelWrapper) return false;
        wrapped = {
          ...wrapped,
          originalModel,
          modelWrapper,
          original: originalModel,
          wrapper: modelWrapper,
        };
      }
    }

    if (typeof controller.onSelectReasoningEffort === "function") {
      if (controller.onSelectReasoningEffort === wrapped.reasoningWrapper
          && wrapped.originalReasoning) {
        // The reasoning callback is already guarded for this controller.
      } else if (controller.onSelectReasoningEffort !== wrapped.reasoningWrapper) {
        const originalReasoning = controller.onSelectReasoningEffort;
        const reasoningWrapper = function guardedCodexReasoningSelection(effort) {
          const liveOwner = composerOwner();
          if (!liveOwner || liveOwner.controller !== controller) {
            return Reflect.apply(originalReasoning, this, [effort]);
          }
          if (operation) {
            if (sameOwner(operation.owner, liveOwner)) {
              record("transition-input-blocked", {
                targetModel: operation.targetModel,
                requestedEffort: operation.requestedEffort,
              });
              return false;
            }
            return Reflect.apply(originalReasoning, this, [effort]);
          }
          const settled = settledFor(liveOwner);
          if (!protectTransitions) return Reflect.apply(originalReasoning, this, [effort]);
          const intercepted = inspectTransition(liveOwner, {
            model: settled.model || controllerModel(controller),
            reasoningEffort: effort,
          }, settled);
          if (intercepted?.blocked) {
            recordBlocked(
              intercepted,
              settled,
              settled.model || controllerModel(controller),
              effort,
            );
            return false;
          }
          if (intercepted?.bridge) {
            const started = startOperation(liveOwner, {
              model: settled.model || controllerModel(controller),
              reasoningEffort: effort,
            }, settled);
            if (started?.blocked) {
              recordBlocked(
                started,
                settled,
                settled.model || controllerModel(controller),
                effort,
              );
              return false;
            }
            return started?.result;
          }
          return Reflect.apply(originalReasoning, this, [effort]);
        };
        reasoningWrapper.__gaogeCodexModelTransitionGuard = true;
        try {
          controller.onSelectReasoningEffort = reasoningWrapper;
        } catch (_) {
          // Keep a successfully installed model wrapper even if the optional
          // reasoning callback is read-only on this client build.
        }
        if (controller.onSelectReasoningEffort === reasoningWrapper) {
          wrapped = {
            ...wrapped,
            originalReasoning,
            reasoningWrapper,
          };
        }
      }
    }

    if (!wrapped.modelWrapper && !wrapped.reasoningWrapper) return false;
    wrappedControllers.set(controller, wrapped);
    publishRuntimeStatus();
    return true;
  };
  const restoreController = (controller, wrapped) => {
    const modelWrapper = wrapped?.modelWrapper || wrapped?.wrapper;
    const modelOriginal = wrapped?.originalModel || wrapped?.original;
    if (modelWrapper && controller?.onSelectModel === modelWrapper) {
      try { controller.onSelectModel = modelOriginal; } catch (_) {}
    }
    if (wrapped?.reasoningWrapper
        && controller?.onSelectReasoningEffort === wrapped.reasoningWrapper) {
      try { controller.onSelectReasoningEffort = wrapped.originalReasoning; } catch (_) {}
    }
  };
  const retainActiveController = activeController => {
    for (const [controller, wrapped] of wrappedControllers) {
      if (controller === activeController) continue;
      restoreController(controller, wrapped);
      wrappedControllers.delete(controller);
    }
    publishRuntimeStatus();
  };
  const failRecovery = reason => {
    if (!operation?.recovery) return;
    recoveryFailures.set(operation.ownerKey, {
      fromModel: operation.fromModel, targetModel: operation.targetModel,
    });
    finishOperation("aggregate-recovery-failed", { reason });
  };
  const processAggregateRecovery = (owner, details) => {
    const active = operation;
    if (!active?.recovery) return;
    if (!sameOwner(active.owner, owner)) {
      failRecovery("composer-changed-before-confirmed-save");
      return;
    }
    active.owner = owner;
    if (!details?.known) return;
    observeRecoverySave(owner, details);
    if (active.error && !details.busy) {
      failRecovery(String(active.error?.message || active.error));
      return;
    }
    if (Date.now() - active.startedAt > 30000) {
      failRecovery("native-save-timeout");
      return;
    }
    const currentModel = controllerModel(owner.controller);
    if (currentModel !== active.targetModel && currentModel !== active.fromModel
        && exactNativeModel(owner.controller, currentModel)) {
      // Native drafts update optimistically. A different valid model does not
      // prove that its save succeeded, so leave the user's choice untouched
      // but require an explicit confirmed retry before sending.
      failRecovery("native-selection-changed-before-confirmed-save");
      return;
    }
    if (details.busy || owner.controller.daybreak?.isSaving) {
      active.stable = 0;
      return;
    }
    const currentEffort = controllerEffort(owner.controller);
    const targetInfo = modelEffortInfo(active.target);
    const effortConfirmed = active.expectedEffort
      ? currentEffort === active.expectedEffort
      : targetInfo.known
        ? (!targetInfo.efforts.length ? !currentEffort : targetInfo.efforts.includes(currentEffort))
        : !dangerousEfforts.has(currentEffort);
    const confirmed = active.saveResolved === true
      && currentModel === active.targetModel && effortConfirmed;
    active.stable = confirmed ? active.stable + 1 : 0;
    if (active.stable < 2) return;
    if (active.phase === "recovery-model" && active.requestedEffort
        && active.requestedEffort !== currentEffort) {
      active.phase = "recovery-effort";
      try {
        invokeRecoverySelection(owner, active.requestedEffort,
          typeof nativeReasoningSelector(owner.controller) === "function");
      } catch (error) { active.error = error; }
      return;
    }
    recoveryFailures.delete(owner.key);
    settledByOwner.set(owner.key, { model: currentModel, effort: currentEffort });
    finishOperation("aggregate-recovery-complete", { savedEffort: currentEffort });
  };
  const processOperation = (owner, details) => {
    if (!operation) return;
    if (operation.recovery) {
      processAggregateRecovery(owner, details);
      return;
    }
    if (!sameOwner(operation.owner, owner)) {
      finishOperation("transition-cancelled", { reason: "composer-changed" });
      return;
    }
    operation.owner = owner;
    const pending = ownerPending(details, owner);
    const exactBusy = pending.queued.length > 0 || pending.inFlight.length > 0;
    if (operation.error && !exactBusy) {
      beginRollback(owner, String(operation.error?.message || operation.error));
      return;
    }
    if (Date.now() - operation.startedAt > 30000) {
      if (exactBusy) {
        finishOperation("transition-unknown", { reason: "native-save-timeout" });
      } else {
        beginRollback(owner, "模型切换确认超时。");
      }
      return;
    }
    if (exactBusy || owner.controller.daybreak?.isSaving) {
      operation.stable = 0;
      return;
    }
    const confirmed = controllerModel(owner.controller) === operation.expectedModel
      && controllerEffort(owner.controller) === operation.expectedEffort;
    operation.stable = confirmed ? operation.stable + 1 : 0;
    if (operation.stable < 2) return;
    if (operation.phase === "transition") {
      operation.phase = "final";
      operation.expectedEffort = operation.requestedEffort;
      operation.stable = 0;
      operation.error = null;
      try {
        invokeReasoningEffort(owner, operation.requestedEffort, "final");
      } catch (error) {
        operation.error = error;
      }
      return;
    }
    if (operation.phase === "final") {
      settledByOwner.set(owner.key, {
        model: operation.targetModel,
        effort: operation.requestedEffort,
      });
      finishOperation("transition-complete");
      return;
    }
    if (operation.phase === "rollback") {
      settledByOwner.set(owner.key, {
        model: operation.fromModel,
        effort: operation.fromEffort,
      });
      finishOperation("transition-rolled-back");
    }
  };
  const scan = () => {
    if (disposed || !bindings) return;
    const owner = composerOwner();
    if (!owner) {
      if (operation?.recovery) failRecovery("composer-unavailable-before-confirmed-save");
      else if (operation) finishOperation("transition-cancelled", { reason: "composer-unavailable" });
      lastOwner = null;
      return;
    }
    if (operation && !sameOwner(operation.owner, owner)) {
      if (operation.recovery) failRecovery("composer-changed-before-confirmed-save");
      else finishOperation("transition-cancelled", { reason: "composer-changed" });
    }
    lastOwner = owner;
    guardController(owner);
    // React can replace the props object on every render. Retaining every
    // historical controller for the lifetime of the app would leak both the
    // props and their closures; only the currently visible composer needs a
    // direct wrapper. Stale menu callbacks remain covered by the pending
    // selection observer below.
    retainActiveController(owner.controller);
    const details = readAggregateNativeSelectionDetails(bindings, owner.chain);
    if (!details.known) return;
    if (operation) {
      processOperation(owner, details);
      return;
    }
    if (startAggregateRecovery(owner, details)) return;
    if (!protectTransitions) return;
    const pending = ownerPending(details, owner);
    const exactBusy = pending.queued.length > 0 || pending.inFlight.length > 0;
    if (!exactBusy && !owner.controller.daybreak?.isSaving) {
      const model = controllerModel(owner.controller);
      const effort = controllerEffort(owner.controller);
      if (model && effort) settledByOwner.set(owner.key, { model, effort });
      markBusy(false);
      return;
    }
    const settled = settledByOwner.get(owner.key);
    const fallbackSettled = settled || {
      model: controllerModel(owner.controller),
      effort: controllerEffort(owner.controller),
    };
    const pendingEntries = [...pending.inFlight, ...pending.queued];
    const dangerousPending = pendingEntries.find(entry => (
      isDangerousTransition(
        fallbackSettled.model,
        selectionModel(entry.selection),
        selectionEffort(entry.selection),
      )
    ));
    const requested = dangerousPending?.selection
      || latestSelection(pending.queued)
      || latestSelection(pending.inFlight);
    if (!requested) return;
    if (!settled && dangerousPending) {
      record("transition-blocked", {
        fromModel: fallbackSettled.model,
        targetModel: selectionModel(dangerousPending.selection),
        requestedEffort: selectionEffort(dangerousPending.selection),
        reason: "settled-selection-unavailable",
        source: pending.inFlight.includes(dangerousPending) ? "in-flight" : "queued",
      });
      return;
    }
    const repair = repairPendingTransitions(owner, pending, settled || fallbackSettled);
    if (repair?.blocked) {
      record("transition-blocked", {
        fromModel: (settled || fallbackSettled).model,
        targetModel: repair.requested?.model || selectionModel(requested),
        requestedEffort: repair.requested?.reasoningEffort || selectionEffort(requested),
        reason: repair.reason || "unsafe-transition",
        source: repair.source || (pending.inFlight.includes(dangerousPending) ? "in-flight" : "queued"),
      });
      return;
    }
    const guardedRequest = repair?.requested || snapshotSelection(requested);
    const result = startOperation(owner, guardedRequest, settled || fallbackSettled);
    if (result?.blocked) {
      record("transition-blocked", {
        fromModel: result.fromModel || fallbackSettled.model,
        targetModel: result.targetModel || selectionModel(requested),
        requestedEffort: result.requestedEffort || selectionEffort(requested),
        reason: result.reason || "unsafe-transition",
        source: pending.inFlight.includes(dangerousPending) ? "in-flight" : "queued",
      });
    }
  };
  const blockConcurrentSelection = event => {
    if (!operation || !sameOwner(operation.owner, composerOwner())) return;
    const target = event.target instanceof Element
      ? event.target.closest(
        '[data-reasoning-slider], [role="slider"], [data-model-picker-view-toggle],'
          + '[role="menuitemradio"]',
      )
      : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    record("transition-input-blocked", {
      targetModel: operation.targetModel,
      requestedEffort: operation.requestedEffort,
    });
  };
  const blockUnrecoveredSubmit = event => {
    if (!recoveryEnabled || disposed) return;
    const owner = composerOwner();
    if (!owner) return;
    const form = owner.button.closest("form, .composer-surface-chrome");
    const element = event.target instanceof Element ? event.target : null;
    if (!form || !element || !form.contains(element)) return;
    let submitting = event.type === "submit";
    if (event.type === "keydown") {
      submitting = event.key === "Enter" && !event.shiftKey && !event.isComposing
        && Boolean(element.closest('[contenteditable="true"], textarea, [role="textbox"]'));
    } else if (event.type === "click") {
      const button = element.closest("button");
      const label = String(button?.getAttribute("aria-label") || "").trim().toLowerCase();
      submitting = Boolean(button && (button.type === "submit"
        || button.matches('[data-testid="send-button"], [data-composer-navigation-target="send"]')
        || /^(send|send message|submit|发送|发送消息|提交)$/.test(label)));
    }
    if (!submitting) return;
    // Sending can happen before the periodic scan after a conversation change.
    // Check the live owner now and start its recovery before allowing a request.
    const stale = staleAggregateSelection(owner);
    if (stale && !operation) scan();
    const recovering = operation?.recovery && sameOwner(operation.owner, owner);
    const failed = recoveryFailures.get(owner.key);
    // A failed recovery cannot be cleared by any optimistic model label,
    // including a third native model. Only a confirmed explicit retry clears
    // this exact owner's failure marker. Other composers remain unaffected.
    const unconfirmed = Boolean(failed);
    if (!stale && !recovering && !unconfirmed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    record("aggregate-recovery-send-blocked", {
      fromModel: stale || operation?.fromModel || failed?.fromModel || "",
      reason: unconfirmed ? "native-save-unconfirmed" : "native-save-pending",
    });
  };

  for (const event of ["click", "keydown", "submit"]) {
    document.addEventListener(event, blockUnrecoveredSubmit, true);
  }
  try {
    bindings = await loadAggregateNativeSelectionBindings({
      assetUrl: codexAppAssetUrl,
      loadModule: loadCodexAppModule,
      fetch: url => fetch(url, { cache: "force-cache" }),
      document,
      location,
    });
  } catch (error) {
    for (const event of ["click", "keydown", "submit"]) {
      document.removeEventListener(event, blockUnrecoveredSubmit, true);
    }
    return {
      enabled: true,
      ready: false,
      version: CODEX_MODEL_TRANSITION_GUARD_VERSION,
      error: String(error?.message || error || "Codex 模型切换保护初始化失败。"),
    };
  }

  document.addEventListener("pointerdown", blockConcurrentSelection, true);
  document.addEventListener("keydown", blockConcurrentSelection, true);
  timer = setInterval(scan, 40);
  scan();
  runtime = {
    enabled: true,
    ready: wrappedControllers.size > 0,
    version: CODEX_MODEL_TRANSITION_GUARD_VERSION,
    error: "",
    wrappedControllerCount: wrappedControllers.size,
    dispose() {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("pointerdown", blockConcurrentSelection, true);
      document.removeEventListener("keydown", blockConcurrentSelection, true);
      for (const event of ["click", "keydown", "submit"]) {
        document.removeEventListener(event, blockUnrecoveredSubmit, true);
      }
      for (const [controller, wrapped] of wrappedControllers) {
        restoreController(controller, wrapped);
      }
      wrappedControllers.clear();
      publishRuntimeStatus();
      markBusy(false);
      if (window.__gaogeCodexModelTransitionGuard === runtime) {
        delete window.__gaogeCodexModelTransitionGuard;
      }
    },
  };
  publishRuntimeStatus();
  window.__gaogeCodexModelTransitionGuard = runtime;
  return runtime;
}
