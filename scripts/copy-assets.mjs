#!/usr/bin/env node
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getModel, MODEL } from './model.mjs'

const args = process.argv.slice(2)
if (!args[0] || (args.length !== 1 && !(args.length === 3 && args[1] === '--model'))) {
  console.error('Usage: tarnveil-denoise-assets <public-directory> [--model <verified-local-onnx>]')
  process.exit(1)
}
const destination = resolve(args[0])
const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist')
await mkdir(join(destination, 'ort'), { recursive: true })
for (const name of await readdir(join(dist, 'ort'))) {
  await copyFile(join(dist, 'ort', name), join(destination, 'ort', name))
}
for (const name of ['worker.js', 'worker.js.LEGAL.txt', 'worklet.js']) {
  await copyFile(join(dist, name), join(destination, name))
}
await getModel(join(destination, MODEL.name), args[2])
console.log(`Assets ready in ${destination}; model SHA-256 verified.`)
