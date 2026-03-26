import * as SecureStore from 'expo-secure-store'

import type { StorageAdapter } from './types'

const CHUNK_SIZE = 1800
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/
const COUNT_SUFFIX = ':count'

export class SecureStoreChunkedStorage implements StorageAdapter {
  private toSecureStoreKey(key: string) {
    if (SAFE_KEY_PATTERN.test(key)) {
      return key
    }

    return Array.from(key, (character) =>
      SAFE_KEY_PATTERN.test(character) ? character : `_x${character.codePointAt(0)?.toString(16)}_`
    ).join('')
  }

  private getCountKey(key: string) {
    return this.toSecureStoreKey(`${key}${COUNT_SUFFIX}`)
  }

  private getChunkKey(key: string, index: number) {
    return this.toSecureStoreKey(`${key}:${index}`)
  }

  async getItem(key: string): Promise<string | null> {
    const countValue = await SecureStore.getItemAsync(this.getCountKey(key))
    if (!countValue) {
      return null
    }

    const chunkCount = Number.parseInt(countValue, 10)
    if (!Number.isFinite(chunkCount) || chunkCount < 1) {
      return null
    }

    const chunks = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) => SecureStore.getItemAsync(this.getChunkKey(key, index)))
    )

    if (chunks.some((chunk) => chunk == null)) {
      return null
    }

    return chunks.join('')
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.removeItem(key)

    const chunks = value.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g')) ?? ['']

    await Promise.all(
      chunks.map((chunk, index) => SecureStore.setItemAsync(this.getChunkKey(key, index), chunk))
    )

    await SecureStore.setItemAsync(this.getCountKey(key), String(chunks.length))
  }

  async removeItem(key: string): Promise<void> {
    const countValue = await SecureStore.getItemAsync(this.getCountKey(key))
    if (!countValue) {
      return
    }

    const chunkCount = Number.parseInt(countValue, 10)

    await Promise.all(
      Array.from({ length: Number.isFinite(chunkCount) ? chunkCount : 0 }, (_, index) =>
        SecureStore.deleteItemAsync(this.getChunkKey(key, index))
      )
    )

    await SecureStore.deleteItemAsync(this.getCountKey(key))
  }
}