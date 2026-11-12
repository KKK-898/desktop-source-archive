const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const SIDEBAR_GATE_RE = /([A-Z])\?\(0,\$\.jsx\)\(Sl,\{tooltipContent/
const APIKEY_GATE_FALLBACK_RE =
  /function\s+([A-Za-z_$])\(\1\)\{return\s+\1(?:===|!==)`(?:apikey|chatgpt)`\}/
const APIKEY_GATE_ALREADY_RE = /function\s+([A-Za-z_$])\(\1\)\{return false\}/
const EXTERNAL_BROWSER_FILTER_RE =
  /function (?<fn>[A-Za-z_$][\w$]*)\(e,\{isComputerUseAvailable:t,isExternalBrowserUseAvailable:n,isInAppBrowserUseAvailable:r\}\)\{return!\(!r&&(?<inapp>[A-Za-z_$][\w$]*)\(e\)\|\|!n&&(?<external>[A-Za-z_$][\w$]*)\(e\)\|\|!t&&(?<computer>[A-Za-z_$][\w$]*)\(e\)\)\}/
const CHROME_MARKETPLACE_DESCRIPTOR_RE =
  /(\{forceReload:!0,name:[^,]+,isAvailable:\(\{buildFlavor:e,features:t\}\)=>)(?<gate>[A-Za-z_$][\w$]*)\(e\)&&t\.externalBrowserUseAllowed\}/
const MODEL_PROVIDER_CONTROL_ENABLED_RES = [
  /,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*!==`cloud`&&[A-Za-z_$][\w$]*!=null,([A-Za-z_$][\w$]*);/g,
  /,([A-Za-z_$][\w$]*)=[^;]{1,220}?(?:!==|!=)(?:`cloud`|'cloud'|"cloud")[^;]{0,220}?&&[^;]{1,220}?(?:!==|!=)null,([A-Za-z_$][\w$]*);/g,
]
const MODEL_PROVIDER_CONTROL_DISABLED_RE = /,([A-Za-z_$][\w$]*)=(?:!1|false),([A-Za-z_$][\w$]*);/
const MODEL_PROVIDER_ID_RE = /id:(['"`])model-provider\1/g
const MODEL_PROVIDER_BADGE_CSS_MARKER = 'gaogeaii-hide-model-provider-badge-v2'
const MODEL_PICKER_FILTER_ORIGINAL_KEY = 'useHiddenModels'
const MODEL_PICKER_FILTER_PATCHED_KEY = 'useHiddenModelZ'
const MODEL_PICKER_FILTER_REQUIRED_KEYS = [
  'authMethod',
  'availableModels',
  'defaultModel',
  'enabledReasoningEfforts',
  'includeUltraReasoningEffort',
  'models',
]
const MODEL_PICKER_FILTER_SIGNATURE_RE = /function\s+[A-Za-z_$][\w$]*\s*\(\s*\{\s*authMethod\s*:\s*[A-Za-z_$][\w$]*\s*,\s*availableModels\s*:\s*[A-Za-z_$][\w$]*\s*,\s*defaultModel\s*:\s*[A-Za-z_$][\w$]*\s*,\s*enabledReasoningEfforts\s*:\s*[A-Za-z_$][\w$]*\s*,\s*includeUltraReasoningEffort\s*:\s*[A-Za-z_$][\w$]*\s*,\s*models\s*:\s*[A-Za-z_$][\w$]*\s*,\s*(?<key>useHiddenModels|useHiddenModelZ)\s*:\s*[A-Za-z_$][\w$]*\s*\}\s*\)/g
const APIKEY_SERVICE_TIER_GATE_REQUIRED_KEYS = [
  'authMethod===`chatgpt`',
  'featureRequirements?.fast_mode',
  'isPending:',
  'isServiceTierAllowed:',
]
const APIKEY_SERVICE_TIER_GATE_ORIGINAL_RE = /(?<loading>[A-Za-z_$][\w$]*)=!!(?<authState>[A-Za-z_$][\w$]*)\?\.isLoading\|\|(?<chatgpt>[A-Za-z_$][\w$]*)&&(?<pending>[A-Za-z_$][\w$]*),(?<allowed>[A-Za-z_$][\w$]*)=\k<chatgpt>&&!\k<loading>&&(?<plan>[A-Za-z_$][\w$]*)!=null&&\k<plan>\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1/g
const APIKEY_SERVICE_TIER_GATE_PATCHED_RE = /(?<loading>[A-Za-z_$][\w$]*)=(?<authState>[A-Za-z_$][\w$]*)\?\.isLoading\|\|(?<chatgpt>[A-Za-z_$][\w$]*)&&(?<pending>[A-Za-z_$][\w$]*),(?<allowed>[A-Za-z_$][\w$]*)=\k<loading>\?0:\k<chatgpt>\?(?<plan>[A-Za-z_$][\w$]*)&&\k<plan>\.requirements\?\.featureRequirements\?\.fast_mode!=0:(?<authMethod>[A-Za-z_$][\w$]*)==`apikey`/g
const MODEL_PROVIDER_BADGE_CSS = [
  '',
  `/* ${MODEL_PROVIDER_BADGE_CSS_MARKER} */`,
  '#model-provider,',
  '[id="model-provider"],',
  '.model-provider,',
  '[class*="model-provider" i],',
  '[data-testid*="model-provider" i],',
  '[data-test-id*="model-provider" i],',
  '[data-testid="model-provider"],',
  '[data-test-id="model-provider"],',
  '[aria-label*="model provider" i],',
  '[aria-label*="provider" i],',
  '[aria-label*="供应商"],',
  '[title*="model provider" i],',
  '[title*="provider" i],',
  '[title*="供应商"],',
  'button:has(#model-provider),',
  'button:has([id="model-provider"]),',
  'button:has([data-testid*="model-provider" i]),',
  'button:has([data-test-id*="model-provider" i]),',
  '[role="button"]:has(#model-provider),',
  '[role="button"]:has([id="model-provider"]),',
  '[role="button"]:has([data-testid*="model-provider" i]),',
  '[role="button"]:has([data-test-id*="model-provider" i]) {',
  '  display: none !important;',
  '  visibility: hidden !important;',
  '  width: 0 !important;',
  '  min-width: 0 !important;',
  '  max-width: 0 !important;',
  '  height: 0 !important;',
  '  margin: 0 !important;',
  '  padding: 0 !important;',
  '  border: 0 !important;',
  '  overflow: hidden !important;',
  '}',
  '',
].join('\n')
const PLUGIN_MARKETPLACE_RUNTIME_MARKER = '__gaogeCodexPluginMarketplaceRuntimeV5'
const PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT = `
;(() => {
  const marker = "${PLUGIN_MARKETPLACE_RUNTIME_MARKER}";
  if (window[marker] === "5") return;
  window[marker] = "5";
  const pluginMarketplacePatchVersion = "5";
  const officialMarketplaces = new Set(["openai-bundled", "openai-curated", "openai-api-curated", "openai-curated-remote", "openai-primary-runtime", "role-specific-plugins", "gaoge-openai-bundled", "gaoge-openai-curated", "gaoge-openai-primary-runtime"]);
  const modulePromises = new Map();

  function reactFiberFrom(element) {
    if (!element) return null;
    const keys = Object.keys(element);
    const key = keys.find((item) => item.startsWith("__reactFiber$") || item.startsWith("__reactInternalInstance$"));
    return key ? element[key] : null;
  }

  function patchReactDisabledProps(element) {
    if (!element) return;
    Object.keys(element)
      .filter((key) => key.startsWith("__reactProps"))
      .forEach((key) => {
        const props = element[key];
        if (!props || typeof props !== "object") return;
        props.disabled = false;
        props["aria-disabled"] = false;
        props["data-disabled"] = undefined;
      });
    let fiber = reactFiberFrom(element);
    for (let depth = 0; fiber && depth < 8; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (!props || typeof props !== "object") continue;
      props.disabled = false;
      props["aria-disabled"] = false;
      props["data-disabled"] = undefined;
    }
  }

  function spoofChatGPTAuthMethod(element) {
    let fiber = reactFiberFrom(element);
    for (let depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const candidates = [props, props?.value, fiber.memoizedState, fiber.stateNode?.props].filter(Boolean);
      for (const candidate of candidates) {
        if (candidate && typeof candidate.setAuthMethod === "function") {
          try {
            candidate.setAuthMethod("chatgpt");
            return true;
          } catch (_) {}
        }
        if (candidate && typeof candidate.authMethod === "string") {
          try {
            candidate.authMethod = "chatgpt";
            return true;
          } catch (_) {}
        }
      }
    }
    return false;
  }

  function pluginEntryButtons() {
    const buttons = Array.from(document.querySelectorAll("button, a, [role='button']"));
    return buttons.filter((button) => {
      const text = (button.textContent || button.getAttribute("aria-label") || button.getAttribute("title") || "").toLowerCase();
      return text.includes("plugin") || text.includes("插件") || button.querySelector("svg path[d^='M7.94562 14.0277']");
    });
  }

  function enablePluginEntry() {
    for (const button of pluginEntryButtons()) {
      button.disabled = false;
      button.removeAttribute("disabled");
      button.setAttribute("aria-disabled", "false");
      button.dataset.gaogePluginEntryUnlocked = "true";
      button.classList.remove("cursor-not-allowed", "pointer-events-none", "opacity-50");
      button.style.pointerEvents = "auto";
      button.style.opacity = "1";
      patchReactDisabledProps(button);
      spoofChatGPTAuthMethod(button);
      if (!button.dataset.gaogePluginClickSpoofed) {
        button.dataset.gaogePluginClickSpoofed = "true";
        button.addEventListener("click", () => spoofChatGPTAuthMethod(button), true);
      }
    }
  }

  function unlockInstallButtons() {
    const selector = "button:disabled, button[aria-disabled='true'], [role='button'][aria-disabled='true'], button[data-disabled], [role='button'][data-disabled], button.cursor-not-allowed, [role='button'].cursor-not-allowed, button.pointer-events-none, [role='button'].pointer-events-none";
    for (const button of document.querySelectorAll(selector)) {
      const text = (button.textContent || button.getAttribute("aria-label") || button.getAttribute("title") || "").toLowerCase();
      const looksPluginInstall = text.includes("install") || text.includes("enable") || text.includes("load") || text.includes("安装") || text.includes("启用") || text.includes("加载") || text.includes("unavailable") || text.includes("不可用");
      if (!looksPluginInstall && !button.closest("[data-testid*='plugin' i], [class*='plugin' i], [id*='plugin' i]")) continue;
      button.disabled = false;
      button.removeAttribute("disabled");
      button.setAttribute("aria-disabled", "false");
      button.removeAttribute("data-disabled");
      button.classList.remove("cursor-not-allowed", "pointer-events-none", "opacity-50");
      button.style.pointerEvents = "auto";
      button.style.opacity = "1";
      button.dataset.gaogeForcePluginUnlocked = "true";
      patchReactDisabledProps(button);
      button.querySelectorAll?.("button, [role='button'], [disabled], [aria-disabled], [data-disabled]").forEach((node) => {
        node.disabled = false;
        node.removeAttribute("disabled");
        node.setAttribute("aria-disabled", "false");
        node.removeAttribute("data-disabled");
        patchReactDisabledProps(node);
      });
    }
  }

  function codexAppAssetUrl(namePart) {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
  }

  async function loadCodexAppModule(namePart) {
    if (!modulePromises.has(namePart)) {
      const promise = Promise.resolve().then(async () => {
        const url = codexAppAssetUrl(namePart);
        if (!url) throw new Error("Codex App asset not found: " + namePart);
        return await import(url);
      }).catch((error) => {
        modulePromises.delete(namePart);
        throw error;
      });
      modulePromises.set(namePart, promise);
    }
    return await modulePromises.get(namePart);
  }

  function restorePluginMarketplaceName(name) {
    if (name === "gaoge-openai-bundled") return "openai-bundled";
    if (name === "gaoge-openai-curated") return "openai-curated";
    if (name === "gaoge-openai-primary-runtime") return "openai-primary-runtime";
    return name;
  }

  function pluginMarketplaceDisplayName(name) {
    const restored = restorePluginMarketplaceName(name);
    if (restored === "openai-bundled") return "OpenAI Bundled Plugins";
    if (restored === "openai-curated") return "OpenAI Curated Plugins";
    if (restored === "openai-api-curated") return "OpenAI API Curated Plugins";
    if (restored === "openai-curated-remote") return "OpenAI Remote Plugins";
    if (restored === "openai-primary-runtime") return "OpenAI Plugin Runtime";
    if (restored === "role-specific-plugins") return "OpenAI Role Plugins";
    return "";
  }

  function officialMarketplaceName(name) {
    const value = String(name || "");
    return officialMarketplaces.has(value) || officialMarketplaces.has(restorePluginMarketplaceName(value));
  }

  function patchListPluginsPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const next = { ...payload };
    const nextKinds = Array.isArray(next.marketplaceKinds)
      ? next.marketplaceKinds.map((kind) => restorePluginMarketplaceName(kind))
      : ["local"];
    if (!nextKinds.includes("vertical")) nextKinds.push("vertical");
    next.marketplaceKinds = Array.from(new Set(nextKinds));
    delete next.buildFlavor;
    if (next.params && typeof next.params === "object") {
      next.params = patchListPluginsPayload(next.params);
    }
    return next;
  }

  function restoreInstallPluginPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const next = { ...payload };
    if (Array.isArray(next.marketplaceKinds)) {
      next.marketplaceKinds = next.marketplaceKinds.map((kind) => restorePluginMarketplaceName(kind === "remote:openai-curated" ? "openai-curated" : kind));
    }
    if (next.remoteMarketplaceName) next.remoteMarketplaceName = restorePluginMarketplaceName(next.remoteMarketplaceName);
    if (typeof next.marketplacePath === "string" && next.marketplacePath.startsWith("remote:")) {
      next.remoteMarketplaceName = restorePluginMarketplaceName(next.marketplacePath.slice("remote:".length));
      delete next.marketplacePath;
    }
    if (next.params && typeof next.params === "object") {
      next.params = restoreInstallPluginPayload(next.params);
    }
    return next;
  }

  function normalizePluginRequestMethod(method) {
    const value = String(method || "");
    if (value === "plugin/list" || value.includes("plugin/list") || value.includes("list-plugins")) return "list-plugins";
    if (value === "plugin/install" || value.includes("plugin/install") || value.includes("install-plugin")) return "install-plugin";
    return value;
  }

  function appServerRequestMethod(method, params) {
    if (method === "send-cli-request-for-host" && params?.method) return normalizePluginRequestMethod(params.method);
    if (params && typeof params === "object" && typeof params.method === "string") return normalizePluginRequestMethod(params.method);
    return normalizePluginRequestMethod(method);
  }

  function patchPluginRequestParams(method, params) {
    const normalized = normalizePluginRequestMethod(method);
    if (normalized === "list-plugins") return patchListPluginsPayload(params);
    if (normalized === "install-plugin") return restoreInstallPluginPayload(params);
    return params;
  }

  function patchPluginMarketplaceObject(marketplace) {
    if (!marketplace || typeof marketplace !== "object" || marketplace.__gaogeMarketplacePatched) return false;
    const originalName = marketplace.name || marketplace.marketplaceName || "";
    if (!officialMarketplaceName(originalName)) return false;
    const displayName = pluginMarketplaceDisplayName(originalName) || String(originalName);
    marketplace.displayName = marketplace.displayName || displayName;
    marketplace.title = marketplace.title || marketplace.displayName;
    marketplace.label = marketplace.label || marketplace.displayName;
    if (marketplace.interface && typeof marketplace.interface === "object") {
      marketplace.interface.displayName = marketplace.interface.displayName || marketplace.displayName;
      marketplace.interface.title = marketplace.interface.title || marketplace.title;
      marketplace.interface.label = marketplace.interface.label || marketplace.label;
    }
    marketplace.__gaogeMarketplacePatched = true;
    return true;
  }

  function patchPluginMarketplaceResult(method, result) {
    if (normalizePluginRequestMethod(method) !== "list-plugins") return result;
    try {
      if (Array.isArray(result?.marketplaces)) {
        result.marketplaces.forEach((marketplace) => {
          patchPluginMarketplaceObject(marketplace);
          if (Array.isArray(marketplace?.plugins)) {
            marketplace.plugins.forEach((plugin) => {
              if (plugin && typeof plugin === "object" && !plugin.marketplaceName && marketplace.name) {
                plugin.marketplaceName = marketplace.name;
              }
            });
          }
        });
        updatePluginDirectorySearchIndex(result);
      }
    } catch (_) {}
    return result;
  }

  function isOfficialPluginArrayFilter(callback, sample) {
    if (!Array.isArray(sample) || sample.length === 0 || typeof callback !== "function") return false;
    let source = "";
    try {
      source = Function.prototype.toString.call(callback);
    } catch (_) {
      return false;
    }
    if (!/marketplaceName|marketplace|buildFlavor|!t\\.includes|!u\\(/.test(source)) return false;
    for (let index = 0; index < sample.length; index += 1) {
      const item = sample[index];
      if (!officialMarketplaceName(item?.marketplaceName || item?.name)) continue;
      try {
        if (!callback(item, index, sample)) return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function installPluginBuildFlavorFilterPatch() {
    if (Array.prototype.filter.__gaogePluginMarketplacePatch === pluginMarketplacePatchVersion) return false;
    const originalFilter = Array.prototype.__gaogePluginOriginalFilter || Array.prototype.filter;
    if (!Array.prototype.__gaogePluginOriginalFilter) {
      Object.defineProperty(Array.prototype, "__gaogePluginOriginalFilter", {
        value: originalFilter,
        configurable: true,
        writable: true,
      });
    }
    const patchedFilter = function gaogePluginMarketplaceFilter(callback, thisArg) {
      if (isOfficialPluginArrayFilter(callback, this)) return Array.from(this);
      return originalFilter.call(this, callback, thisArg);
    };
    patchedFilter.__gaogePluginMarketplacePatch = pluginMarketplacePatchVersion;
    Array.prototype.filter = patchedFilter;
    return true;
  }

  function patchPluginMarketplaceRequestClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    window.__gaogeCodexAppServerClient = client;
    if (client.__gaogePluginMarketplacePatch === pluginMarketplacePatchVersion) return true;
    const originalSendRequest = client.__gaogePluginOriginalSendRequest || client.sendRequest.bind(client);
    client.__gaogePluginOriginalSendRequest = originalSendRequest;
    client.sendRequest = async function gaogePluginPatchedSendRequest(method, params, options) {
      const requestMethod = appServerRequestMethod(String(method || ""), params);
      const requestParams = patchPluginRequestParams(requestMethod, params);
      if (requestMethod === "install-plugin") spoofChatGPTAuthMethod(document.body);
      const result = await originalSendRequest(method, requestParams, options);
      return patchPluginMarketplaceResult(requestMethod, result);
    };
    client.__gaogePluginMarketplacePatch = pluginMarketplacePatchVersion;
    return true;
  }

  async function installPluginMarketplaceRequestPatch() {
    if (window.__gaogePluginMarketplaceRequestPatch === pluginMarketplacePatchVersion) return 0;
    try {
      const module = await loadCodexAppModule("app-server-manager-signals-");
      const candidates = Object.values(module || {}).filter((value) => value && typeof value === "object");
      let patched = 0;
      for (const candidate of candidates) {
        if (patchPluginMarketplaceRequestClient(candidate)) patched += 1;
        if (typeof candidate.sendRequest !== "function" && typeof candidate.get === "function") {
          try {
            if (patchPluginMarketplaceRequestClient(candidate.get())) patched += 1;
          } catch (_) {}
        }
      }
      if (patched > 0) window.__gaogePluginMarketplaceRequestPatch = pluginMarketplacePatchVersion;
      return patched;
    } catch (_) {
      return 0;
    }
  }

  function installFetchPatch() {
    if (window.__gaogePluginMarketplaceFetchPatch || typeof window.fetch !== "function") return false;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      let nextInit = init;
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        const body = init?.body;
        const bodyText = typeof body === "string" ? body : "";
        if ((url.includes("list-plugins") || bodyText.includes("list-plugins")) && bodyText.trim().startsWith("{")) {
          nextInit = { ...init, body: JSON.stringify(patchListPluginsPayload(JSON.parse(bodyText))) };
        }
        if ((url.includes("install-plugin") || bodyText.includes("install-plugin")) && bodyText.trim().startsWith("{")) {
          spoofChatGPTAuthMethod(document.body);
          nextInit = { ...init, body: JSON.stringify(restoreInstallPluginPayload(JSON.parse(bodyText))) };
        }
      } catch (_) {}
      return await originalFetch(input, nextInit);
    };
    window.__gaogePluginMarketplaceFetchPatch = true;
    return true;
  }

  function pluginDirectoryToolsState() {
    const existing = window.__gaogePluginDirectoryTools;
    if (existing?.version === 1) return existing;
    const state = {
      version: 1,
      searchReady: false,
      indexedPlugins: 0,
      renderedPlugins: 0,
      autoExpandClicks: 0,
      autoExpandRunning: false,
      autoExpandTimer: 0,
      lastExpandSignature: "",
      refresh: null,
    };
    window.__gaogePluginDirectoryTools = state;
    return state;
  }

  function normalizedPluginSearchText(value) {
    return String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
  }

  function pluginDisplayName(plugin) {
    return String(
      plugin?.interface?.displayName
      || plugin?.displayName
      || plugin?.title
      || plugin?.name
      || plugin?.pluginName
      || plugin?.id
      || ""
    ).trim();
  }

  function updatePluginDirectorySearchIndex(result) {
    if (!Array.isArray(result?.marketplaces)) return 0;
    const index = window.__gaogePluginDirectorySearchIndex instanceof Map
      ? window.__gaogePluginDirectorySearchIndex
      : new Map();
    for (const marketplace of result.marketplaces) {
      const marketplaceName = String(
        marketplace?.displayName
        || marketplace?.title
        || marketplace?.name
        || marketplace?.marketplaceName
        || ""
      ).trim();
      for (const plugin of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
        const displayName = pluginDisplayName(plugin);
        const id = String(plugin?.id || ((plugin?.name || displayName) + "@" + (marketplace?.name || ""))).trim();
        if (!displayName || !id) continue;
        const keywords = Array.isArray(plugin?.keywords) ? plugin.keywords.join(" ") : String(plugin?.keywords || "");
        const description = String(
          plugin?.description
          || plugin?.summary
          || plugin?.interface?.description
          || plugin?.interface?.summary
          || ""
        );
        const aliases = [
          displayName,
          plugin?.name,
          plugin?.pluginName,
          plugin?.title,
        ].map(normalizedPluginSearchText).filter(Boolean);
        index.set(id, {
          id,
          aliases,
          haystack: normalizedPluginSearchText([
            displayName,
            plugin?.name,
            plugin?.pluginName,
            plugin?.id,
            description,
            keywords,
            marketplaceName,
            marketplace?.name,
          ].filter(Boolean).join(" ")),
        });
      }
    }
    window.__gaogePluginDirectorySearchIndex = index;
    const state = pluginDirectoryToolsState();
    state.indexedPlugins = index.size;
    queueMicrotask(() => state.refresh?.());
    return index.size;
  }

  function pluginDirectoryNavActive() {
    return pluginEntryButtons().some((button) => {
      if (button.getAttribute("aria-current") === "page") return true;
      if (button.getAttribute("data-state") === "active") return true;
      return button.dataset.gaogePluginDirectoryActive === "true";
    });
  }

  function pluginDirectoryRoot() {
    const root = document.querySelector("main, [role='main']");
    if (!(root instanceof HTMLElement)) return null;
    if (pluginDirectoryNavActive()) return root;
    const controls = [...root.querySelectorAll("button, [role='button']")];
    const pluginActions = controls.filter((button) => /^(install|installed|enable|open|view|安装|已安装|启用|打开|查看)$/i.test(
      String(button.textContent || button.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim()
    ));
    const text = String(root.innerText || "");
    return pluginActions.length >= 2 && /插件|plugins?|marketplace|市场/i.test(text) ? root : null;
  }

  function visiblePluginElement(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function pluginCardForLabel(element, root) {
    let node = element;
    let semantic = null;
    for (let depth = 0; node instanceof HTMLElement && node !== root && depth < 9; depth += 1, node = node.parentElement) {
      if (node.closest("#gaoge-plugin-directory-toolbar")) return null;
      const text = String(node.innerText || "");
      if (text.length > 7000) continue;
      if (!semantic && node.matches("article, li, [role='listitem'], [data-testid*='plugin' i], [class*='plugin-card' i]")) {
        semantic = node;
      }
      const action = [...node.querySelectorAll("button, [role='button']")].some((button) => /^(install|installed|enable|open|view|安装|已安装|启用|打开|查看)$/i.test(
        String(button.textContent || button.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim()
      ));
      if (action) return node;
    }
    return semantic;
  }

  function markRenderedPluginItems(root) {
    root.querySelectorAll("[data-gaoge-plugin-search-item]").forEach((item) => {
      delete item.dataset.gaogePluginSearchItem;
      delete item.dataset.gaogePluginSearchText;
      item.style.display = item.dataset.gaogePluginPreviousDisplay || "";
      delete item.dataset.gaogePluginPreviousDisplay;
    });
    const index = window.__gaogePluginDirectorySearchIndex;
    if (!(index instanceof Map) || index.size === 0) return [];
    const aliases = new Map();
    index.forEach((entry) => {
      entry.aliases.forEach((alias) => {
        if (alias.length >= 2 && !aliases.has(alias)) aliases.set(alias, entry);
      });
    });
    const cards = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const label = normalizedPluginSearchText(textNode.nodeValue);
      const entry = aliases.get(label);
      if (entry) {
        const card = pluginCardForLabel(textNode.parentElement, root);
        if (card && !cards.has(card)) cards.set(card, entry.haystack);
      }
      textNode = walker.nextNode();
    }
    cards.forEach((haystack, card) => {
      card.dataset.gaogePluginSearchItem = "true";
      card.dataset.gaogePluginSearchText = haystack;
    });
    return [...cards.keys()];
  }

  function applyPluginDirectorySearch(root, input, count) {
    const query = normalizedPluginSearchText(input?.value);
    const cards = markRenderedPluginItems(root);
    let visible = 0;
    cards.forEach((card) => {
      const matches = !query || String(card.dataset.gaogePluginSearchText || "").includes(query);
      if (!matches) {
        if (card.dataset.gaogePluginPreviousDisplay == null) {
          card.dataset.gaogePluginPreviousDisplay = card.style.display || "";
        }
        card.style.display = "none";
      } else {
        card.style.display = card.dataset.gaogePluginPreviousDisplay || "";
        delete card.dataset.gaogePluginPreviousDisplay;
        visible += 1;
      }
    });
    if (count) count.textContent = query ? visible + " / " + cards.length : String(cards.length);
    const state = pluginDirectoryToolsState();
    state.renderedPlugins = cards.length;
    state.searchReady = !!input?.isConnected;
  }

  function installPluginDirectorySearch(root) {
    let toolbar = document.getElementById("gaoge-plugin-directory-toolbar");
    if (toolbar && !root.contains(toolbar)) toolbar.remove();
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = "gaoge-plugin-directory-toolbar";
      toolbar.innerHTML = [
        '<label class="gaoge-plugin-search-field">',
        '<span class="gaoge-plugin-search-icon" aria-hidden="true">⌕</span>',
        '<input type="search" autocomplete="off" placeholder="搜索插件名称、描述或关键词" aria-label="搜索插件">',
        '<button type="button" class="gaoge-plugin-search-clear" aria-label="清空插件搜索" title="清空">×</button>',
        '</label>',
        '<span class="gaoge-plugin-search-count" aria-live="polite"></span>',
      ].join("");
      if (!document.getElementById("gaoge-plugin-directory-style")) {
        const style = document.createElement("style");
        style.id = "gaoge-plugin-directory-style";
        style.textContent = [
          "#gaoge-plugin-directory-toolbar{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:min(720px,calc(100% - 32px));min-height:40px;margin:14px auto 8px;padding:0 10px;border:1px solid var(--color-token-border,#3f3f46);border-radius:6px;background:var(--color-token-main-surface-primary,#18181b);color:var(--color-token-foreground,#f4f4f5);font:13px/1.4 system-ui,sans-serif;}",
          ".gaoge-plugin-search-field{display:flex;min-width:0;flex:1;align-items:center;gap:8px;}",
          ".gaoge-plugin-search-icon{color:var(--color-token-text-tertiary,#a1a1aa);font-size:18px;line-height:1;}",
          "#gaoge-plugin-directory-toolbar input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:inherit;font:inherit;letter-spacing:0;}",
          "#gaoge-plugin-directory-toolbar input::placeholder{color:var(--color-token-text-tertiary,#a1a1aa);}",
          ".gaoge-plugin-search-clear{display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;border:0;border-radius:4px;background:transparent;color:var(--color-token-text-tertiary,#a1a1aa);font:18px/1 system-ui,sans-serif;cursor:pointer;}",
          ".gaoge-plugin-search-clear:hover{background:var(--color-token-list-hover-background,rgba(255,255,255,.08));color:inherit;}",
          ".gaoge-plugin-search-count{min-width:48px;color:var(--color-token-text-tertiary,#a1a1aa);text-align:right;font-variant-numeric:tabular-nums;}",
        ].join("\\n");
        document.documentElement.appendChild(style);
      }
      root.insertBefore(toolbar, root.firstChild);
      const input = toolbar.querySelector("input");
      const clear = toolbar.querySelector(".gaoge-plugin-search-clear");
      const count = toolbar.querySelector(".gaoge-plugin-search-count");
      input.addEventListener("input", () => applyPluginDirectorySearch(root, input, count));
      clear.addEventListener("click", () => {
        input.value = "";
        input.focus();
        applyPluginDirectorySearch(root, input, count);
      });
    }
    const input = toolbar.querySelector("input");
    const count = toolbar.querySelector(".gaoge-plugin-search-count");
    applyPluginDirectorySearch(root, input, count);
    return true;
  }

  function pluginExpandButtonCandidates(root) {
    return [...root.querySelectorAll("button, [role='button']")]
      .filter(visiblePluginElement)
      .filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true")
      .filter((button) => {
        const text = String(button.textContent || button.getAttribute("aria-label") || button.getAttribute("title") || "")
          .replace(/\\s+/g, " ")
          .trim();
        if (!text || text.length > 120) return false;
        if (/^(更多|显示更多|查看更多|加载更多|show more|load more|more)$/i.test(text)) return true;
        if (/^查看\\s+.+以及另外\\s*\\d+\\s*个$/i.test(text)) return true;
        return /^(view|show)\\s+.+\\s+and\\s+\\d+\\s+more$/i.test(text);
      })
      .filter((button) => !button.closest("#gaoge-plugin-directory-toolbar"));
  }

  function schedulePluginAutoExpand(root, force = false) {
    const state = pluginDirectoryToolsState();
    if (state.autoExpandRunning && !force) return;
    clearTimeout(state.autoExpandTimer);
    state.autoExpandTimer = setTimeout(() => {
      const buttons = pluginExpandButtonCandidates(root);
      const signature = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return String(button.textContent || "").trim() + ":" + Math.round(rect.top) + ":" + Math.round(rect.left);
      }).join("|");
      if (!force && signature && signature === state.lastExpandSignature) return;
      state.lastExpandSignature = signature;
      state.autoExpandRunning = true;
      state.autoExpandClicks = 0;
      const clickNext = () => {
        const currentRoot = pluginDirectoryRoot();
        const button = currentRoot ? pluginExpandButtonCandidates(currentRoot)[0] : null;
        if (!button || state.autoExpandClicks >= 80) {
          state.autoExpandRunning = false;
          state.refresh?.();
          return;
        }
        state.autoExpandClicks += 1;
        button.click();
        setTimeout(clickNext, 90);
      };
      clickNext();
    }, force ? 30 : 180);
  }

  function refreshPluginDirectoryTools() {
    const state = pluginDirectoryToolsState();
    const root = pluginDirectoryRoot();
    if (!root) {
      document.getElementById("gaoge-plugin-directory-toolbar")?.remove();
      state.searchReady = false;
      state.renderedPlugins = 0;
      return false;
    }
    installPluginDirectorySearch(root);
    schedulePluginAutoExpand(root);
    return true;
  }

  pluginDirectoryToolsState().refresh = refreshPluginDirectoryTools;

  function refreshPluginMarketplaceUnlock() {
    enablePluginEntry();
    unlockInstallButtons();
    installPluginBuildFlavorFilterPatch();
    installFetchPatch();
    void installPluginMarketplaceRequestPatch();
    refreshPluginDirectoryTools();
  }

  function installSessionDeleteRuntime() {
    const existing = window.__gaogeNativeSessionDeleteRuntime;
    if (existing?.version === 5) {
      existing.scan?.();
      return existing;
    }

    const state = {
      version: 5,
      timer: 0,
      observer: null,
      scan: null,
      hiddenThreadIds: new Set(),
    };
    window.__gaogeNativeSessionDeleteRuntime = state;
    const buttonClass = "gaoge-codex-session-delete";
    const styleId = "gaoge-codex-session-delete-style";

    function installStyle() {
      if (document.getElementById(styleId)) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = [
        "[data-app-action-sidebar-thread-id] { position: relative; }",
        "." + buttonClass + " { position: absolute; right: 60px; top: 50%; transform: translateY(-50%); z-index: 11; display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: #ef4444; opacity: 0; cursor: pointer; transition: opacity .12s ease, background-color .12s ease; }",
        "[data-app-action-sidebar-thread-id]:hover ." + buttonClass + ", ." + buttonClass + ":focus { opacity: 1; background: rgba(239,68,68,.12); }",
        "." + buttonClass + "[disabled] { opacity: .45; cursor: wait; }",
        ".gaoge-codex-delete-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647; border-radius: 9px; background: rgba(17,24,39,.94); color: white; padding: 9px 13px; font: 13px/1.4 system-ui,sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.28); }",
      ].join("\\n");
      document.documentElement.appendChild(style);
    }

    function toast(message) {
      document.querySelectorAll(".gaoge-codex-delete-toast").forEach((node) => node.remove());
      const node = document.createElement("div");
      node.className = "gaoge-codex-delete-toast";
      node.textContent = String(message || "");
      document.body.appendChild(node);
      setTimeout(() => node.remove(), 3200);
    }

    function sessionRows(threadId) {
      return [...document.querySelectorAll("[data-app-action-sidebar-thread-id]")]
        .filter((row) => String(row.getAttribute("data-app-action-sidebar-thread-id") || "").trim() === threadId);
    }

    function hideSessionRows(threadId) {
      sessionRows(threadId).forEach((row) => {
        if (row.dataset.gaogeSessionDeleteHidden !== "true") {
          row.dataset.gaogeSessionDeleteHidden = "true";
          row.dataset.gaogeSessionDeletePreviousDisplay = row.style.display;
        }
        row.setAttribute("aria-busy", "true");
        row.style.display = "none";
      });
    }

    function restoreSessionRows(threadId) {
      sessionRows(threadId).forEach((row) => {
        if (row.dataset.gaogeSessionDeleteHidden === "true") {
          row.style.display = row.dataset.gaogeSessionDeletePreviousDisplay || "";
          delete row.dataset.gaogeSessionDeleteHidden;
          delete row.dataset.gaogeSessionDeletePreviousDisplay;
        }
        row.removeAttribute("aria-busy");
        const button = row.querySelector("." + buttonClass);
        if (button) button.disabled = false;
      });
    }

    function removeSessionRows(threadId) {
      sessionRows(threadId).forEach((row) => row.remove());
    }

    function replacementSessionRow(threadId) {
      const rows = [...document.querySelectorAll("[data-app-action-sidebar-thread-id]")];
      const currentIndex = rows.findIndex((row) =>
        String(row.getAttribute("data-app-action-sidebar-thread-id") || "").trim() === threadId
      );
      const candidates = currentIndex >= 0
        ? [...rows.slice(currentIndex + 1), ...rows.slice(0, currentIndex).reverse()]
        : rows;
      return candidates.find((row) => {
        const candidateId = String(row.getAttribute("data-app-action-sidebar-thread-id") || "").trim();
        return candidateId && candidateId !== threadId && !state.hiddenThreadIds.has(candidateId);
      }) || null;
    }

    function openReplacementSession(preferredRow, threadId) {
      requestAnimationFrame(() => {
        const nextRow = preferredRow?.isConnected ? preferredRow : replacementSessionRow(threadId);
        if (typeof nextRow?.click === "function") {
          nextRow.click();
        } else if (history.length > 1) {
          history.back();
        }
      });
    }

    async function deleteThread(threadId) {
      const client = window.__gaogeCodexAppServerClient;
      if (!client || typeof client.sendRequest !== "function") {
        throw new Error("Codex 服务尚未连接，请稍后重试");
      }
      return await client.sendRequest(
        "thread/delete",
        { threadId },
        { priority: "interactive", source: "gaoge_session_delete", timeoutMs: 15000 },
      );
    }

    function attachButton(row) {
      if (!(row instanceof Element)) return;
      const threadId = String(row.getAttribute("data-app-action-sidebar-thread-id") || "").trim();
      if (!threadId) return;
      if (state.hiddenThreadIds.has(threadId)) {
        hideSessionRows(threadId);
        return;
      }
      if (row.querySelector("." + buttonClass)) return;
      const title = String(row.querySelector("[data-thread-title], .truncate")?.textContent || "未命名会话").trim();
      const button = document.createElement("button");
      button.type = "button";
      button.className = buttonClass;
      button.setAttribute("aria-label", "删除会话");
      button.title = "删除会话";
      button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
      ["pointerdown", "mousedown", "mouseup"].forEach((name) => button.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true));
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (!window.confirm("确定删除会话“" + (title || threadId) + "”吗？\\n\\n删除后无法恢复。")) return;
        const current = row.getAttribute("aria-current") === "page" || location.href.includes(threadId);
        const replacementRow = current ? replacementSessionRow(threadId) : null;
        button.disabled = true;
        state.hiddenThreadIds.add(threadId);
        hideSessionRows(threadId);
        toast("已删除会话");
        if (current) openReplacementSession(replacementRow, threadId);
        try {
          await deleteThread(threadId);
          removeSessionRows(threadId);
        } catch (error) {
          state.hiddenThreadIds.delete(threadId);
          restoreSessionRows(threadId);
          toast("删除失败：" + (error?.message || error));
        }
      }, true);
      row.appendChild(button);
    }

    state.scan = () => {
      installStyle();
      document.querySelectorAll("[data-app-action-sidebar-thread-id]").forEach(attachButton);
    };
    state.observer = new MutationObserver(state.scan);
    state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    state.timer = setInterval(() => {
      void installPluginMarketplaceRequestPatch();
      state.scan();
    }, 1200);
    state.scan();
    return state;
  }

  refreshPluginMarketplaceUnlock();
  installSessionDeleteRuntime();
  clearInterval(window.__gaogePluginMarketplaceRuntimeTimer);
  window.__gaogePluginMarketplaceRuntimeTimer = setInterval(refreshPluginMarketplaceUnlock, 1200);
})();
`

const APIKEY_GATE_PATTERNS = [
  'function e(e){return e===`apikey`}',
  'function e(e){return e!==`chatgpt`}',
]

const CONNECTOR_PATTERNS = [
  ['(i=`connector-unavailable`)', 'false&&(i=`connector-unavailable`)'],
]

const PATCH_FUSES = {
  OnlyLoadAppFromAsar: false,
  EnableEmbeddedAsarIntegrityValidation: false,
  GrantFileProtocolExtraPrivileges: false,
  EnableCookieEncryption: false,
}

const STOCK_FUSES = {
  OnlyLoadAppFromAsar: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  EnableCookieEncryption: true,
  GrantFileProtocolExtraPrivileges: false,
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8')
}

async function writeText(filePath, content) {
  await fs.writeFile(filePath, content, 'utf8')
}

function replaceFirst(content, oldValue, newValue) {
  if (!content.includes(oldValue)) return [content, false]
  return [content.replace(oldValue, newValue), true]
}

async function listFiles(dir, predicate) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter(predicate)
    .sort()
}

async function walkFiles(dir, predicate) {
  const results = []
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return results
    throw error
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkFiles(filePath, predicate))
      continue
    }
    if (entry.isFile() && predicate(filePath)) {
      results.push(filePath)
    }
  }

  return results.sort()
}

