# OCR language data

The traineddata files tesseract.js reads a scanned PDF brief with (`src/services/network/pdfTextWorker.mjs`), vendored so that nothing is fetched at run time: the API container has no business downloading at ingestion, and the tests read the same bytes on every machine.

| File | Source | SHA-256 of the `.gz` |
|---|---|---|
| `fra.traineddata.gz` | [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) `main`, `fra.traineddata`, gzipped | `8374ea9aec6cb25f9aca7d4bc4516d798fee893cbfab08843dea4e419c85e5f8` |
| `eng.traineddata.gz` | the same, `eng.traineddata`, gzipped | `5f2da6da7836611a8092ffeaca558cc6355f70962f402f912bb69fa5d20a7118` |

Licence: Apache License 2.0 (the tessdata_fast repository's). The "fast" models are the integer versions of the LSTM models: a page in about a second, enough for a timetable or a memo (the fiche horaire of the evaluation corpus reads at 94 % confidence).

To refresh: download `<lang>.traineddata` from the repository above, `gzip -k` it here, and update the table.
