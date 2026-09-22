export interface AppInfo {
  name: string
  version: string
  tauriVersion: string
  platform: string
  arch: string
  configPath: string
}

export interface AppSettings {
  theme: 'light' | 'dark'
  pageSize: number
  autoSave: boolean
  sidebarCollapsed: boolean
  defaultRoute: string
}

export type RowStatus = 'active' | 'inactive'

export interface TableRow {
  id: number
  name: string
  category: string
  status: RowStatus
  amount: number
  owner: string
  createdAt: string
}

export type TableRowDraft = Omit<TableRow, 'id' | 'createdAt'>
