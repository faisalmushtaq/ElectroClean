# Validation of the artifact labels against HED SCORE 2.2.0

The specification asks for the 16 labels to be checked against the designated
HED-SCORE version without silently changing them. The check was made on
26 October 2026 against `HED_score_2.2.0.xml` from the
[hed-standard/hed-schemas](https://github.com/hed-standard/hed-schemas)
repository (library `score`, version 2.2.0, built on HED standard 8.5.0;
SHA-256 `db6fc13455ecf604c4ed45236237bd83911bb71a09e9bdabecb2299878070e72`).
The HED-SCORE library is described by Hermes et al. (2025).

**Result: all 16 labels exist in the schema with exactly the requested
spelling and capitalisation. No discrepancies were found and no label was
changed.**

| Code | Label | Position in HED SCORE 2.2.0 (under `Property/Data-property/Data-artifact/`) |
|---|---|---|
| 100 | Chewing-artifact | `Biological-artifact/Chewing-artifact` |
| 101 | ECG-artifact | `Biological-artifact/ECG-artifact` |
| 102 | EMG-artifact | `Biological-artifact/EMG-artifact` |
| 103 | Eye-blink-artifact | `Biological-artifact/Eye-artifact/Eye-blink-artifact` |
| 104 | Horizontal-eye-movement-artifact | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Horizontal-eye-movement-artifact` |
| 105 | Slow-eye-movement-artifact | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Slow-eye-movement-artifact` |
| 106 | Vertical-eye-movement-artifact | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Vertical-eye-movement-artifact` |
| 107 | Movement-artifact | `Biological-artifact/Movement-artifact` |
| 108 | Pulse-artifact | `Biological-artifact/Pulse-artifact` |
| 109 | Respiration-artifact | `Biological-artifact/Respiration-artifact` |
| 110 | Sweat-artifact | `Biological-artifact/Sweat-artifact` |
| 111 | Tongue-movement-artifact | `Biological-artifact/Tongue-movement-artifact` |
| 112 | Induction-artifact | `Nonbiological-artifact/Electrical-artifact/Induction-artifact` |
| 113 | Electrode-movement-artifact | `Nonbiological-artifact/Electrode-movement-artifact` |
| 114 | Electrode-pops-artifact | `Nonbiological-artifact/Localized-channel-artifact/Electrode-pops-artifact` |
| 115 | Salt-bridge-artifact | `Nonbiological-artifact/Localized-channel-artifact/Salt-bridge-artifact` |

Notes for the research team:

* Version 2.2.0 places Induction-artifact under a new `Electrical-artifact`
  group and Electrode-pops and Salt-bridge under `Localized-channel-artifact`.
  The label strings, which are what ElectroClean stores, are the same as in
  versions 2.0.0 and 2.1.0.
* The schema also defines Line-noise-artifact, Nystagmus-artifact,
  Artificial-ventilation-artifact, Dialysis-artifact, Rocking-patting-artifact
  and Sucking-artifact, which are not among the requested labels.
* In HED strings the library prefix is written `sc:`, for example
  `sc:Eye-blink-artifact`; ElectroClean writes these tags into each events
  sidecar.

The check is reproducible with `python scripts/validate_hed_labels.py`, which
downloads the schema (or reads a local copy with `--xml`) and writes
`electroclean/config/hed_score_2.2.0_validation.json`. The test-suite checks
the catalogue against that snapshot offline.
