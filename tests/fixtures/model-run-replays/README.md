# Model-run production replays

These tracked fixtures preserve exact production model-agent failures and
`pdftotext -layout` excerpts. They keep the source shapes needed to replay the
same parser and workflow boundaries in every test environment.

- `run93-tps63802-time-graphs.txt`: TPS63802 PDF SHA-256
  `be07deca1231c5493957bc64c2dc1cad5543bff330e49ae41caf3286fd80dca6`;
  fixture SHA-256
  `106f842d1ac8df15fbff3decc63e11a1a466835c1ff45d1f426843bfe31a1a04`.
- `run94-ina237-time-graphs.txt`: INA237, 45-page production source; fixture
  SHA-256
  `7f37c6fea1eee36af53605f32fa29dc3701001cd6037dc6725ef4556b80e771a`.
- `run105-tps63802-negative-elapsed-reference.json`: the exact Figure 10-21
  observation, deterministic hint, model interface, and application fixture
  retained from model run `bb51c363-4ddb-4e30-9fed-d6f6fabd2f74`. The observer
  placed its zero-time anchor at pixel 63 while tracing from pixel 25, producing
  three negative elapsed-time samples that previously escaped observer parsing.
  Fixture SHA-256:
  `dac60da447174ff1ddc5360e78f4418a86cd1780bb3788a1ddfeaf4d79e8248d`.

The portable replay tests always run and fail if a tracked fixture is missing or
changed. When the ignored local `.runtime` PDFs are present, additional tests run
the real `pdftotext` binary over the complete PDFs and replay retained observer
artifacts against the current parser.
