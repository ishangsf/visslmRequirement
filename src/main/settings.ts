import { safeStorage } from 'electron'
import type {
  AppSettings,
  FeatureNavigationOrder,
  FeatureModuleKey,
  FeatureModuleSettings,
  ModelSettings,
  PlatformSettingsInput,
  ProjectMatchingSettings,
  SystemSettingsInput,
  SyncScopeConfig
} from '../shared/types'
import {
  DEFAULT_PROJECT_MATCHING_SETTINGS,
  DEFAULT_FEATURE_MODULE_SETTINGS,
  DEFAULT_FEATURE_NAVIGATION_ORDER,
  normalizeProjectMatchScore
} from '../shared/types'
import { AppDatabase } from './database'

const DEFAULT_PLATFORM_URL = 'http://visionmc.vicp.net:889/alm'
const DEFAULT_MODEL_URL = 'http://127.0.0.1:11434'
const FEATURE_MODULE_KEYS = Object.keys(DEFAULT_FEATURE_MODULE_SETTINGS) as FeatureModuleKey[]
const NAVIGATION_ORDER_VERSION = 1
const USER_PROPERTY_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/
const USER_PROPERTY_KEYS_SETTING = 'system.userPropertyKeys'
const LEGACY_USER_PROPERTY_KEYS_SETTING = 'platform.userPropertyKeys'
const PROJECT_MATCH_SCORE_SETTING = 'projectMatching.minScore'

const normalizeUserPropertyKeys = (input: unknown): string[] => {
  if (!Array.isArray(input)) return []
  return [...new Set(
    input
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => USER_PROPERTY_KEY_PATTERN.test(value))
  )].slice(0, 100)
}

