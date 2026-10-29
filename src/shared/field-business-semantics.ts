import type { FieldProfileSemanticPatch } from './query-spec'

export const normalizeFieldBusinessSemantics = (patch: FieldProfileSemanticPatch): FieldProfileSemanticPatch => {
  const output: FieldProfileSemanticPatch = {}
  for (const [key, limit] of [['businessMeaning', 1_000], ['unit', 40]] as const) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'string') throw new Error('业务定义和单位必须是文本')
    output[key] = patch[key]!.trim().slice(0, limit)
  }
  if (patch.valueLabels !== undefined) {
    if (!patch.valueLabels || typeof patch.valueLabels !== 'object' || Array.isArray(patch.valueLabels)) throw new Error('枚举释义必须是编码到中文含义的对象')
    const entries = Object.entries(patch.valueLabels)
    if (entries.length > 100 || entries.some(([key, value]) => !key.trim() || key.length > 120 || typeof value !== 'string' || value.length > 160)) {
      throw new Error('枚举释义最多 100 项，编码不超过 120 字，含义不超过 160 字')
    }
    output.valueLabels = Object.fromEntries(entries.map(([key, value]) => [key.trim(), value.trim()]))
  }
  return output
}
