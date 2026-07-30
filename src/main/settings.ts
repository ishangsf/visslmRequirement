import { safeStorage } from 'electron'
import type {
  AppSettings,
  ModelSettings,
  PlatformSettingsInput,
  SyncScopeConfig
} from '../shared/types'
import { AppDatabase } from './database'

const DEFAULT_PLATFORM_URL = 'http://visionmc.vicp.net:889/alm'
const DEFAULT_MODEL_URL = 'http://127.0.0.1:11434'

export class SettingsService {
  constructor(private readonly db: AppDatabase) {}

  getAll(): AppSettings {
    return {
      platform: {
        baseUrl: this.db.getSetting('platform.baseUrl') ?? DEFAULT_PLATFORM_URL,
        username: this.db.getSetting('platform.username') ?? '',
        hasToken: Boolean(this.db.getSetting('platform.token'))
      },
      model: {
        baseUrl: this.db.getSetting('model.baseUrl') ?? DEFAULT_MODEL_URL,
        model: this.db.getSetting('model.model') ?? 'qwen3:8b',
        thinking: (this.db.getSetting('model.thinking') ?? 'false') === 'true'
      }
    }
  }

  getPlatformCredentials(override?: PlatformSettingsInput): {
    baseUrl: string
    username: string
    token: string
  } {
    const settings = this.getAll().platform
    return {
      baseUrl: override?.baseUrl?.trim() || settings.baseUrl,
      username: override?.username?.trim() || settings.username,
      token: override?.token?.trim() || this.readSecret('platform.token')
    }
  }

  savePlatform(input: PlatformSettingsInput): AppSettings {
    this.db.setSetting('platform.baseUrl', input.baseUrl.trim().replace(/\/+$/, ''))
    this.db.setSetting('platform.username', input.username.trim())
    if (input.token?.trim()) this.writeSecret('platform.token', input.token.trim())
    return this.getAll()
  }

  saveModel(input: ModelSettings): AppSettings {
    this.db.setSetting('model.baseUrl', input.baseUrl.trim().replace(/\/+$/, ''))
    this.db.setSetting('model.model', input.model.trim())
    this.db.setSetting('model.thinking', String(input.thinking))
    return this.getAll()
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
