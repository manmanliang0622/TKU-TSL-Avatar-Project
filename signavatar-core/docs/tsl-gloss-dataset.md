# TSL Gloss Dataset

This project includes a local Chinese-to-Taiwan-Sign-Language gloss dataset for
Gemma instruction-tuning experiments.

## Files

- `data/tsl_gloss_dataset/raw/tsl_sentences.csv`: editable annotations.
- `data/tsl_gloss_dataset/processed/gemma_train.jsonl`: Gemma JSONL output.
- `src/signavatar/tsl_gloss_dataset.py`: CSV validation and JSONL conversion.
- `tools/build_tsl_gloss_dataset.py`: deterministic 1000-row dataset builder.

## Important Caveat

Rows marked `manual`, `synthetic_manual`, or `synthetic_template` are draft
training examples. They are useful for testing data format and fine-tuning
plumbing, but they should be reviewed by Taiwan Sign Language users or teachers
before being treated as verified linguistic data.

## Rebuild

```powershell
.\.venv\Scripts\python.exe tools\build_tsl_gloss_dataset.py
.\.venv\Scripts\python.exe -m signavatar.tsl_gloss_dataset
```
