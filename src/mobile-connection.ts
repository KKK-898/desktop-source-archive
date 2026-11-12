import { invoke } from '@tauri-apps/api/core'

export type MobileConnectionState = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error'

export type MobileComponentState = 'not_installed' | 'installed' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'error'

export interface MobileComponentStatus {
  state: MobileComponentState
  installedVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  downloadBytes: number
  totalBytes: number | null
  error: string | null
  platform: string
  /** True only when the installed component can run; false before installation. */
  compatible: boolean
}

export interface MobileConnectionStatus {
  relayConfigured: boolean
  runtimeAvailable: boolean
  state: MobileConnectionState
  username: string
  hasPassword: boolean
  relayUrl: string
  /** A saved enrollment code or an existing device registration is available. */
  hasEnrollmentToken: boolean
  publicUrl: string | null
  pairing: { url: string; expiresAt: number } | null
  devices: { id: string; name: string; lastSeen: number }[]
  error: string | null
}

export interface SaveMobileConnectionRequest {
  username: string
  /** Omit to retain the saved password. Never returned by the status command. */
  password?: string
  relayUrl?: string
  enrollmentToken?: string
  /** Sent only to the built-in Gaoge mobile relay for first-time device registration. */
  accountToken?: string
}

export const hasMobileDesktopRuntime = () => typeof window !== 'undefined'
  && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

export function unavailableMobileConnection(): MobileConnectionStatus {
  return {
    relayConfigured: false,
    runtimeAvailable: false,
    state: 'stopped',
    username: '',
    hasPassword: false,
    relayUrl: '',
    hasEnrollmentToken: false,
    publicUrl: null,
    pairing: null,
    devices: [],
    error: null,
  }
}

export function unavailableMobileComponent(): MobileComponentStatus {
  return {
    state: 'not_installed',
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    downloadBytes: 0,
    totalBytes: null,
    error: null,
    platform: '',
    compatible: false,
  }
}

function callMobile(command: string, request?: unknown): Promise<MobileConnectionStatus> {
  if (!hasMobileDesktopRuntime()) return Promise.reject(new Error('请在 Gaoge Free 桌面软件中连接手机。'))
  return invoke<MobileConnectionStatus>(command, request === undefined ? undefined : { request })
}

export const mobileConnection = {
  status: () => hasMobileDesktopRuntime()
    ? callMobile('mobile_connection_status')
    : Promise.resolve(unavailableMobileConnection()),
  save: (request: SaveMobileConnectionRequest) => callMobile('mobile_connection_save', request),
  start: () => callMobile('mobile_connection_start'),
  stop: () => callMobile('mobile_connection_stop'),
  pair: () => callMobile('mobile_connection_pair'),
  revokeDevice: (deviceId: string) => callMobile('mobile_connection_revoke_device', { deviceId }),
}

function callComponent(command: string): Promise<MobileComponentStatus> {
  if (!hasMobileDesktopRuntime()) return Promise.reject(new Error('请在 Gaoge Free 桌面软件中安装手机连接组件。'))
  return invoke<MobileComponentStatus>(command)
}

export const mobileComponent = {
  status: () => hasMobileDesktopRuntime()
    ? callComponent('mobile_component_status')
    : Promise.resolve(unavailableMobileComponent()),
  check: () => callComponent('mobile_component_check'),
  install: () => callComponent('mobile_component_install'),
}
