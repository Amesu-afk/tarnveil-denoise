import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL, verifyModel } from '../scripts/model.mjs'

const bench = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] || join(bench, 'demo-output'))
mkdirSync(output, { recursive: true })
const model = join(bench, 'assets', MODEL.name)
verifyModel(readFileSync(model))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const meta = JSON.parse(readFileSync(join(bench, 'fixtures/fixtures.json'), 'utf8'))
const read = path => {
  const bytes = readFileSync(path)
  const samples = new Float32Array(bytes.length / 4)
  Buffer.from(samples.buffer).set(bytes)
  return samples
}
const mixedFile = join(bench, 'fixtures/mixed-keyboard.f32')
const speechFile = join(bench, 'fixtures/speech.f32')
const mixed = read(mixedFile)
const speech = read(speechFile)
const rawAfter = join(output, 'after.f32')
execFileSync(process.execPath, ['--experimental-transform-types', join(bench, 'model_run.ts'),
  '--model', model, '--in', mixedFile, '--out', rawAfter, '--flush'], { stdio: 'inherit' })
const produced = read(rawAfter)
const delay = 544
const aligned = produced.subarray(delay, delay + mixed.length)
if (aligned.length !== mixed.length) throw new Error('Insufficient model tail for alignment')
function wav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(meta.sample_rate, 24); bytes.writeUInt32LE(meta.sample_rate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]))
    bytes.writeInt16LE(Math.round(x * (x < 0 ? 32768 : 32767)), 44 + i * 2)
  }
  return bytes
}
const files = {}
for (const [name, samples] of [['before', mixed], ['after', aligned], ['reference', speech]]) {
  const bytes = wav(samples)
  const file = `keyboard-v54-${name}.wav`
  writeFileSync(join(output, file), bytes)
  files[file] = { bytes: bytes.length, sha256: hash(bytes) }
}
const results = JSON.parse(readFileSync(join(bench, 'results.json'), 'utf8'))
if (results.model !== MODEL.name || results.model_sha256 !== MODEL.sha256
  || results.fixture_sha256?.['speech.f32'] !== hash(readFileSync(speechFile))
  || results.fixture_sha256?.['mixed-keyboard.f32'] !== hash(readFileSync(mixedFile))) {
  throw new Error('Run npm run bench with the default v54 model and these fixtures first')
}
writeFileSync(join(output, 'keyboard-v54-metadata.json'), JSON.stringify({
  model: MODEL.name, model_sha256: MODEL.sha256,
  pipeline: 'v54 model alone, package DSP, onnxruntime-node 1.29.0; no transient suppressor',
  fixture: 'Separately recorded speech and clicks, mixed at -14.2 dB relative to speech peak; not a live call',
  sample_rate: meta.sample_rate, samples: mixed.length, seconds: mixed.length / meta.sample_rate,
  alignment_removed_samples: delay,
  onset_windows: meta.sources.keyboard.onsets.length, seed: meta.seed, speech_credit: meta.speech_credit,
  inputs: { speech_sha256: hash(readFileSync(speechFile)), mixed_sha256: hash(readFileSync(mixedFile)) },
  measurements: results.sources.find(source => source.source === 'keyboard').model,
  voice_cost: results.voice_cost.model, files,
  reproduce: 'npm run bench:assets && npm run bench && npm run demo:render',
}, null, 2) + '\n')
console.log(`Aligned v54 demo and metadata: ${output}`)
