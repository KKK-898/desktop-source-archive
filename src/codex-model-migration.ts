export type CodexModelSelectionOrigin = 'automatic' | 'user'

export interface CodexModelMigrationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface CodexModelMigrationOptions {
  currentDefaultModel: string
  legacyDefaultModel: string
  modelKey: string
  lockedModelKey: string
  selectionModeKey: string
  legacyDefaultedKey: string
  selectionOriginKey: string
  migrationKey: string
  isConversationModel(model: string): boolean
}

export function normalizeCodexModelSelectionOrigin(
  value: string | null | undefined,
): CodexModelSelectionOrigin | '' {
  return value === 'automatic' || value === 'user' ? value : ''
}

export function migrateCodexDefaultModelStorage(
  storage: CodexModelMigrationStorage,
  options: CodexModelMigrationOptions,
) {
  if (storage.getItem(options.migrationKey) === '1') return

  const storedModel = (storage.getItem(options.modelKey) || '').trim()
  const storedLockedModel = (storage.getItem(options.lockedModelKey) || '').trim()
  const storedMode = storage.getItem(options.selectionModeKey)
  const storedOrigin = storage.getItem(options.selectionOriginKey)
  const legacyDefaulted = storage.getItem(options.legacyDefaultedKey) === '1'
  const originIsKnown = storedOrigin === 'automatic' || storedOrigin === 'user'
  const explicitLockedModel = storedMode === 'locked'
    && options.isConversationModel(storedLockedModel)
    ? storedLockedModel
    : ''

  if (explicitLockedModel) {
    // In locked mode the dedicated locked-model field is authoritative. Older
    // builds could leave the general model field empty or invalid, but that
    // must not turn an explicit user choice (including gpt-5.5) into an
    // automatic default migration.
    if (storedModel !== explicitLockedModel) {
      storage.setItem(options.modelKey, explicitLockedModel)
    }
    if (storedOrigin !== 'user') {
      storage.setItem(options.selectionOriginKey, 'user')
    }
    storage.setItem(options.migrationKey, '1')
    return
  }

  const legacyAutomaticDefault = storedModel === options.legacyDefaultModel
    && storedMode !== 'locked'
    && (!storedLockedModel || storedLockedModel === options.legacyDefaultModel)
    && (
      storedOrigin === 'automatic'
      || (!originIsKnown && legacyDefaulted)
    )

  if (!options.isConversationModel(storedModel) || legacyAutomaticDefault) {
    storage.setItem(options.modelKey, options.currentDefaultModel)
    if (
      !storedLockedModel
      || storedLockedModel === options.legacyDefaultModel
      || !options.isConversationModel(storedLockedModel)
    ) {
      storage.setItem(options.lockedModelKey, options.currentDefaultModel)
    }
    storage.setItem(options.selectionOriginKey, 'automatic')
  } else if (!originIsKnown) {
    // Older builds did not record whether a valid model was selected manually.
    // Preserve it unless the legacy automatic-default markers prove otherwise.
    storage.setItem(options.selectionOriginKey, 'user')
  }

  storage.setItem(options.migrationKey, '1')
}

export function resolveCodexBackendModelAfterDefaultMigration(
  storage: CodexModelMigrationStorage,
  options: CodexModelMigrationOptions,
  backendModel: string,
  backendOrigin?: string | null,
) {
  const normalizedBackend = backendModel.trim()
  if (!options.isConversationModel(normalizedBackend)) return options.currentDefaultModel
  if (normalizedBackend !== options.legacyDefaultModel) return normalizedBackend

  const normalizedBackendOrigin = normalizeCodexModelSelectionOrigin(backendOrigin)
  if (normalizedBackendOrigin === 'user') return normalizedBackend
  if (normalizedBackendOrigin === 'automatic') return options.currentDefaultModel

  const storedModel = (storage.getItem(options.modelKey) || '').trim()
  const storedOrigin = normalizeCodexModelSelectionOrigin(
    storage.getItem(options.selectionOriginKey),
  )
  const legacyAutomaticDefaultWasMigrated = storage.getItem(options.migrationKey) === '1'
    && storedOrigin === 'automatic'
    && storedModel === options.currentDefaultModel

  return legacyAutomaticDefaultWasMigrated
    ? options.currentDefaultModel
    : normalizedBackend
}
