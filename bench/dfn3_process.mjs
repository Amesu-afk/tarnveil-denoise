// Runs the DeepFilterNet 3 build that the client actually ships, outside a browser.
//
// "Сильное" in the app is a wasm bundle driven from an AudioWorklet, which is not
// something a measurement script can call. But the worklet only uses four wasm
// exports - df_create, df_get_frame_length, df_process_frame, df_set_atten_lim -
// and the wasm-bindgen glue around them is thin. Reproducing that glue here lets
// the shipped binary be measured on the same files as the trained model, instead
// of being compared against numbers quoted from an older run.
//
// The imports are matched by prefix rather than by their mangled names, which
// carry a hash of the build: a rebuilt bundle changes every one of them and would
// otherwise fail here with a missing-import error that says nothing useful.
//
// Input and output are raw little-endian float32, mono, 48 kHz - the format the
// Python side memmaps directly. The manifest is a JSON array of {input, output}
// pairs; they are processed in one go because unpacking the model costs several
// seconds and doing it per file would dominate a comparison run.
//
//   node dfn3_process.mjs <df_bg.wasm> <model.tar.gz> <manifest.json> [atten_db]

import { readFileSync, writeFileSync } from 'node:fs'

const [, , wasmPath, modelPath, manifestPath, attenuation] = process.argv
if (!wasmPath || !modelPath || !manifestPath) {
  console.error('usage: dfn3_process.mjs <df_bg.wasm> <model.tar.gz> <manifest.json> [atten_db]')
  process.exit(2)
}
// The client caps attenuation at 95 dB (see deepFilterNet.ts), so that is the
// default here. Anything else would measure a mode nobody runs.
const attenuationDb = Number(attenuation ?? 95)

let wasm
const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
const bytes = () => new Uint8Array(wasm.memory.buffer)
const floats = () => new Float32Array(wasm.memory.buffer)

const handlers = {
  __wbg___wbindgen_throw: (pointer, length) => {
    throw new Error(decoder.decode(bytes().subarray(pointer, pointer + length)))
  },
  __wbg_getRandomValues: (pointer, length) => {
    crypto.getRandomValues(bytes().subarray(pointer, pointer + length))
  },
  __wbg_new_from_slice: (pointer, length) =>
    new Float32Array(floats().subarray(pointer / 4, pointer / 4 + length)),
  __wbindgen_init_externref_table: () => {
    const table = wasm.__wbindgen_externrefs
    const offset = table.grow(4)
    table.set(0, undefined)
    table.set(offset + 0, undefined)
    table.set(offset + 1, null)
    table.set(offset + 2, true)
    table.set(offset + 3, false)
  },
}

function resolve(name) {
  for (const prefix of Object.keys(handlers)) {
    if (name.startsWith(prefix)) return handlers[prefix]
  }
  // A stub rather than a failure: the bundle imports a few diagnostics that the
  // audio path never reaches, and refusing to instantiate over them would block
  // the measurement for no reason.
  return () => {
    throw new Error(`DeepFilterNet called an unimplemented import: ${name}`)
  }
}

const table = new Proxy(
  {},
  { has: () => true, get: (_, name) => (typeof name === 'string' ? resolve(name) : undefined) },
)

const module = new WebAssembly.Module(readFileSync(wasmPath))
const namespaces = {}
for (const { module: from } of WebAssembly.Module.imports(module)) namespaces[from] = table
wasm = new WebAssembly.Instance(module, namespaces).exports
wasm.__wbindgen_start()

const model = new Uint8Array(readFileSync(modelPath))

function createState() {
  const pointer = wasm.__wbindgen_malloc_command_export(model.length, 1) >>> 0
  bytes().set(model, pointer)
  return wasm.df_create(pointer, model.length, attenuationDb) >>> 0
}

function enhance(handle, input) {
  const frameLength = wasm.df_get_frame_length(handle) >>> 0
  const output = new Float32Array(input.length)
  let written = 0
  for (let start = 0; start + frameLength <= input.length; start += frameLength) {
    // A fresh allocation per frame, which is what the shipped glue does. Holding
    // one buffer across the loop looks like the obvious saving and is not: these
    // are command exports, the linear memory is reclaimed between calls, and a
    // pointer from the previous frame reads out of bounds on the next one.
    const scratch = wasm.__wbindgen_malloc_command_export(frameLength * 4, 4) >>> 0
    floats().set(input.subarray(start, start + frameLength), scratch / 4)
    const processed = wasm.df_process_frame(handle, scratch, frameLength)
    output.set(processed, written)
    written += processed.length
  }
  return output.subarray(0, written)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let frameLength = 0
for (const { input: inputPath, output: outputPath } of manifest) {
  const raw = readFileSync(inputPath)
  // A copy rather than a view: readFileSync hands back a slice of a shared pool
  // whose byteOffset need not be a multiple of four.
  const samples = new Float32Array(raw.byteLength / 4)
  Buffer.from(samples.buffer).set(raw)
  // A state per file. Carrying one across files would leak the tail of one
  // recording into the head of the next, which is the very effect being measured.
  const handle = createState()
  frameLength = wasm.df_get_frame_length(handle) >>> 0
  const enhanced = enhance(handle, samples)
  writeFileSync(outputPath, Buffer.from(enhanced.buffer, enhanced.byteOffset, enhanced.length * 4))
}
console.error(JSON.stringify({ files: manifest.length, frameLength, attenuationDb }))