async function webBundleFiles(paths, predicate) {
  const roots = [assetsDir(paths), buildDir(paths)]
  const files = []
  for (const root of roots) {
    files.push(...await walkFiles(root, predicate))
  }
  return [...new Set(files)].sort()
}

function makeReport() {
  const files = new Set()
  return {
    patchActions: 0,
    alreadyPatchedActions: 0,
    coreHits: 0,
    modelPickerEnhanced: false,
    modelPickerAsset: null,
    ultraReasoningPatched: false,
    actions: [],
    warnings: [],
    addFile(filePath) {
      files.add(filePath)
    },
    addPatch(message, core = false) {
      this.patchActions += 1
      if (core) this.coreHits += 1
      this.actions.push(message)
    },
    addAlready(message, core = false) {
      this.alreadyPatchedActions += 1
      if (core) this.coreHits += 1
      this.actions.push(message)
    },
    warn(message) {
      this.warnings.push(message)
    },
    setModelPickerEnhanced(filePath, ultraReasoningPatched = false) {
      this.modelPickerEnhanced = true
      this.modelPickerAsset = path.basename(filePath)
      this.ultraReasoningPatched = ultraReasoningPatched
    },
    async runLayer(name, task) {
      try {
        await task()
      } catch (error) {
        this.warn(`${name} failed: ${error?.message || String(error)}`)
      }
    },
    toJSON() {
      return {
        patchedFiles: files.size,
        patchActions: this.patchActions,
        alreadyPatchedActions: this.alreadyPatchedActions,
        modelPickerEnhanced: this.modelPickerEnhanced,
        modelPickerAsset: this.modelPickerAsset,
        ultraReasoningPatched: this.ultraReasoningPatched,
        actions: this.actions,
        warnings: this.warnings,
      }
    },
  }
}

