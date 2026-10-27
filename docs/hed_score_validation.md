# Validation of the artifact labels against HED SCORE 2.2.0

ElectroClean offers every artifact term of the HED SCORE library schema,
version 2.2.0: the 16 types of the original specification, the 6 further
specific types, and the 7 group terms above them (for artifacts whose exact
type is unclear). The check was made against `HED_score_2.2.0.xml` from the
[hed-standard/hed-schemas](https://github.com/hed-standard/hed-schemas)
repository (library `score`, version 2.2.0, built on HED standard 8.5.0;
SHA-256 `db6fc13455ecf604c4ed45236237bd83911bb71a09e9bdabecb2299878070e72`). The HED-SCORE library is described by
Hermes et al. (2025).

**Result: all 29 terms exist in the schema with exactly the spelling and
capitalisation used by ElectroClean, each term's kind (specific type or group
term) and parent group agree with the schema, and no artifact term of the
schema is missing. No label was changed.**

| Code | Label | Kind | Position in HED SCORE 2.2.0 (under `Property/Data-property/Data-artifact/`) |
|---|---|---|---|
| 100 | Chewing-artifact | specific | `Biological-artifact/Chewing-artifact` |
| 101 | ECG-artifact | specific | `Biological-artifact/ECG-artifact` |
| 102 | EMG-artifact | specific | `Biological-artifact/EMG-artifact` |
| 103 | Eye-blink-artifact | specific | `Biological-artifact/Eye-artifact/Eye-blink-artifact` |
| 104 | Horizontal-eye-movement-artifact | specific | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Horizontal-eye-movement-artifact` |
| 105 | Slow-eye-movement-artifact | specific | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Slow-eye-movement-artifact` |
| 106 | Vertical-eye-movement-artifact | specific | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Vertical-eye-movement-artifact` |
| 107 | Movement-artifact | specific | `Biological-artifact/Movement-artifact` |
| 108 | Pulse-artifact | specific | `Biological-artifact/Pulse-artifact` |
| 109 | Respiration-artifact | specific | `Biological-artifact/Respiration-artifact` |
| 110 | Sweat-artifact | specific | `Biological-artifact/Sweat-artifact` |
| 111 | Tongue-movement-artifact | specific | `Biological-artifact/Tongue-movement-artifact` |
| 112 | Induction-artifact | specific | `Nonbiological-artifact/Electrical-artifact/Induction-artifact` |
| 113 | Electrode-movement-artifact | specific | `Nonbiological-artifact/Electrode-movement-artifact` |
| 114 | Electrode-pops-artifact | specific | `Nonbiological-artifact/Localized-channel-artifact/Electrode-pops-artifact` |
| 115 | Salt-bridge-artifact | specific | `Nonbiological-artifact/Localized-channel-artifact/Salt-bridge-artifact` |
| 116 | Line-noise-artifact | specific | `Nonbiological-artifact/Electrical-artifact/Line-noise-artifact` |
| 117 | Nystagmus-artifact | specific | `Biological-artifact/Eye-artifact/Eye-movement-artifact/Nystagmus-artifact` |
| 118 | Artificial-ventilation-artifact | specific | `Nonbiological-artifact/Artificial-ventilation-artifact` |
| 119 | Dialysis-artifact | specific | `Nonbiological-artifact/Dialysis-artifact` |
| 120 | Rocking-patting-artifact | specific | `Biological-artifact/Rocking-patting-artifact` |
| 121 | Sucking-artifact | specific | `Biological-artifact/Sucking-artifact` |
| 130 | Data-artifact | group | `(top of the artifact hierarchy)` |
| 131 | Biological-artifact | group | `Biological-artifact` |
| 132 | Eye-artifact | group | `Biological-artifact/Eye-artifact` |
| 133 | Eye-movement-artifact | group | `Biological-artifact/Eye-artifact/Eye-movement-artifact` |
| 134 | Nonbiological-artifact | group | `Nonbiological-artifact` |
| 135 | Electrical-artifact | group | `Nonbiological-artifact/Electrical-artifact` |
| 136 | Localized-channel-artifact | group | `Nonbiological-artifact/Localized-channel-artifact` |

Notes for the research team:

* Codes 100 to 115 are unchanged from ElectroClean's first catalogue (1.0.0),
  so annotations made with it can still be analysed with newer ones.
* Line-noise-artifact may carry a frequency in HED (for example
  `sc:Line-noise-artifact/50 Hz`); ElectroClean writes the plain term. Line
  noise is largely hidden by the notch filter, so annotators will rarely see it
  unless they switch the notch off.
* Version 2.2.0 places Induction-artifact and Line-noise-artifact under
  `Electrical-artifact`, and Electrode-pops and Salt-bridge under
  `Localized-channel-artifact`. The label strings, which are what ElectroClean
  stores, are the same as in versions 2.0.0 and 2.1.0.
* In HED strings the library prefix is written `sc:`, for example
  `sc:Eye-blink-artifact`; ElectroClean writes these tags into each events
  sidecar.

The check is reproducible with `python scripts/validate_hed_labels.py`, which
downloads the schema (or reads a local copy with `--xml`) and writes
`electroclean/config/hed_score_2.2.0_validation.json`. The test-suite checks
the catalogue against that snapshot offline.
