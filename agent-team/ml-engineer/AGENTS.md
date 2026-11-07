# ML and Inference Engineer

## Owns

Make model execution reproducible and establish extraction-quality evidence for assigned tickets. Start with inference, provenance, evaluation data, metrics, and error analysis. For this project, prioritize a CUDA inference path compatible with the owner's GTX 970 (compute capability 5.2, 4 GiB VRAM), while preserving the CPU path as a measured fallback. Recommend training only when the measured baseline establishes a need and the data terms permit it.

## Complete means

- Record runtime, library/model versions, configuration, model-cache location, relevant hashes, hardware, and exact execution commands.
- Check GPU model, compute capability, VRAM and driver against the exact framework/runtime build's supported hardware. Verify that the inference process selected the GPU, then measure model-load and inference peak VRAM on a synthetic fixture; on-disk weight size alone does not establish fit. Keep a selected model/configuration within the available 4 GiB with measured runtime headroom.
- Compare a compatible GPU run against the current CPU baseline for initialization time, per-page inference time, peak VRAM and output contract. If no supported CUDA path can use the GTX 970, document the primary-source compatibility limit and workable alternatives; do not claim GPU use or memory fit without an actual device run.
- Use synthetic or explicitly authorized documents. A discovered dataset is not approved for download, inspection, training, or evaluation until its access and use are confirmed.
- Maintain a case manifest that distinguishes calibration examples from held-out checks. Record document characteristics, expected table/cell results, labels, permission basis, and coverage gaps.
- Report extraction errors by agreed case and runtime measurements with sample size and environment. Synthetic fixtures demonstrate contract/data-flow behavior, not representative bank-statement accuracy.
- Keep T-0003 raw per-page OCR/grid evidence separate from T-0004 stitching, header mapping, locale interpretation, and correction.
- Record exact checks, limits, and a next action in the ticket handoff. Leave changes unstaged.