function asarPath(paths) {
  return path.join(paths.resourcesDir, 'app.asar')
}

function renamedAsarPath(paths) {
  return path.join(paths.resourcesDir, 'app.asar1')
}

function backupAsarPath(paths) {
  return path.join(paths.resourcesDir, 'app.asar.bak')
}

function extractedAppDir(paths) {
  return path.join(paths.resourcesDir, 'app')
}

async function hasPatchableAsar(paths) {
  return (
    await exists(asarPath(paths)) ||
    await exists(renamedAsarPath(paths))
  )
}

async function isCompleteCodexPaths(paths) {
  if (!paths?.resourcesDir || !paths?.appPath) return false
  return (
    await exists(paths.resourcesDir) &&
    await exists(paths.appPath) &&
    await hasPatchableAsar(paths)
  )
}

async function firstCompleteCodexPaths(candidates) {
  for (const paths of candidates) {
    if (await isCompleteCodexPaths(paths)) {
      return {
        resourcesDir: paths.resourcesDir,
        appPath: paths.appPath,
      }
    }
  }
  return null
}

function uniqueCodexPathCandidates(candidates) {
  const seen = new Set()
  const unique = []
  for (const candidate of candidates) {
    if (!candidate?.resourcesDir || !candidate?.appPath) continue
    const key = `${candidate.resourcesDir}|${candidate.appPath}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

function assetsDir(paths) {
  return path.join(extractedAppDir(paths), 'webview', 'assets')
}

function buildDir(paths) {
  return path.join(extractedAppDir(paths), '.vite', 'build')
}

async function detectLinuxCodexPaths() {
  const candidates = [
    ['/opt/Codex/resources', '/opt/Codex/codex'],
    ['/opt/codex/resources', '/opt/codex/codex'],
    ['/usr/lib/codex/resources', '/usr/bin/codex'],
    ['/usr/share/codex/resources', '/usr/bin/codex'],
    [path.join(os.homedir(), '.local', 'share', 'Codex', 'resources'), path.join(os.homedir(), '.local', 'bin', 'codex')],
  ]

  const detected = await firstCompleteCodexPaths(candidates.map(([resourcesDir, appPath]) => ({ resourcesDir, appPath })))
  if (detected) return detected

  return {
    resourcesDir: candidates[0][0],
    appPath: candidates[0][1],
  }
}

async function detectRunningWindowsCodexPaths() {
  const script = 'Get-CimInstance Win32_Process -Filter "name = \'Codex.exe\'" | ForEach-Object { $_.ExecutablePath }'
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      timeout: 5000,
      windowsHide: true,
    })
    const appPaths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (const appPath of appPaths) {
      const resourcesDir = path.join(path.dirname(appPath), 'resources')
      const candidate = { resourcesDir, appPath }
      if (await isCompleteCodexPaths(candidate)) return candidate
    }
  } catch {
    return null
  }

  return null
}

async function detectShortcutWindowsCodexPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const publicDir = process.env.PUBLIC || 'C:\\Users\\Public'
  const roots = [
    path.join(os.homedir(), 'Desktop'),
    path.join(publicDir, 'Desktop'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'ImplicitAppShortcuts'),
  ]
  const escapedRoots = roots
    .map((root) => `'${root.replace(/'/g, "''")}'`)
    .join(',')
  const script = `
$roots = @(${escapedRoots})
$w = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  if (!(Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -notmatch 'Codex|OpenAI') { return }
    $s = $w.CreateShortcut($_.FullName)
    if ($s.TargetPath) { $s.TargetPath }
  }
}
`
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 8000,
      windowsHide: true,
    })
    const candidates = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((appPath) => path.basename(appPath).toLowerCase() === 'codex.exe')
      .map((appPath) => ({ resourcesDir: path.join(path.dirname(appPath), 'resources'), appPath }))
    return firstCompleteCodexPaths(uniqueCodexPathCandidates(candidates))
  } catch {
    return null
  }
}

