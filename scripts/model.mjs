import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export const MODEL = Object.freeze({
  name: 'smartnet-v54-psa.onnx',
  url: 'https://github.com/Amesu-afk/tarnveil-denoise/releases/download/v0.3.0/smartnet-v54-psa.onnx',
  sha256: '37009b8639e3e1eb65d065b4b93e4053bf59485e8baed4e5afe50b4b8cdff5ce',
})
export function verifyModel(bytes) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== MODEL.sha256) throw new Error(`Model SHA-256 mismatch: ${actual}`)
  return bytes
}
export async function getModel(destination, localPath) {
  if (localPath) {
    await writeFile(destination, verifyModel(await readFile(localPath)))
    return
  }
  try { verifyModel(await readFile(destination)); return } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const response = await fetch(MODEL.url)
  if (!response.ok) throw new Error(`Model download: HTTP ${response.status}`)
  await writeFile(destination, verifyModel(Buffer.from(await response.arrayBuffer())))
}
