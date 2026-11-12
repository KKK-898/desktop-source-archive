export interface ImageSkillStatus {
  status: 'changed' | 'current' | 'preserved_custom' | 'error'
  changed?: boolean
  preservedCustom?: boolean
  message?: string
  skillPath?: string
}

export interface ImageToolsTargetStatus {
  codexDir?: string
  status?: 'changed' | 'current' | 'preserved_custom' | 'error'
  configUpdated?: boolean
  imageSkill?: ImageSkillStatus
  restartToRefreshTools?: boolean
  message?: string
}

export interface ImageToolsMigrationStatus {
  status: 'not_checked' | 'complete' | 'error'
  message?: string
  targets?: ImageToolsTargetStatus[]
}

export interface ImageToolsFeedback {
  notice: string
  warning: string
}

export function getImageToolsTargetFeedback(targets: ImageToolsTargetStatus[] = []): ImageToolsFeedback {
  const warnings: string[] = []
  let ready = false
  for (const target of targets) {
    const skill = target.imageSkill
    const targetError = target.status === 'error'
    const skillError = skill?.status === 'error'
    const targetPreserved = target.status === 'preserved_custom'
    const skillPreserved = skill?.status === 'preserved_custom' || skill?.preservedCustom === true
    const location = targets.length > 1 && target.codexDir ? `（${target.codexDir}）` : ''
    const details = (messages: Array<string | undefined>) => [...new Set(messages.map((message) => message?.trim() || '').filter(Boolean))].join(' ')
    if (targetError || skillError) {
      const detail = details([targetError ? target.message : undefined, skillError ? skill?.message : undefined])
      warnings.push(`Codex 生图工具更新失败${location}。${detail}`)
    }
    if (targetPreserved || skillPreserved) {
      const detail = details([targetPreserved ? target.message : undefined, skillPreserved ? skill?.message : undefined])
      warnings.push(`已保留自定义生图配置${location}，未自动覆盖；请确认其支持 Image 2.6 和 GIF。${detail}`)
    }
    if (!targetError && !skillError && !targetPreserved && !skillPreserved) {
      const targetReady = target.status === 'changed' || target.status === 'current'
      const skillReady = skill?.status === 'changed' || skill?.status === 'current'
      if ((!target.status || targetReady) && (!skill || skillReady) && (targetReady || skillReady)) ready = true
    }
  }
  return {
    notice: ready ? 'Codex 生图工具已支持 Image 2.6 和 GIF；若工具列表尚未刷新，请手动重启 Codex。' : '',
    warning: [...new Set(warnings)].join(' '),
  }
}

export function getImageToolsMigrationFeedback(migration?: ImageToolsMigrationStatus): ImageToolsFeedback {
  if (!migration || migration.status === 'not_checked') return { notice: '', warning: '' }
  const feedback = getImageToolsTargetFeedback(migration.targets)
  if (migration.status === 'error') {
    feedback.warning = [`Codex 生图工具更新检查失败。${migration.message || ''}`, feedback.warning].filter(Boolean).join(' ')
  }
  return feedback
}