async function detectRegisteredWindowsAppxCodexPaths() {
  const script = `
$pkg = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg -and $pkg.InstallLocation) {
  Join-Path $pkg.InstallLocation 'app\\Codex.exe'
}
`
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 5000,
      windowsHide: true,
    })
    const appPath = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (!appPath) return null
    const candidate = { resourcesDir: path.join(path.dirname(appPath), 'resources'), appPath }
    return await isCompleteCodexPaths(candidate) ? candidate : null
  } catch {
    return null
  }
}

function windowsAppsCodexVersion(name) {
  const match = /^OpenAI\.Codex_([0-9.]+)_[^_]+__2p2nqsd0c76g0$/i.exec(name)
  if (!match) return []
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersionPartsDesc(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function detectWindowsAppsCodexPaths() {
  const registered = await detectRegisteredWindowsAppxCodexPaths()
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const root = path.join(programFiles, 'WindowsApps')
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return registered
  }

  const candidates = uniqueCodexPathCandidates([
    registered,
    ...entries
    .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_.*__2p2nqsd0c76g0$/i.test(entry.name))
    .map((entry) => ({
      resourcesDir: path.join(root, entry.name, 'app', 'resources'),
      appPath: path.join(root, entry.name, 'app', 'Codex.exe'),
      versionParts: windowsAppsCodexVersion(entry.name),
      sortKey: entry.name,
    }))
    .sort((a, b) => compareVersionPartsDesc(a.versionParts, b.versionParts) || b.sortKey.localeCompare(a.sortKey)),
  ])

  return firstCompleteCodexPaths(candidates)
}

