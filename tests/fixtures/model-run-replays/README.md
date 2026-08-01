# Model-run PDF text replays

These tracked fixtures are immutable `pdftotext -layout` excerpts from the exact
datasheets that produced model-agent runs 93 and 94. They keep the production
two-column ordering and form-feed page boundaries needed by graph discovery.

- `run93-tps63802-time-graphs.txt`: TPS63802 PDF SHA-256
  `be07deca1231c5493957bc64c2dc1cad5543bff330e49ae41caf3286fd80dca6`;
  fixture SHA-256
  `106f842d1ac8df15fbff3decc63e11a1a466835c1ff45d1f426843bfe31a1a04`.
- `run94-ina237-time-graphs.txt`: INA237, 45-page production source; fixture
  SHA-256
  `7f37c6fea1eee36af53605f32fa29dc3701001cd6037dc6725ef4556b80e771a`.

The portable replay tests always run and fail if either fixture is missing or
changed. When the ignored local `.runtime` PDFs are present, an additional test
runs the real `pdftotext` binary over the complete PDF and checks its PDF hash,
page count, inventory, and deterministic eligibility evidence.
