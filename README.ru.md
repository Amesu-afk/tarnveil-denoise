# TarnVeil Denoise

[English](README.md) · Русский

Нейросетевое шумоподавление микрофона для браузерных приложений. Моноузел Web Audio с потоковой моделью на 48 кГц, созданной для [TarnVeil](https://github.com/Amesu-afk/TarnVeil). Обработка выполняется локально в Worker; сам пакет никуда не отправляет звук.

**Послушать:** [до, после и чистая речь](https://tarnveil.ru/keyboard-noise-demo.html). Демо — смесь отдельно записанных речи и клавиатуры. Обработка: только `smartnet-v54-psa`, без дополнительного подавителя ударов.

## Запустить пример

Для сборки нужен Node **22.12 или новее**, для бенчмарка — Node **24 или новее**. В браузере нужны AudioWorklet, WebAssembly SIMD и HTTPS либо localhost.

```sh
git clone https://github.com/Amesu-afk/tarnveil-denoise.git
cd tarnveil-denoise
npm ci
cd examples/vite-recorder
npm install
npm run assets
npm run dev
```

Откройте адрес localhost из терминала. Можно записать микрофон или обработать WAV, затем прослушать результат. Аккаунт не нужен. Пользуйтесь наушниками. Пример хранит запись в локальном Blob и останавливает микрофон после записи.

## Установить в своё приложение

**Публикация в реестре npm ещё не выполнена.** Версия 0.4.0 подготовлена как npm-пакет, но `npm install tarnveil-denoise` заработает после публикации. Пока доступна установка из GitHub либо архива, полученного через `npm pack`:

```sh
npm install github:Amesu-afk/tarnveil-denoise
npx tarnveil-denoise-assets public/denoise
```

В пакете есть готовые ESM-модули, типы TypeScript, собранный Worker, AudioWorklet и согласованные WASM/module-файлы ONNX Runtime **1.29.0**. Отдельно устанавливать runtime не нужно. Команда копирует ресурсы и скачивает модель размером **34 191 309 байт** из [релиза v0.3.0](https://github.com/Amesu-afk/tarnveil-denoise/releases/tag/v0.3.0), проверяя SHA-256 до записи. Веса не включены в npm-архив. Разместите ресурсы на своём домене. Для уже скачанной модели:

```sh
npx tarnveil-denoise-assets public/denoise --model /path/to/smartnet-v54-psa.onnx
```

## Подключение

```ts
import { createDenoiseNode } from 'tarnveil-denoise'

const ctx = new AudioContext({ sampleRate: 48000 })
await ctx.resume() // call from a user gesture
const mic = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
})
const source = ctx.createMediaStreamSource(mic)
const destination = ctx.createMediaStreamDestination()
const denoise = await createDenoiseNode(ctx, {
  modelUrl: '/denoise/smartnet-v54-psa.onnx',
  ortBase: new URL('/denoise/ort/', location.href).href,
  workletUrl: '/denoise/worklet.js',
  workerUrl: '/denoise/worker.js',
})
source.connect(denoise ? denoise.node : destination)
denoise?.node.connect(destination)
const restoreBrowserSuppression = () => {
  void mic.getAudioTracks()[0].applyConstraints({ noiseSuppression: true })
    .catch(console.warn)
}
if (!denoise) restoreBrowserSuppression()
denoise?.onFailure(reason => {
  console.warn('Denoiser switched to passthrough:', reason)
  restoreBrowserSuppression()
})

// Send destination.stream to WebRTC or MediaRecorder.
// When capture ends:
function stop() {
  source.disconnect()
  denoise?.dispose()
  mic.getTracks().forEach(track => track.stop())
  void ctx.close()
}
```

Функция сама регистрирует worklet и возвращает `null`, если частота не поддержана или запуск не удался. При сбое включается пропуск исходного звука, а `onFailure` уведомляет приложение: оно должно вернуть браузерное шумоподавление. Пока модель активна, браузерное шумоподавление отключено; эхоподавление работает отдельно.

Копируемые `.js` работают в Vite и при разработке, и после сборки. При сборке исходников используйте `?worker&url` для обоих модулей. Сам по себе `new URL('./worker.ts', import.meta.url)` может оставить в сборке сырой TypeScript, который браузер не выполнит.

## Измерения и ограничения

Бенчмарк использует **смесь записей**, а не живой звонок: 12 секунд речи и отдельно записанные щелчки, размещённые на уровне −14,2 дБ относительно пика речи. Подавление в дБ: медиана / десятый процентиль.

| Источник | v54, паузы | v54, поверх речи | DeepFilterNet3, паузы | DeepFilterNet3, поверх речи |
| --- | --- | --- | --- | --- |
| Клавиатура | 48,3 / 19,2 | 10,4 / 0,0 | 45,5 / 36,0 | −3,2 / −10,2 |
| Мышь | 49,3 / 38,9 | 10,4 / 1,7 | 37,5 / 28,1 | 0,0 / −5,8 |

Цифры относятся **только к этим записям и настройкам** и не доказывают общего превосходства над DeepFilterNet3. Остаток вычисляется как `enhance(speech + clicks) − enhance(speech)`; нелинейные изменения речи тоже могут попасть в этот остаток. Отрицательное подавление означает рост пика остатка. См. [методику, источники и воспроизведение](bench/README.md).

Уровень чистой речи изменился на −0,03 дБ, но ошибка формы сигнала составила −19,9 дБ относительно оригинала. Похожая громкость **не означает неизменную речь**: согласные и тембр могут меняться. Щелчки поверх речи — слабое место, некоторые почти не подавляются. Другие микрофоны, комнаты и голоса требуют отдельной проверки. Производительность на телефонах не измерена. Модель не разделяет говорящих и не подавляет эхо. API до версии 1.0 может меняться.

Замеры первого релиза/v33 и тракта приложения с отдельным подавителем ударов — другие эксперименты: [описание v0.3.0](https://github.com/Amesu-afk/tarnveil-denoise/releases/tag/v0.3.0). Это не результаты текущего демо данного пакета.

## Задержка и ресурсы

- Задержка модели/DSP: **544 отсчёта при 48 кГц = 11,33 мс**, измерена выравниванием.
- AudioWorklet начинает с **буфера в два блока (20 мс)** для сглаживания планирования. Звуковое устройство, очереди браузера и WebRTC добавляют свою задержку.
- Шаг обработки — 10 мс; вычисления должны успевать за реальным временем. Переполнение сообщает о сбое и включает пропуск звука. Актуальная нагрузка зависит от устройства и браузера; старые тайминги v33 не подтверждают скорость v54.
- Веса: 32,6 МиБ, плюс runtime. Загрузка и создание сессии занимают время до готовности узла. Настройте выдачу и кеширование файлов.

## Разработка

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run check:package  # упаковка, установка в отдельный Vite-проект, типы и сборка
npm run bench:assets
npm run bench         # Node >=24
npm run demo:render   # выровненные WAV и хеши в bench/demo-output
```

Вычисления — `src/worker.ts`, формирование кадров и ограниченная очередь — `src/worklet.ts`, API — `src/index.ts`. Контракт модели: FFT 1024, периодическое окно 960, шаг 480; у v54 также FFT 512, окно 480, шаг 240. Изменение параметров требует соответствующих весов.

Код обработки и веса — Apache-2.0. ONNX Runtime — MIT, его лицензия включена в ресурсы. Код обучения не опубликован. [Участие](CONTRIBUTING.md) · [Безопасность](SECURITY.md) · [Лицензия](LICENSE).