async function detectCodexAppPaths(request = {}) {
  if (typeof request.resourcesDir === 'string' && request.resourcesDir.trim()) {
    const resourcesDir = path.resolve(request.resourcesDir.trim())
    let appPath = typeof request.appPath === 'string' ? request.appPath.trim() : ''
    if (!appPath) {
      if (process.platform === 'win32') {
        appPath = path.join(path.dirname(resourcesDir), 'Codex.exe')
      } else if (process.platform === 'darwin') {
        appPath = path.resolve(resourcesDir, '..', '..')
      } else {
        appPath = path.join(path.dirname(resourcesDir), 'codex')
      }
    }
    return { resourcesDir, appPath: path.resolve(appPath) }
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) throw new Error('未找到 LOCALAPPDATA，无法定位 Codex 安装目录。')
    const runningPaths = await detectRunningWindowsCodexPaths()
    if (runningPaths) return runningPaths

    const shortcutPaths = await detectShortcutWindowsCodexPaths()
    if (shortcutPaths) return shortcutPaths

    const portableProgramsPaths = {
      resourcesDir: path.join(localAppData, 'Programs', 'OpenAI Codex Portable', 'resources'),
      appPath: path.join(localAppData, 'Programs', 'OpenAI Codex Portable', 'Codex.exe'),
    }
    if (await isCompleteCodexPaths(portableProgramsPaths)) return portableProgramsPaths

    const localProgramsPaths = {
      resourcesDir: path.join(localAppData, 'Programs', 'Codex', 'resources'),
      appPath: path.join(localAppData, 'Programs', 'Codex', 'Codex.exe'),
    }
    if (await isCompleteCodexPaths(localProgramsPaths)) return localProgramsPaths
    return (await detectWindowsAppsCodexPaths()) || localProgramsPaths
  }

  if (process.platform === 'darwin') {
    return {
      resourcesDir: '/Applications/Codex.app/Contents/Resources',
      appPath: '/Applications/Codex.app',
    }
  }

  if (process.platform === 'linux') {
    return detectLinuxCodexPaths()
  }

  throw new Error(`当前系统暂不支持自动补丁：${process.platform}`)
}

async function ensurePrerequisites(paths) {
  if (!(await exists(paths.resourcesDir))) {
    throw new Error(`没有找到 Codex Resources 目录：${paths.resourcesDir}`)
  }
  if (!(await exists(asarPath(paths))) && !(await exists(renamedAsarPath(paths)))) {
    throw new Error(`没有找到 app.asar 或 app.asar1：${paths.resourcesDir}`)
  }
  if (!(await exists(paths.appPath))) {
    throw new Error(`没有找到 Codex 应用入口：${paths.appPath}`)
  }
}

async function stopCodex() {
  try {
    if (process.platform === 'win32') {
      // New desktop releases use ChatGPT.exe as the parent/tray process.
      // Stop matching images only. Descendants can include the Gaoge client
      // that must finish writing configuration and relaunching Codex.
      for (const image of ['ChatGPT.exe', 'Codex.exe', 'codex.exe']) {
        await execFileAsync('taskkill', ['/IM', image, '/F'], { windowsHide: true }).catch(() => {})
      }
      return
    }
    if (process.platform === 'darwin') {
      await execFileAsync('pkill', ['-x', 'Codex'])
      return
    }
    if (process.platform === 'linux') {
      await execFileAsync('pkill', ['-x', 'codex']).catch(() => {})
      await execFileAsync('pkill', ['-x', 'Codex']).catch(() => {})
    }
  } catch {
    // Codex 没有运行时，停止命令失败是正常情况。
  }
}

async function backupAsar(paths) {
  const backupPath = backupAsarPath(paths)
  if (await exists(backupPath)) return backupPath
  const source = (await exists(asarPath(paths))) ? asarPath(paths) : renamedAsarPath(paths)
  await fs.copyFile(source, backupPath)
  return backupPath
}

async function prepareExtractedApp(paths) {
  const { extractAll } = await import('@electron/asar')
  const workDir = path.join(paths.resourcesDir, 'app.patch-work')
  await fs.rm(workDir, { recursive: true, force: true })

  if (!(await exists(asarPath(paths))) && (await exists(renamedAsarPath(paths)))) {
    await fs.copyFile(renamedAsarPath(paths), asarPath(paths))
  }

  extractAll(asarPath(paths), workDir)
  await fs.rm(extractedAppDir(paths), { recursive: true, force: true })
  await fs.rename(workDir, extractedAppDir(paths))
  await fs.rm(renamedAsarPath(paths), { force: true })
  await fs.rename(asarPath(paths), renamedAsarPath(paths))
}

async function applyFuses(paths, fuseValues) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')
  const config = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === 'darwin',
  }

  for (const [name, value] of Object.entries(fuseValues)) {
    config[FuseV1Options[name]] = value
  }

  await flipFuses(paths.appPath, config)
}

async function resignIfNeeded(paths) {
  if (process.platform !== 'darwin') return
  await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', paths.appPath])
}

async function restoreAsar(paths) {
  const backup = backupAsarPath(paths)
  if (await exists(backup)) {
    await fs.copyFile(backup, asarPath(paths))
    return
  }

  if (await exists(renamedAsarPath(paths))) {
    await fs.copyFile(renamedAsarPath(paths), asarPath(paths))
    return
  }

  if (await exists(asarPath(paths))) return
  throw new Error(`无法回滚：缺少 app.asar、app.asar1 和 app.asar.bak：${paths.resourcesDir}`)
}

async function rollbackCodexPluginPatch(request = {}) {
  const paths = await detectCodexAppPaths(request)
  await ensurePrerequisites(paths)
  await stopCodex()
  await restoreAsar(paths)
  await fs.rm(extractedAppDir(paths), { recursive: true, force: true })
  await applyFuses(paths, STOCK_FUSES)
  await resignIfNeeded(paths)
  return {
    applied: false,
    restored: true,
    resourcesDir: paths.resourcesDir,
    appPath: paths.appPath,
    backupAsarPath: backupAsarPath(paths),
    needsRestart: true,
    patchedFiles: 0,
    patchActions: 0,
    alreadyPatchedActions: 0,
    actions: ['Codex App 已恢复为 app.asar 原版加载方式'],
    warnings: [],
  }
}

async function rollbackAfterFailedPatch(paths) {
  await restoreAsar(paths)
  await fs.rm(extractedAppDir(paths), { recursive: true, force: true })
  await applyFuses(paths, STOCK_FUSES).catch(() => {})
  await resignIfNeeded(paths).catch(() => {})
}

async function patchPluginSidebar(paths, report) {
  const files = await listFiles(assetsDir(paths), (filePath) => /^index-.*\.js$/.test(path.basename(filePath)))
  for (const filePath of files) {
    const original = await readText(filePath)
    let content = original
    const marker = 'pluginsDisabledTooltip'

    if (content.includes(marker)) {
      const index = content.indexOf(marker)
      const windowText = content.slice(Math.max(0, index - 240), index + 120)
      const match = SIDEBAR_GATE_RE.exec(windowText)
      if (match) {
        const oldValue = `${match[1]}?(0,$.jsx)(Sl,{tooltipContent`
        const newValue = '0?(0,$.jsx)(Sl,{tooltipContent'
        const result = replaceFirst(content, oldValue, newValue)
        content = result[0]
        if (result[1]) report.addPatch(`${path.basename(filePath)}: 插件侧边栏入口已解锁`, true)
      } else if (windowText.includes('0?(0,$.jsx)(Sl,{tooltipContent')) {
        report.addAlready(`${path.basename(filePath)}: 插件侧边栏入口已经解锁`, true)
      } else {
        report.warn(`${path.basename(filePath)}: 插件侧边栏 gate 结构已变化`)
      }
    }

    if (content !== original) {
      await writeText(filePath, content)
      report.addFile(filePath)
    }
  }
}

async function patchApikeyGate(paths, report) {
  const files = await listFiles(assetsDir(paths), (filePath) => /^gradient-.*\.js$/.test(path.basename(filePath)))
  if (files.length === 0) {
    report.warn('没有找到 gradient-*.js，无法确认 API Key 插件 gate。')
    return
  }

  for (const filePath of files) {
    const original = await readText(filePath)
    let content = original
    let changed = false

    for (const pattern of APIKEY_GATE_PATTERNS) {
      const result = replaceFirst(content, pattern, 'function e(e){return false}')
      content = result[0]
      if (result[1]) {
        changed = true
        report.addPatch(`${path.basename(filePath)}: API Key 插件 gate 已关闭`, true)
        break
      }
    }

    if (!changed) {
      const match = APIKEY_GATE_FALLBACK_RE.exec(content)
      if (match) {
        const ident = match[1]
        content = `${content.slice(0, match.index)}function ${ident}(${ident}){return false}${content.slice(match.index + match[0].length)}`
        changed = true
        report.addPatch(`${path.basename(filePath)}: API Key 插件 gate 已关闭`, true)
      } else if (APIKEY_GATE_ALREADY_RE.test(content)) {
        report.addAlready(`${path.basename(filePath)}: API Key 插件 gate 已经关闭`, true)
      } else if (content.includes('apikey') || content.includes('chatgpt')) {
        report.warn(`${path.basename(filePath)}: API Key gate 结构已变化`)
      }
    }

    if (content !== original) {
      await writeText(filePath, content)
      report.addFile(filePath)
    }
  }
}

async function patchConnectorGate(paths, report) {
  const files = await listFiles(assetsDir(paths), (filePath) => /^use-plugin-install-flow-.*\.js$/.test(path.basename(filePath)))
  if (files.length === 0) {
    report.warn('没有找到 use-plugin-install-flow-*.js，无法确认插件安装 flow。')
    return
  }

  for (const filePath of files) {
    const original = await readText(filePath)
    let content = original

    for (const [oldValue, newValue] of CONNECTOR_PATTERNS) {
      if (content.includes(newValue)) {
        report.addAlready(`${path.basename(filePath)}: connector unavailable gate 已经关闭`, true)
        break
      }
      if (content.includes(oldValue)) {
        content = content.replace(oldValue, newValue)
        report.addPatch(`${path.basename(filePath)}: connector unavailable gate 已关闭`, true)
        break
      }
    }

    if (content !== original) {
      await writeText(filePath, content)
      report.addFile(filePath)
    }
  }
}

