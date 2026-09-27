# PP-OCRv5 model assets

The ONNX models and character dictionaries are distributed by [RapidOCR](https://github.com/RapidAI/RapidOCR), converted from PaddleOCR models. They are licensed under Apache-2.0; see `LICENSE` and `RAPIDOCR-LICENSE`.

Assets were downloaded from the RapidOCR v3.9.2 ModelScope repository:

- Detector: `ch_PP-OCRv5_det_mobile.onnx`
- Chinese, Traditional Chinese, English, and Japanese recognizer: `ch_PP-OCRv5_rec_mobile.onnx`
- Korean and English recognizer: `korean_PP-OCRv5_rec_mobile.onnx`
- Character dictionaries: `ppocrv5_dict.txt` and `ppocrv5_korean_dict.txt`

The detector and recognizer models are Apache-2.0 PaddleOCR models. Their SHA-256 checksums are:

| File | SHA-256 |
| --- | --- |
| `ch_PP-OCRv5_det_mobile.onnx` | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `ch_PP-OCRv5_rec_mobile.onnx` | `5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5` |
| `korean_PP-OCRv5_rec_mobile.onnx` | `cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b` |
