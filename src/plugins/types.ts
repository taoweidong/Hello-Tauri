import type { Component } from 'vue'
import type { DecompressResult, FileEntry } from '@/adapters/types'

export interface ConfigField {
  key: string
  label: string
  type: 'input' | 'select' | 'switch' | 'number'
  default: any
  options?: { label: string; value: any }[]
}

export interface ConfigSchema {
  fields: ConfigField[]
}

export interface ICompressionPlugin {
  name: string
  supportedExtensions: string[]
  canHandle(file: FileEntry): boolean
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
}

export interface IFileParserPlugin {
  name: string
  supportedExtensions: string[]
  canParse(file: FileEntry): boolean
  parse(data: Uint8Array, options?: Record<string, any>): Promise<ParsedResult>
  getComponent(): Component
  getConfigSchema?(): ConfigSchema
}

export interface ParsedResult {
  type: 'text' | 'csv' | 'json' | 'hex'
  data: any
  lineCount?: number
}