function pluginMarketplaceRuntimeCandidateScore(filePath, content) {
  const name = path.basename(filePath)
  let score = 0
  if (/^index-.*\.js$/.test(name)) score += 100
  if (filePath.includes(`${path.sep}webview${path.sep}assets${path.sep}`)) score += 40
  if (content.includes('app-server-manager-signals-')) score += 35
  if (content.includes('list-plugins')) score += 25
  if (content.includes('install-plugin')) score += 25
  if (content.includes('marketplaceKinds')) score += 15
  if (content.includes('marketplaceName')) score += 10
  return score
}

async function pluginMarketplaceRuntimeCandidates(paths) {
  const files = await webBundleFiles(paths, (filePath) => filePath.endsWith('.js'))
  const candidates = []
  for (const filePath of files) {
    const content = await readText(filePath)
    if (content.includes(PLUGIN_MARKETPLACE_RUNTIME_MARKER)) {
      return [{ filePath, content, score: Number.MAX_SAFE_INTEGER, already: true }]
    }
    const score = pluginMarketplaceRuntimeCandidateScore(filePath, content)
    if (score > 0) candidates.push({ filePath, content, score, already: false })
  }
  return candidates.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath))
}

async function patchPluginMarketplaceRuntime(paths, report) {
  const candidates = await pluginMarketplaceRuntimeCandidates(paths)
  if (candidates.length === 0) {
    report.warn('没有找到可注入插件市场 runtime 解锁脚本的 Codex JS bundle。')
    return
  }

  const target = candidates[0]
  if (target.already) {
    report.addAlready(`${path.basename(target.filePath)}: 插件市场 runtime 解锁脚本已安装`, true)
    return
  }

  const newline = target.content.endsWith('\n') ? '' : '\n'
  await writeText(target.filePath, `${target.content}${newline}${PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT}\n`)
  report.addFile(target.filePath)
  report.addPatch(`${path.basename(target.filePath)}: 插件市场 runtime 解锁脚本已注入`, true)
}

async function chromePatchSurfacesExist(paths) {
  return (await exists(buildDir(paths))) ||
    (await listFiles(assetsDir(paths), (filePath) => /^use-plugins-.*\.js$/.test(path.basename(filePath)))).length > 0
}

function isChromeRuntimeConstantsBundle(content) {
  return content.includes('openai-bundled-dev') &&
    (content.includes('`chrome-internal`') || content.includes('`chrome`')) &&
    content.includes('`computer-use`') &&
    content.includes('`latex-tectonic`')
}

async function patchChromeRuntimePluginName(paths, report) {
  const files = await listFiles(buildDir(paths), (filePath) => filePath.endsWith('.js'))
  for (const filePath of files) {
    const original = await readText(filePath)
    if (!isChromeRuntimeConstantsBundle(original)) continue
    const [content, changed] = replaceFirst(original, '`chrome-internal`', '`chrome`')
    if (changed) {
      await writeText(filePath, content)
      report.addFile(filePath)
      report.addPatch(`${path.basename(filePath)}: Chrome 插件名已从 chrome-internal 改为 chrome`)
      return true
    }
    if (original.includes('`chrome`') && !original.includes('`chrome-internal`')) {
      report.addAlready(`${path.basename(filePath)}: Chrome 插件名已经可用`)
      return true
    }
  }
  return false
}

function chromeMarketplaceDescriptorAlreadyPatched(content) {
  return content.includes('name:e.On') && content.includes('=>Jn(e)}')
}

async function patchChromeMarketplaceDescriptor(paths, report) {
  const files = await listFiles(buildDir(paths), (filePath) => filePath.endsWith('.js'))
  for (const filePath of files) {
    const original = await readText(filePath)
    if (!original.includes('externalBrowserUseAllowed') || !original.includes('forceReload:!0')) continue

    const content = original.replace(
      CHROME_MARKETPLACE_DESCRIPTOR_RE,
      (_match, prefix, _gateValue, offset, fullText, groups) => `${prefix}${groups.gate}(e)}`,
    )

    if (content !== original) {
      await writeText(filePath, content)
      report.addFile(filePath)
      report.addPatch(`${path.basename(filePath)}: Chrome marketplace 描述已保留`)
      return true
    }
    if (chromeMarketplaceDescriptorAlreadyPatched(original)) {
      report.addAlready(`${path.basename(filePath)}: Chrome marketplace 描述已经保留`)
      return true
    }
  }
  return false
}

async function chromeVisibilityCandidateFiles(paths) {
  const usePluginsFiles = await listFiles(assetsDir(paths), (filePath) => /^use-plugins-.*\.js$/.test(path.basename(filePath)))
  if (usePluginsFiles.length > 0) return usePluginsFiles

  const files = await listFiles(assetsDir(paths), (filePath) => filePath.endsWith('.js'))
  const candidates = []
  for (const filePath of files) {
    const content = await readText(filePath)
    if (content.includes('isExternalBrowserUseAvailable') && content.includes('`chrome`')) {
      candidates.push(filePath)
    }
  }
  return candidates
}

async function patchChromeVisibilityFilter(paths, report) {
  const files = await chromeVisibilityCandidateFiles(paths)
  for (const filePath of files) {
    const original = await readText(filePath)
    const content = original.replace(EXTERNAL_BROWSER_FILTER_RE, (_match, fn, inapp, _external, computer) => (
      `function ${fn}(e,{isComputerUseAvailable:t,isExternalBrowserUseAvailable:n,isInAppBrowserUseAvailable:r})` +
      `{return!(!r&&${inapp}(e)||!t&&${computer}(e))}`
    ))

    if (content !== original) {
      await writeText(filePath, content)
      report.addFile(filePath)
      report.addPatch(`${path.basename(filePath)}: Chrome 插件不再被外部浏览器 gate 隐藏`)
      return true
    }
    if (original.includes('isExternalBrowserUseAvailable') && original.includes('`chrome`') && !original.includes('!n&&')) {
      report.addAlready(`${path.basename(filePath)}: Chrome 插件可见性已经解除限制`)
      return true
    }
  }
  return false
}

async function patchChromePluginPreservation(paths, report) {
  if (!(await chromePatchSurfacesExist(paths))) return

  const patchedName = await patchChromeRuntimePluginName(paths, report)
  const patchedDescriptor = await patchChromeMarketplaceDescriptor(paths, report)
  const patchedVisibility = await patchChromeVisibilityFilter(paths, report)

  if (!patchedName) report.warn('没有找到 Chrome runtime 插件名 gate，若 Chrome 消失需要适配新版 Codex。')
  if (!patchedDescriptor) report.warn('没有找到 Chrome marketplace 描述，若重启后 Chrome 消失需要适配新版 Codex。')
  if (!patchedVisibility) report.warn('没有找到 Chrome 可见性过滤器，若 Chrome 被隐藏需要适配新版 Codex。')
}

function firstModelProviderMarkerIndex(content) {
  MODEL_PROVIDER_ID_RE.lastIndex = 0
  const match = MODEL_PROVIDER_ID_RE.exec(content)
  if (match) return match.index
  return content.indexOf('model-provider')
}

function lastRegexMatch(regex, content) {
  regex.lastIndex = 0
  let result = null
  let match = regex.exec(content)
  while (match) {
    result = match
    if (regex.lastIndex === match.index) regex.lastIndex += 1
    match = regex.exec(content)
  }
  return result
}

function patchModelProviderObject(content) {
  MODEL_PROVIDER_ID_RE.lastIndex = 0
  let match = MODEL_PROVIDER_ID_RE.exec(content)
  while (match) {
    const objectStart = content.lastIndexOf('{', match.index)
    const objectEnd = content.indexOf('}', match.index)
    if (objectStart >= 0 && objectEnd > objectStart && match.index - objectStart <= 120 && objectEnd - objectStart <= 700) {
      const objectText = content.slice(objectStart, objectEnd + 1)
      if (/enabled:(?:!1|false)(?=,|\})/.test(objectText)) {
        return { content, changed: false, already: true }
      }

      const enabledMatch = /enabled:([^,}]+)/.exec(objectText)
      if (enabledMatch) {
        const valueStart = objectStart + enabledMatch.index + 'enabled:'.length
        const valueEnd = valueStart + enabledMatch[1].length
        return {
          content: `${content.slice(0, valueStart)}!1${content.slice(valueEnd)}`,
          changed: true,
          already: false,
        }
      }
    }

    match = MODEL_PROVIDER_ID_RE.exec(content)
  }

  return null
}

function patchModelProviderAssignment(content) {
  const markerIndex = firstModelProviderMarkerIndex(content)
  if (markerIndex < 0) return null

  const prefixStart = Math.max(0, markerIndex - 2000)
  const prefix = content.slice(prefixStart, markerIndex)
  if (MODEL_PROVIDER_CONTROL_DISABLED_RE.test(prefix)) {
    return { content, changed: false, already: true }
  }

  for (const regex of MODEL_PROVIDER_CONTROL_ENABLED_RES) {
    const match = lastRegexMatch(regex, prefix)
    if (!match) continue

    const replacement = `,${match[1]}=!1,${match[2]};`
    const start = prefixStart + match.index
    const end = start + match[0].length
    return {
      content: `${content.slice(0, start)}${replacement}${content.slice(end)}`,
      changed: true,
      already: false,
    }
  }

  return null
}

function hideModelProviderControl(content) {
  if (!content.includes('model-provider')) return { content, changed: false, already: false }

  const objectPatch = patchModelProviderObject(content)
  if (objectPatch) return objectPatch

  const assignmentPatch = patchModelProviderAssignment(content)
  if (assignmentPatch) return assignmentPatch

  return { content, changed: false, already: false }
}

function modelProviderJsCandidateScore(filePath) {
  const name = path.basename(filePath)
  let score = 0
  if (/^composer-.*\.js$/.test(name)) score += 100
  if (/composer/i.test(name)) score += 50
  if (/footer/i.test(name)) score += 25
  return score
}

async function modelProviderJsCandidates(paths) {
  const files = await webBundleFiles(paths, (filePath) => filePath.endsWith('.js'))
  const candidates = []
  for (const filePath of files) {
    const content = await readText(filePath)
    if (content.includes('model-provider')) {
      candidates.push({ filePath, content })
    }
  }

  return candidates.sort((a, b) => {
    const score = modelProviderJsCandidateScore(b.filePath) - modelProviderJsCandidateScore(a.filePath)
    return score || a.filePath.localeCompare(b.filePath)
  })
}

function modelProviderCssCandidateScore(filePath) {
  const name = path.basename(filePath)
  let score = 0
  if (/^app-main-.*\.css$/.test(name)) score += 100
  if (/^composer-.*\.css$/.test(name)) score += 80
  if (/^composer-footer-.*\.css$/.test(name)) score += 70
  if (/composer/i.test(name)) score += 25
  return score
}

async function modelProviderCssCandidates(paths) {
  const files = await webBundleFiles(paths, (filePath) => filePath.endsWith('.css'))
  const preferred = files.filter((filePath) => modelProviderCssCandidateScore(filePath) > 0)
  return (preferred.length > 0 ? preferred : files).sort((a, b) => {
    const score = modelProviderCssCandidateScore(b) - modelProviderCssCandidateScore(a)
    return score || a.localeCompare(b)
  })
}

