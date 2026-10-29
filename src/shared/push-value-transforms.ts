import type { PushValueOptions } from './types'
import { pushForbiddenTargetFields, pushMappingIdentifierPattern } from './push-field-mapping'

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
const reservedQueryKeys = new Set([
  'user', 'apitoken', 'nodetype', 'projectid', 'componentid', 'parentid', 'insertafterid', 'insertbeforeid'
])

const validateKey = (key: unknown): string => {
  if (typeof key !== 'string' || !pushMappingIdentifierPattern.test(key.trim()) ||
      key.trim().split('.').some((part) => unsafeKeys.has(part))) {
    throw new Error(`参数或用户字段 Key ${String(key)} 格式无效`)
  }
  return key.trim()
}

/** Shared by preview and execution; compile before any network activity. */
export const compilePushValueTransforms = (options: PushValueOptions) => {
  for (const key of ['userMappingFields', 'userMappings', 'fixedParameters'] as const) {
    if (options[key] !== undefined && !Array.isArray(options[key])) throw new Error(`${key} 必须为数组`)
  }
  if (options.unmappedUserPolicy !== undefined && !['error', 'keep'].includes(options.unmappedUserPolicy)) {
    throw new Error('未匹配用户处理方式无效')
  }
  const fields = (options.userMappingFields ?? []).map(validateKey)
  if (new Set(fields).size !== fields.length) throw new Error('用户映射字段存在重复')
  if (fields.some((field) => pushForbiddenTargetFields.has(field))) throw new Error('用户映射不能使用消息体禁止字段')
  const users = new Map<string, string>()
  for (const row of options.userMappings ?? []) {
    if (!row || typeof row.sourceLogin !== 'string' || typeof row.targetLogin !== 'string' ||
        !row.sourceLogin.trim() || !row.targetLogin.trim()) throw new Error('请完整填写源登录名和目标登录名/能力名')
    const source = row.sourceLogin.trim()
    if (users.has(source)) throw new Error(`源登录名 ${source} 存在重复映射`)
    users.set(source, row.targetLogin.trim())
  }
  if (users.size && !fields.length) throw new Error('请指定需要转换用户的目标字段 Key')
  if (fields.length && !users.size) throw new Error('请至少添加一组用户映射')
  const usedParameters = new Set<string>()
  const fixed = (options.fixedParameters ?? []).map((row) => {
    if (!row || !['body', 'query'].includes(row.location)) throw new Error('固定参数位置无效')
    const key = validateKey(row.key)
    if (row.location === 'body' && pushForbiddenTargetFields.has(key)) throw new Error(`固定参数 ${key} 是消息体禁止字段`)
    if (row.location === 'query' && reservedQueryKeys.has(key.toLowerCase())) {
      throw new Error(`固定参数 ${key} 与认证或新建位置参数冲突，请使用原配置入口`)
    }
    const identity = `${row.location}:${key}`
    if (usedParameters.has(identity)) throw new Error(`固定参数 ${key} 在同一位置重复`)
    usedParameters.add(identity)
    if (typeof row.value !== 'string' || !['text', 'json'].includes(row.valueType)) throw new Error(`固定参数 ${key} 的值类型无效`)
    if (row.location === 'query' && row.valueType !== 'text') throw new Error('URL 固定参数只支持文本值')
    let value: unknown = row.value
    if (row.valueType === 'json') {
      try {
        value = JSON.parse(row.value)
        // Reject non-finite numbers such as JSON's syntactically valid 1e999.
        JSON.stringify(value, (_key, item) => {
          if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('non-finite')
          return item
        })
      } catch { throw new Error(`固定参数 ${key} 不是有效 JSON（数字、布尔值、数组、对象或 null）`) }
    }
    return { key, location: row.location, value }
  })

  const mapLogin = (login: string, field: string): string => {
    if (!login.trim()) return login
    const target = users.get(login.trim())
    if (target !== undefined) return target
    if (options.unmappedUserPolicy === 'keep') return login
    throw new Error(`用户字段 ${field} 的登录名“${login.trim()}”未配置映射`)
  }
  const mapValue = (value: unknown, field: string): unknown => {
    if (value === null || value === undefined || value === '') return value
    if (Array.isArray(value)) return value.map((item) => mapValue(item, field))
    if (typeof value !== 'string') throw new Error(`用户字段 ${field} 需为登录名文本或数组，请先核对数据结构`)
    // Prefer a whole-value match; otherwise preserve the original multi-user delimiters.
    if (users.has(value.trim())) return users.get(value.trim())
    return value.split(/([,;，；\r\n]+)/).map((part, index) => index % 2 ? part : mapLogin(part, field)).join('')
  }
  return (body: Record<string, unknown>, params: Record<string, string>) => {
    const nextBody = { ...body }
    const nextParams = { ...params }
    const fixedBodyKeys = new Set(fixed.filter((row) => row.location === 'body').map((row) => row.key))
    for (const field of fields) {
      // Explicit final constants take precedence; no mapping is needed for overwritten data.
      if (Object.hasOwn(nextBody, field) && !fixedBodyKeys.has(field)) nextBody[field] = mapValue(nextBody[field], field)
    }
    for (const row of fixed) {
      if (row.location === 'body') nextBody[row.key] = structuredClone(row.value)
      else nextParams[row.key] = row.value as string
    }
    return { body: nextBody, params: nextParams }
  }
}
