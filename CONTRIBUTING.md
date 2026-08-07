# Contributing

Thanks for looking. A few honest notes first.

This repository is a **one-way mirror**. The code is developed inside the TarnVeil
monorepo and exported here; nothing is ever merged back from this side. A pull request
cannot be merged as-is — it will be applied upstream and appear here on the next mirror,
with your authorship preserved in the commit.

There is one maintainer. Response times are not guaranteed.

## What is genuinely welcome

- **Measurements that contradict the README.** The numbers there come from real
  recordings with a clean reference; if yours disagree, that is worth more than a patch.
  Attach the audio.
- **Bugs with a reproducer.** Sample rate, browser, and the input file.
- **Making the model contract easier to get right.** The 48 kHz / 1024 / 960 / 480 tuple
  has to match what the model was trained on, and getting it wrong sounds wrong without
  failing.

## What will probably be declined

- **Approaches to keyboard clicks under speech that have not been measured.** Eight have
  been tried and are listed in the README. Reasoning about the mechanism has a poor track
  record here — seven of those eight looked convincing beforehand.
- Retraining proposals without an evaluation plan. The trap in this problem is that the
  scene generator's own metric keeps improving while the model overfits to the generator.
  Any claim of improvement has to be shown on held-out live recordings.
- Reformatting, renaming, or dependency churn.

## Before you send anything

```bash
npx tsc --noEmit -p tsconfig.json
```

The one error about `onnxruntime-web` is expected unless you have installed the peer
dependency locally.

Keep comments explaining **why**, not what — the existing ones record measurements and
failed attempts on purpose, so the next person does not repeat them.