async function patchModelProviderBadgeCss(paths, report) {
  const files = await modelProviderCssCandidates(paths)
  if (files.length === 0) return false

  const patched = []
  let already = false
  for (const filePath of files) {
    const original = await readText(filePath)
    if (original.includes(MODEL_PROVIDER_BADGE_CSS_MARKER)) {
      already = true
      continue
    }

    const content = `${original}${original.endsWith('\n') ? '' : '\n'}${MODEL_PROVIDER_BADGE_CSS}`
    await writeText(filePath, content)
    report.addFile(filePath)
    patched.push(path.basename(filePath))
  }

  if (patched.length > 0) {
    report.addPatch(`${patched.join(', ')}: model provider badge hidden by fallback CSS`)
    return true
  }

  if (already) {
    report.addAlready('model provider badge fallback CSS already installed')
    return true
  }

  return false
}

async function patchModelProviderBadge(paths, report) {
  const candidates = await modelProviderJsCandidates(paths)
  let jsHandled = false
  const changedStructureFiles = []

  for (const candidate of candidates) {
    const result = hideModelProviderControl(candidate.content)
    if (result.changed) {
      await writeText(candidate.filePath, result.content)
      report.addFile(candidate.filePath)
      report.addPatch(`${path.basename(candidate.filePath)}: model provider badge hidden in JS`)
      jsHandled = true
      break
    }

    if (result.already) {
      report.addAlready(`${path.basename(candidate.filePath)}: model provider badge already hidden in JS`)
      jsHandled = true
      break
    }

    changedStructureFiles.push(path.basename(candidate.filePath))
  }

  const cssHandled = await patchModelProviderBadgeCss(paths, report)
  if (!jsHandled && changedStructureFiles.length > 0) {
    report.warn(`${changedStructureFiles.join(', ')}: model-provider JS structure changed; fallback CSS was ${cssHandled ? 'installed' : 'not installed'}.`)
  }
  if (!jsHandled && candidates.length === 0 && !cssHandled) {
    report.warn('No model-provider bundle or stylesheet found; model provider badge could not be hidden.')
  }
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function apiKeyServiceTierGateMatches(content, pattern, patched) {
  const regex = new RegExp(pattern.source, pattern.flags)
  return [...content.matchAll(regex)].flatMap((match) => {
    const groups = match.groups || {}
    const { allowed, authState, chatgpt, loading, pending, plan } = groups
    if (![allowed, authState, chatgpt, loading, pending, plan]
      .every((name) => /^[A-Za-z_$][\w$]*$/.test(name || ''))) {
      return []
    }

    const functionStart = content.lastIndexOf('function ', match.index)
    if (functionStart < 0 || match.index - functionStart > 1200) return []
    const functionWindow = content.slice(functionStart, Math.min(content.length, match.index + match[0].length + 600))
    const identifier = '[A-Za-z_$][\\w$]*'
    const authBinding = new RegExp(
      `${escapeRegexLiteral(chatgpt)}=(${identifier})\\?\\.authMethod===\`chatgpt\`,(${identifier})=(${identifier})\\?\\.authMethod\\?\\?null`,
    ).exec(functionWindow)
    if (!authBinding || authBinding[1] !== authBinding[3]) return []
    if (authBinding[1] !== authState) return []
    const authMethod = authBinding[2]
    if (patched && groups.authMethod !== authMethod) return []
    if (!functionWindow.includes(`let{data:${plan},isPending:${pending}}=`)) return []
    if (!functionWindow.includes(`isServiceTierAllowed:${allowed},isLoading:${loading}`)) return []
    return [{ match, authMethod }]
  })
}

function patchCodexApiKeyServiceTierGateContent(content) {
  if (typeof content !== 'string') {
    throw new TypeError('Codex service-tier bundle content must be a string.')
  }

  const original = apiKeyServiceTierGateMatches(content, APIKEY_SERVICE_TIER_GATE_ORIGINAL_RE, false)
  const patched = apiKeyServiceTierGateMatches(content, APIKEY_SERVICE_TIER_GATE_PATCHED_RE, true)
  if (original.length === 0 && patched.length === 1) {
    return { content, changed: false, already: true }
  }
  if (original.length !== 1 || patched.length !== 0) {
    throw new Error(
      `Expected exactly one Codex API-key service-tier gate, found ${original.length} original and ` +
      `${patched.length} patched. The installed Codex version is not safely patchable by this rule.`,
    )
  }

  const { match, authMethod } = original[0]
  const { allowed, authState, chatgpt, loading, pending, plan } = match.groups
  const replacement =
    `${loading}=${authState}?.isLoading||${chatgpt}&&${pending},` +
    `${allowed}=${loading}?0:${chatgpt}?${plan}&&${plan}.requirements?.featureRequirements?.fast_mode!=0:` +
    `${authMethod}==\`apikey\``
  if (replacement.length !== match[0].length) {
    throw new Error(
      `Codex API-key service-tier patch length mismatch (${match[0].length} -> ${replacement.length}).`,
    )
  }
  const next = `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`
  return { content: next, changed: true, already: false }
}

function isApiKeyServiceTierGateCandidate(content) {
  return APIKEY_SERVICE_TIER_GATE_REQUIRED_KEYS.every((key) => content.includes(key))
}

async function apiKeyServiceTierGateCandidates(paths) {
  const files = await webBundleFiles(paths, (filePath) => filePath.endsWith('.js'))
  const candidates = []
  for (const filePath of files) {
    const content = await readText(filePath)
    if (isApiKeyServiceTierGateCandidate(content)) {
      candidates.push({ filePath, content })
    }
  }
  return candidates
}

async function patchApiKeyServiceTierGate(paths, report) {
  const candidates = await apiKeyServiceTierGateCandidates(paths)
  if (candidates.length === 0) {
    report.addAlready('Codex bundle does not expose a native service-tier gate; no API-key speed patch is needed')
    return { supported: false, changed: false, already: false }
  }
  if (candidates.length !== 1) {
    const names = candidates.map(({ filePath }) => path.basename(filePath)).join(', ')
    throw new Error(
      `Expected exactly one Codex service-tier bundle, found ${candidates.length} (${names}). ` +
      'No service-tier files were modified.',
    )
  }

  const candidate = candidates[0]
  const result = patchCodexApiKeyServiceTierGateContent(candidate.content)
  if (result.changed) {
    await writeText(candidate.filePath, result.content)
    report.addFile(candidate.filePath)
    report.addPatch(
      `${path.basename(candidate.filePath)}: API Key sessions can use native model speed tiers`,
    )
  } else {
    report.addAlready(
      `${path.basename(candidate.filePath)}: API Key native speed-tier gate patch is already installed`,
    )
  }
  return {
    supported: true,
    filePath: candidate.filePath,
    changed: result.changed,
    already: result.already,
  }
}

function modelPickerFilterSignatureMatches(content) {
  const regex = new RegExp(MODEL_PICKER_FILTER_SIGNATURE_RE.source, MODEL_PICKER_FILTER_SIGNATURE_RE.flags)
  return [...content.matchAll(regex)]
}

function nativeModelCatalogMatches(content) {
  const fields = ['additionalAvailableModels', 'authMethod', 'availableModels',
    'hasConfiguredModelCatalog', 'isCustomModelProvider', 'model', 'useHiddenModels']
  return [...content.matchAll(/function\s+[\w$]+\(\{([^{}]{1,700})\}\)\{((?:return |let )[^{}]{1,1500})\}/g)]
    .filter((match) => {
      const entries = match[1].split(',').map((field) => field.split(':'))
      if (entries.some((entry) => entry.length !== 2)) return false
      const bindings = Object.fromEntries(entries)
      const hasDaybreak = Object.hasOwn(bindings, 'apiKeyDaybreakSupported')
      const expectedFields = hasDaybreak ? [...fields, 'apiKeyDaybreakSupported'] : fields
      if (entries.length !== expectedFields.length || Object.keys(bindings).length !== expectedFields.length) return false
      const aliases = expectedFields.map((key) => bindings[key])
      if (aliases.some((name) => !name || !/^[\w$]+$/.test(name))) return false
      if (new Set(aliases).size !== aliases.length) return false
      const [extra, auth, available, catalog, custom, model, hidden, daybreak] = aliases
      const body = match[2].replace(/;$/, '')
      const catalogPrefix = `${extra}?.has(${model}.model)===!0||${model}.model!==\`codex-auto-review\`&&(${catalog}&&!${model}.hidden||(${hidden}&&!${custom}&&${auth}!==\`amazonBedrock\`?${available}.has(${model}.model)`
      if (!hasDaybreak) return body === `return ${catalogPrefix}:!${model}.hidden))`

      // Codex 26.1007 adds API Key access-program checks. Recognize the entire
      // native predicate without bypassing those checks or rewriting the bundle.
      const programs = /^let ([\w$]+)=/.exec(body)?.[1]
      const program = /\.some\(([\w$]+)=>\1!==`standard`\)/.exec(body)?.[1]
      if (!programs || !program || aliases.includes(programs)) return false
      const expected = `let ${programs}=${model}.availableAccessPrograms?.cyber;return ${auth}===\`apikey\`&&!${daybreak}&&${programs}!=null&&${programs}.length>0&&!${programs}.includes(\`standard\`)?!1:${catalogPrefix}||${auth}===\`apikey\`&&${daybreak}&&!${model}.hidden&&${programs}?.some(${program}=>${program}!==\`standard\`)===!0:!${model}.hidden))`
      return body === expected
    })
}

// Keep this callback identical to the independently extracted 26.1007 fixture.
// A future query shape must be reviewed before adapting its local Ultra gate.
const CODEX_ULTRA_QUERY_26_1007 = '({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o,limit:s,modelCatalogPath:c,modelProvider:l},{get:u,queryClient:d,scope:f})=>{let p=Pd?.daybreakPreferences!=null&&i===`local`&&t===`apikey`,m=p?zc(u,`api_key_daybreak_preference`)?.apiKeySession:void 0,h=m!=null&&u(dHe,i),g=yee(i,t,s,p?m??`unavailable`:void 0),_=n==null?u(GRi):new Set([...n,`persistent`]),v=u(BRi),y=a&&u(kc,`1186680773`);return{queryKey:[...g,...o?[l]:[],...c==null?[]:[c]],enabled:u(Ie).includes(i),refetchOnWindowFocus:!0,staleTime:Qg.FIVE_MINUTES,queryFn:({queryKey:e})=>{let t=d.getQueryData(e)==null?`interactive`:`background`;return o&&d.removeQueries({exact:!0,queryKey:g}),jg(f,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:t})},select:({data:n})=>ARi({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:h,authMethod:t,availableModels:v.availableModels,defaultModel:v.defaultModel,enabledReasoningEfforts:_,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:y,isCustomModelProvider:o,models:n,useHiddenModels:v.useHiddenModels})}}'
const CODEX_ULTRA_QUERY_GATE_ORIGINAL = 'y=a&&u(kc,`1186680773`)'
const CODEX_ULTRA_QUERY_GATE_PATCHED = 'y=a&&(u(kc,`1186680773`)||t===`apikey`&&o&&r)'

function codexQueryCallbackEnd(content, bodyStart) {
  // Query callbacks are small. Bound inspection to this block, including nested
  // objects/arrows, so an unrelated feature gate later in the bundle is ignored.
  const limit = Math.min(content.length, bodyStart + 16000)
  const quotedEnd = (start, quote) => {
    for (let index = start + 1; index < limit; index += 1) {
      if (content[index] === '\\') { index += 1; continue }
      if (content[index] === quote) return index + 1
      if (quote === '`' && content[index] === '$' && content[index + 1] === '{') {
        const end = blockEnd(index + 1)
        if (end < 0) return -1
        index = end - 1
      }
    }
    return -1
  }
  const blockEnd = (start) => {
    let depth = 1
    for (let index = start + 1; index < limit; index += 1) {
      const char = content[index]
      if (char === '"' || char === "'" || char === '`') {
        const end = quotedEnd(index, char)
        if (end < 0) return -1
        index = end - 1
      } else if (char === '/' && content[index + 1] === '/') {
        const end = content.indexOf('\n', index + 2)
        if (end < 0 || end >= limit) return -1
        index = end
      } else if (char === '/' && content[index + 1] === '*') {
        const end = content.indexOf('*/', index + 2)
        if (end < 0 || end + 2 > limit) return -1
        index = end + 1
      } else if (char === '/') {
        // No reviewed model query uses regex or division. Reject ambiguous
        // lexical boundaries instead of inspecting another callback by mistake.
        return -1
      } else if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) return index + 1
    }
    return -1
  }
  return blockEnd(bodyStart)
}

