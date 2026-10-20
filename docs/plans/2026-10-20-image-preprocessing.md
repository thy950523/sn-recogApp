# Image preprocessing implementation plan

**Goal:** Preserve original photo bytes while removing repeated JPEG encoding and overlapping barcode/OCR work. Normal capture now uses the system still-camera entry point.

**Architecture:** Keep the existing data URL display contract and carry an optional original Blob alongside it. Store and upload that Blob directly. Scan a separate canvas limited to 1600px; retain the full canvas for local OCR fallback. For uploads above the existing 10 MiB request limit, generate one JPEG adaptation without replacing the stored original.

**Tech stack:** React, TypeScript, Canvas, IndexedDB, Vitest, Playwright, existing RapidOCR.

1. Add a byte-preserving photo import helper shared by system camera and album input. Video-frame capture was superseded and removed at the user's request.
2. Pass the original Blob through ScanView, Home storage, and MultiResultView. Guard asynchronous capture/import against duplicate actions and unmounts.
3. Start server OCR and barcode work together in recognizeMulti. Upload original bytes where possible and normalize barcode coordinates against the actual scan canvas.
4. Add regression coverage for raw upload, concurrent start, normalized coordinates, and server failure fallback. Run npm test and npm run build.
5. Re-run all five supplied photos through the real file-import UI, record timing/results, and verify stored source bytes. Do not register records or change recognition acceptance rules.

Approved by the user on 2026-10-20: implement the recommended version directly. Work in the current checkout to preserve existing uncommitted changes; do not commit unrelated work.

## Validation

- Actual album-import UI: all five 3024×4032 JPEG files remain byte-identical in upload and IndexedDB (SHA-256 verified). No test records registered.
- Single local UI runs: 528 / 499 / 487 / 529 / 530 ms for IMG_6026 / IMG_6025 / IMG_6023 2 / IMG_6024 / IMG_6027. These include UI/import overhead and cannot establish a speedup over earlier recognition-only timings.
- First four photos retain correct SN, IMEI1, IMEI2 and EID. Tilted IMG_6027 remains a mismatch: truncated SN and IMEI2, but IMEI1 and EID are recovered. Acceptance/default-selection rules are unchanged.
- Final capture flow: the photo button triggers an image-only file input with `capture="environment"`. There is no video element or camera-stream request on the normal scan screen. The continuous-scan entry is hidden; its implementation is retained.
- Browser verification of a returned photo: 3024×4032 preserved, uploaded/stored bytes match the source, and SN/IMEI/EID recognized correctly. Native camera presentation still requires device/browser verification.
- Oversized files and formats unsupported by OpenCV get one OCR-only JPEG adaptation; their stored original is unchanged.
- Detailed browser evidence: `/Users/zhuzhong/Downloads/sn-photo/implemented-preprocessing-results-2026-10-20.json`.
