import test from 'node:test'
import assert from 'node:assert/strict'
import { getImageToolsMigrationFeedback, getImageToolsTargetFeedback } from '../src/image-tools-status.ts'

test('missing or pending migration does not claim tools were installed', () => {
  assert.deepEqual(getImageToolsMigrationFeedback(), { notice: '', warning: '' })
  assert.deepEqual(getImageToolsMigrationFeedback({ status: 'not_checked' }), { notice: '', warning: '' })
  assert.deepEqual(getImageToolsMigrationFeedback({ status: 'complete', targets: [] }), { notice: '', warning: '' })
})

test('managed migration gives a conditional manual restart notice without claiming app restart', () => {
  for (const status of ['changed', 'current']) {
    const feedback = getImageToolsMigrationFeedback({ status: 'complete', targets: [{ status, restartToRefreshTools: true }] })
    assert.match(feedback.notice, /Image 2.6 和 GIF/)
    assert.match(feedback.notice, /若工具列表尚未刷新，请手动重启 Codex/)
    assert.equal(feedback.warning, '')
    assert.doesNotMatch(feedback.notice, /已重启|自动重启/)
  }
})

test('custom skill is preserved and its reason is shown instead of a successful upgrade', () => {
  const feedback = getImageToolsTargetFeedback([{ imageSkill: {
    status: 'preserved_custom', preservedCustom: true, message: 'The local skill was edited by the user.',
  } }])
  assert.equal(feedback.notice, '')
  assert.match(feedback.warning, /已保留自定义生图配置/)
  assert.match(feedback.warning, /The local skill was edited by the user/)
})

test('migration and skill write failures retain actionable error details', () => {
  const feedback = getImageToolsMigrationFeedback({ status: 'error', message: '目录不可读取', targets: [
    { codexDir: 'C:/one', status: 'error', message: '配置写入失败' },
    { codexDir: 'C:/two', imageSkill: { status: 'error', message: '规则文件不可写入' } },
  ] })
  assert.equal(feedback.notice, '')
  for (const text of ['目录不可读取', '配置写入失败', '规则文件不可写入', 'C:/one', 'C:/two']) assert.ok(feedback.warning.includes(text))
})

test('mixed targets report successful integration and preserve warnings for skipped homes', () => {
  const feedback = getImageToolsTargetFeedback([
    { codexDir: 'C:/managed', imageSkill: { status: 'changed', changed: true } },
    { codexDir: 'C:/custom', status: 'preserved_custom', message: '自定义启动参数已保留' },
  ])
  assert.match(feedback.notice, /Image 2.6 和 GIF/)
  assert.match(feedback.warning, /C:\/custom/)
  assert.match(feedback.warning, /自定义启动参数已保留/)
})


test('a preserved custom MCP configuration is not hidden by a current or updated skill', () => {
  for (const status of ['current', 'changed']) {
    const feedback = getImageToolsTargetFeedback([{
      status: 'preserved_custom', message: '自定义 MCP 启动参数已保留',
      imageSkill: { status, message: 'Gaoge image skill is already current' },
    }])
    assert.equal(feedback.notice, '')
    assert.match(feedback.warning, /自定义 MCP 启动参数已保留/)
    assert.doesNotMatch(feedback.warning, /Gaoge image skill is already current/)
  }
})

test('an outer configuration failure is not hidden by an otherwise current skill', () => {
  const feedback = getImageToolsTargetFeedback([{
    status: 'error', message: 'MCP 配置文件写入被拒绝',
    imageSkill: { status: 'current', message: 'Gaoge image skill is already current' },
  }])
  assert.equal(feedback.notice, '')
  assert.match(feedback.warning, /更新失败/)
  assert.match(feedback.warning, /MCP 配置文件写入被拒绝/)
  assert.doesNotMatch(feedback.warning, /Gaoge image skill is already current/)
})

test('independent configuration errors and preserved custom skills both remain visible', () => {
  const feedback = getImageToolsTargetFeedback([{
    status: 'error', message: 'MCP 配置不可写入',
    imageSkill: { status: 'preserved_custom', preservedCustom: true, message: '用户已编辑技能内容' },
  }])
  assert.equal(feedback.notice, '')
  assert.match(feedback.warning, /MCP 配置不可写入/)
  assert.match(feedback.warning, /已保留自定义生图配置/)
  assert.match(feedback.warning, /用户已编辑技能内容/)
})

test('identical nested errors are shown once without losing the failure state', () => {
  const message = 'The target directory is not writable; preserve the existing configuration.'
  const feedback = getImageToolsTargetFeedback([{
    status: 'error', message, imageSkill: { status: 'error', message },
  }])
  assert.equal(feedback.notice, '')
  assert.equal(feedback.warning.split(message).length - 1, 1)
})