function inspectCodexUltraQueryGateContent(content) {
  if (typeof content !== 'string') {
    throw new TypeError('Codex Ultra query bundle content must be a string.')
  }
  const hasField = (params, field) => new RegExp(`(?:^|,)\\s*${field}\\s*:`).test(params)
  const candidates = [...content.matchAll(/\(\s*\{([^{}]{1,900})\}\s*,\s*\{([^{}]{1,300})\}\s*\)\s*=>\s*\{/g)]
    .filter((match) => (hasField(match[1], 'includeUltraReasoningEffort')
      || ['hasConfiguredModelCatalog', 'isCustomModelProvider', 'modelCatalogPath'].every(field => hasField(match[1], field)))
      && hasField(match[2], 'queryClient'))
    .filter((match) => {
      const end = codexQueryCallbackEnd(content, match.index + match[0].length - 1)
      if (end < 0) throw new Error('The Codex Ultra model-query callback has an unsupported shape. No Ultra query was modified.')
      return content.slice(match.index, end).includes('1186680773')
    })
  if (candidates.length === 0) return null
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one Codex Ultra model-query callback, found ${candidates.length}. No Ultra query was modified.`)
  }
  const candidate = candidates[0]
  const patchedQuery = CODEX_ULTRA_QUERY_26_1007.replace(CODEX_ULTRA_QUERY_GATE_ORIGINAL, CODEX_ULTRA_QUERY_GATE_PATCHED)
  const already = content.startsWith(patchedQuery, candidate.index)
  if (!already && !content.startsWith(CODEX_ULTRA_QUERY_26_1007, candidate.index)) {
    throw new Error('The Codex Ultra model-query callback has an unsupported shape. No Ultra query was modified.')
  }
  return {
    offset: candidate.index + CODEX_ULTRA_QUERY_26_1007.indexOf(CODEX_ULTRA_QUERY_GATE_ORIGINAL),
    already,
  }
}

function patchCodexUltraQueryGateContent(content) {
  const match = inspectCodexUltraQueryGateContent(content)
  if (!match) return { content, changed: false, already: false, ultraReasoningPatched: false }
  if (match.already) return { content, changed: false, already: true, ultraReasoningPatched: true }
  return {
    content: content.slice(0, match.offset) + CODEX_ULTRA_QUERY_GATE_PATCHED
      + content.slice(match.offset + CODEX_ULTRA_QUERY_GATE_ORIGINAL.length),
    changed: true,
    already: false,
    ultraReasoningPatched: true,
  }
}

function patchCodexModelPickerFilterContent(content) {
  if (typeof content !== 'string') {
    throw new TypeError('Codex model-picker bundle content must be a string.')
  }
  if (MODEL_PICKER_FILTER_ORIGINAL_KEY.length !== MODEL_PICKER_FILTER_PATCHED_KEY.length) {
    throw new Error('Codex model-picker patch keys must have identical lengths.')
  }

  const native = nativeModelCatalogMatches(content)
  if (native.length > 1) throw new Error(`Expected exactly one native model catalog predicate, found ${native.length}.`)
  if (native.length === 1) return { ...patchCodexUltraQueryGateContent(content), nativeModelCatalog: true }
  const matches = modelPickerFilterSignatureMatches(content)
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Codex model-picker filter signature, found ${matches.length}. ` +
      'The installed Codex version is not safely patchable by this rule.',
    )
  }

  const match = matches[0]
  const key = match.groups?.key
  if (key === MODEL_PICKER_FILTER_PATCHED_KEY) {
    return { content, changed: false, already: true }
  }
  if (key !== MODEL_PICKER_FILTER_ORIGINAL_KEY) {
    throw new Error(`Unexpected Codex model-picker filter key: ${String(key)}`)
  }

  const relativeKeyIndex = match[0].indexOf(MODEL_PICKER_FILTER_ORIGINAL_KEY)
  if (relativeKeyIndex < 0) {
    throw new Error('Codex model-picker filter signature did not contain its expected property key.')
  }
  const keyIndex = match.index + relativeKeyIndex
  const patched =
    `${content.slice(0, keyIndex)}${MODEL_PICKER_FILTER_PATCHED_KEY}` +
    content.slice(keyIndex + MODEL_PICKER_FILTER_ORIGINAL_KEY.length)
  if (patched.length !== content.length) {
    throw new Error('Codex model-picker patch unexpectedly changed the bundle length.')
  }

  return { content: patched, changed: true, already: false }
}

function isModelPickerFilterCandidate(content) {
  return nativeModelCatalogMatches(content).length > 0 ||
    (MODEL_PICKER_FILTER_REQUIRED_KEYS.every((key) => content.includes(key)) &&
      modelPickerFilterSignatureMatches(content).length > 0)
}

async function modelPickerFilterCandidates(paths) {
  const files = await webBundleFiles(paths, (filePath) => filePath.endsWith('.js'))
  const candidates = []
  for (const filePath of files) {
    const content = await readText(filePath)
    if (isModelPickerFilterCandidate(content)) {
      candidates.push({ filePath, content })
    }
  }
  return candidates
}

async function patchModelPickerVisibility(paths, report) {
  const candidates = await modelPickerFilterCandidates(paths)
  if (candidates.length !== 1) {
    const names = candidates.map(({ filePath }) => path.basename(filePath)).join(', ') || 'none'
    throw new Error(
      `Expected exactly one Codex model-picker bundle, found ${candidates.length} (${names}). ` +
      'No model-picker files were modified.',
    )
  }

  const candidate = candidates[0]
  const result = patchCodexModelPickerFilterContent(candidate.content)
  if (result.changed) {
    await writeText(candidate.filePath, result.content)
    report.addFile(candidate.filePath)
    report.addPatch(result.ultraReasoningPatched
      ? `${path.basename(candidate.filePath)}: native Ultra reasoning remains available to configured custom API Key catalogs`
      : `${path.basename(candidate.filePath)}: custom catalog models are no longer filtered by the remote availableModels allowlist`)
  } else if (result.nativeModelCatalog) {
    report.addAlready(`${path.basename(candidate.filePath)}: native custom model catalog support; no visibility patch needed`)
  } else {
    report.addAlready(
      `${path.basename(candidate.filePath)}: custom catalog model-picker visibility patch is already installed`,
    )
  }
  if (result.ultraReasoningPatched && !result.changed) {
    report.addAlready(`${path.basename(candidate.filePath)}: configured custom API Key catalog Ultra query patch is already installed`)
  }
  report.setModelPickerEnhanced(candidate.filePath, result.ultraReasoningPatched === true)
  return {
    filePath: candidate.filePath,
    changed: result.changed,
    already: result.already,
    nativeModelCatalog: result.nativeModelCatalog === true,
    ultraReasoningPatched: result.ultraReasoningPatched === true,
  }
}

async function patchCodexPluginJs(paths) {
  if (!(await exists(assetsDir(paths)))) {
    throw new Error(`解包后没有找到 Codex webview assets：${assetsDir(paths)}`)
  }

  const report = makeReport()
  await patchModelPickerVisibility(paths, report)
  await patchApiKeyServiceTierGate(paths, report)
  await report.runLayer('plugin-sidebar-entry', () => patchPluginSidebar(paths, report))
  await report.runLayer('api-key-plugin-gate', () => patchApikeyGate(paths, report))
  await report.runLayer('plugin-install-flow', () => patchConnectorGate(paths, report))
  await report.runLayer('plugin-marketplace-runtime', () => patchPluginMarketplaceRuntime(paths, report))
  await report.runLayer('chrome-plugin-preservation', () => patchChromePluginPreservation(paths, report))
  await report.runLayer('model-provider-badge', () => patchModelProviderBadge(paths, report))

  if (report.coreHits === 0) {
    throw new Error('没有命中 Codex 插件入口补丁规则，可能是 Codex 版本结构已经变化。')
  }

  return report.toJSON()
}

async function patchCodexModelPickerEntry(request = {}) {
  const paths = await detectCodexAppPaths(request)
  await ensurePrerequisites(paths)
  await stopCodex()
  const backupPath = await backupAsar(paths)

  try {
    const canReuseManagedExtractedApp =
      await exists(assetsDir(paths)) &&
      !(await exists(asarPath(paths))) &&
      await exists(renamedAsarPath(paths))
    if (!canReuseManagedExtractedApp) {
      await prepareExtractedApp(paths)
    }

    const report = makeReport()
    await patchModelPickerVisibility(paths, report)
    await patchApiKeyServiceTierGate(paths, report)
    await applyFuses(paths, PATCH_FUSES)
    await resignIfNeeded(paths)
    return {
      applied: true,
      modelPickerEnhanced: true,
      resourcesDir: paths.resourcesDir,
      appPath: paths.appPath,
      backupAsarPath: backupPath,
      extractedAppDir: extractedAppDir(paths),
      needsRestart: true,
      ...report.toJSON(),
    }
  } catch (error) {
    await rollbackAfterFailedPatch(paths).catch(() => {})
    throw error
  }
}

async function patchCodexPluginEntry(request = {}) {
  const paths = await detectCodexAppPaths(request)
  await ensurePrerequisites(paths)
  await stopCodex()
  const backupPath = await backupAsar(paths)
  await prepareExtractedApp(paths)

  try {
    const report = await patchCodexPluginJs(paths)
    await applyFuses(paths, PATCH_FUSES)
    await resignIfNeeded(paths)
    return {
      applied: true,
      resourcesDir: paths.resourcesDir,
      appPath: paths.appPath,
      backupAsarPath: backupPath,
      extractedAppDir: extractedAppDir(paths),
      needsRestart: true,
      ...report,
    }
  } catch (error) {
    await rollbackAfterFailedPatch(paths).catch(() => {})
    throw error
  }
}

module.exports = {
  PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT,
  inspectCodexUltraQueryGateContent,
  isApiKeyServiceTierGateCandidate,
  isModelPickerFilterCandidate,
  patchCodexApiKeyServiceTierGateContent,
  patchCodexModelPickerEntry,
  patchCodexModelPickerFilterContent,
  patchCodexUltraQueryGateContent,
  patchCodexPluginEntry,
  rollbackCodexPluginPatch,
}

if (require.main === module) {
  ;(async () => {
    const action = process.argv[2] || 'patch'
    let request = {}
    if (process.argv[3]) {
      request = JSON.parse(process.argv[3])
    }

    let result
    if (action === 'rollback') {
      result = await rollbackCodexPluginPatch(request)
    } else if (action === 'patch-model-picker') {
      result = await patchCodexModelPickerEntry(request)
    } else if (action === 'patch') {
      result = await patchCodexPluginEntry(request)
    } else {
      throw new Error(`Unknown Codex patch action: ${action}`)
    }
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
  })().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || '',
    })}\n`)
    process.exitCode = 1
  })
}