const normalizeNavigationOrder = (input: unknown): FeatureNavigationOrder => {
  const seen = new Set<FeatureModuleKey>()
  const normalized: FeatureNavigationOrder = []

  if (Array.isArray(input)) {
    for (const value of input) {
      if (typeof value !== 'string') continue
      const key = value as FeatureModuleKey
      if (!DEFAULT_FEATURE_NAVIGATION_ORDER.includes(key) || seen.has(key)) continue
      seen.add(key)
      normalized.push(key)
    }
  }

  for (const key of DEFAULT_FEATURE_NAVIGATION_ORDER) {
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

export class SettingsService {
  constructor(private readonly db: AppDatabase) {}

  getAll(): AppSettings {
    return {
      platform: {
        baseUrl: this.db.getSetting('platform.baseUrl') ?? DEFAULT_PLATFORM_URL,
        username: this.db.getSetting('platform.username') ?? '',
        hasToken: Boolean(this.db.getSetting('platform.token'))
      },
      system: {
        userPropertyKeys: this.getUserPropertyKeys()
      },
      model: {
        source: (this.db.getSetting('model.source') ?? 'local') as ModelSettings['source'],
        provider: (this.db.getSetting('model.provider') ?? 'ollama') as ModelSettings['provider'],
        baseUrl: this.db.getSetting('model.baseUrl') ?? DEFAULT_MODEL_URL,
        model: this.db.getSetting('model.model') ?? 'qwen3:8b',
        thinking: (this.db.getSetting('model.thinking') ?? 'false') === 'true',
        hasApiKey: Boolean(this.db.getSetting(`model.apiKey.${this.db.getSetting('model.provider') ?? 'ollama'}`))
      },
      projectMatching: {
        minScore: normalizeProjectMatchScore(this.db.getSetting(PROJECT_MATCH_SCORE_SETTING))
      },
      features: this.getFeatureSettings(),
      navigationOrder: this.getNavigationOrder()
    }
  }

  getFeatureSettings(): FeatureModuleSettings {
    return FEATURE_MODULE_KEYS.reduce<FeatureModuleSettings>((features, key) => {
      const saved = this.db.getSetting(`feature.${key}`)
      features[key] = saved === null
        ? DEFAULT_FEATURE_MODULE_SETTINGS[key]
        : saved === 'true'
      return features
    }, { ...DEFAULT_FEATURE_MODULE_SETTINGS })
  }

  getPlatformCredentials(override?: PlatformSettingsInput): {
    baseUrl: string
    username: string
    token: string
    userPropertyKeys: string[]
  } {
    const settings = this.getAll()
    return {
      baseUrl: override?.baseUrl?.trim() || settings.platform.baseUrl,
      username: override?.username?.trim() || settings.platform.username,
      token: override?.token?.trim() || this.readSecret('platform.token'),
      userPropertyKeys: settings.system.userPropertyKeys
    }
  }

  savePlatform(input: PlatformSettingsInput): AppSettings {
    this.db.setSetting('platform.baseUrl', input.baseUrl.trim().replace(/\/+$/, ''))
    this.db.setSetting('platform.username', input.username.trim())
    if (input.token?.trim()) this.writeSecret('platform.token', input.token.trim())
    return this.getAll()
  }

  saveSystem(input: SystemSettingsInput): AppSettings {
    this.db.setSetting(
      USER_PROPERTY_KEYS_SETTING,
      JSON.stringify(
        input.userPropertyKeys === undefined
          ? this.getUserPropertyKeys()
          : normalizeUserPropertyKeys(input.userPropertyKeys)
      )
    )
    return this.getAll()
  }

  private getUserPropertyKeys(): string[] {
    const raw = this.db.getSetting(USER_PROPERTY_KEYS_SETTING)
      ?? this.db.getSetting(LEGACY_USER_PROPERTY_KEYS_SETTING)
    if (!raw) return []
    try {
      return normalizeUserPropertyKeys(JSON.parse(raw))
    } catch {
      return []
    }
  }

  saveModel(input: ModelSettings): AppSettings {
    const source = input.source ?? 'local'
    const provider = input.provider ?? (source === 'local' ? 'ollama' : 'openai-compatible')
    this.db.setSetting('model.source', source)
    this.db.setSetting('model.provider', provider)
    this.db.setSetting('model.baseUrl', input.baseUrl.trim().replace(/\/+$/, ''))
    this.db.setSetting('model.model', input.model.trim())
    this.db.setSetting('model.thinking', String(input.thinking))
    if (input.apiKey?.trim()) this.writeSecret(`model.apiKey.${provider}`, input.apiKey.trim())
    return this.getAll()
  }

  saveProjectMatching(input: ProjectMatchingSettings): AppSettings {
    this.db.setSetting(PROJECT_MATCH_SCORE_SETTING, String(normalizeProjectMatchScore(input.minScore)))
    return this.getAll()
  }

  saveFeatures(input: FeatureModuleSettings): AppSettings {
    for (const key of FEATURE_MODULE_KEYS) {
      this.db.setSetting(`feature.${key}`, String(Boolean(input[key])))
    }
    return this.getAll()
  }

  getNavigationOrder(): FeatureNavigationOrder {
    const raw = this.db.getSetting('navigation.order')
    if (!raw) return [...DEFAULT_FEATURE_NAVIGATION_ORDER]

    try {
      const parsed = JSON.parse(raw) as { version?: unknown; order?: unknown }
      if (parsed.version !== NAVIGATION_ORDER_VERSION) {
        return [...DEFAULT_FEATURE_NAVIGATION_ORDER]
      }
      return normalizeNavigationOrder(parsed.order)
    } catch {
      return [...DEFAULT_FEATURE_NAVIGATION_ORDER]
    }
  }

  saveNavigationOrder(input: FeatureNavigationOrder): AppSettings {
    const order = normalizeNavigationOrder(input)
    this.db.setSetting(
      'navigation.order',
      JSON.stringify({ version: NAVIGATION_ORDER_VERSION, order })
    )
    return this.getAll()
  }

  getModelCredentials(override?: ModelSettings): ModelSettings {
    const saved = this.getAll().model
    const source = override?.source ?? saved.source
    return {
      source,
      provider: override?.provider ?? saved.provider,
      baseUrl: override?.baseUrl?.trim() || saved.baseUrl,
      model: override?.model?.trim() || saved.model,
      thinking: override?.thinking ?? saved.thinking,
      apiKey:
        source === 'online'
          ? override?.apiKey?.trim() || this.readSecret(`model.apiKey.${override?.provider ?? saved.provider}`)
          : undefined,
      hasApiKey:
        source === 'online'
          ? Boolean(this.db.getSetting(`model.apiKey.${override?.provider ?? saved.provider}`))
          : false
    }
  }

  getSyncConfig(): SyncScopeConfig | null {
    const raw = this.db.getSetting('sync.scope')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as SyncScopeConfig & { version?: number }
      if (parsed.version !== 2) return null
      if (!Array.isArray(parsed.selectedTypes) || !Array.isArray(parsed.rules)) return null
      return {
        selectedTypes: parsed.selectedTypes,
        rules: parsed.rules.map((rule) => ({
          nodeType: rule.nodeType,
          returnProperty: rule.returnProperty ?? '',
          filters: Array.isArray(rule.filters) ? rule.filters : []
        }))
      }
    } catch {
      return null
    }
  }

  saveSyncConfig(input: SyncScopeConfig): void {
    const selectedTypes = [...new Set(input.selectedTypes.map((item) => item.trim()).filter(Boolean))]
    if (!selectedTypes.length) throw new Error('请至少选择一种采集数据类型')
    const rules = input.rules
      .filter((rule) => selectedTypes.includes(rule.nodeType))
      .map((rule) => ({
        nodeType: rule.nodeType,
        returnProperty: (rule.returnProperty ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean)
          .join(','),
        filters: rule.filters
          .filter((filter) => filter.field && filter.operator)
          .map((filter) => ({
            id: filter.id,
            field: filter.field,
            operator: filter.operator,
            value: filter.value ?? ''
          }))
      }))
    this.db.setSetting('sync.scope', JSON.stringify({ version: 2, selectedTypes, rules }))
  }

  private writeSecret(key: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法使用安全凭据存储，请检查操作系统登录状态')
    }
    const encrypted = safeStorage.encryptString(value).toString('base64')
    this.db.setSetting(key, encrypted)
  }

  private readSecret(key: string): string {
    const encrypted = this.db.getSetting(key)
    if (!encrypted) return ''
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return ''
    }
  }
}
