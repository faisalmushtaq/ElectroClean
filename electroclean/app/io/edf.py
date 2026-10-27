"""Reading the header of an EDF, EDF+ or BDF file, and checking its size.

MNE-Python reads the signals. This module only reads the fixed-layout header
(Kemp et al., 1992; Kemp and Olivan, 2003) so that ElectroClean can check,
before opening a recording, that the file holds exactly the data records its
header announces. MNE silently infers the number of records from the file
size when the two disagree, which would hide a truncated copy.

Header layout: a 256-byte block (version, patient and recording fields, start
date and time, header size, a 44-byte reserved field that holds ``EDF+C`` or
``EDF+D`` for EDF+, the number of data records, the record duration and the
number of signals), followed by 256 bytes per signal (label, transducer,
physical dimension, physical and digital ranges, prefiltering, samples per
record and a reserved field). Samples are 16-bit integers in EDF and 24-bit
integers in BDF.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

EDF_ANNOTATION_LABELS = ("EDF Annotations", "BDF Annotations")


class EdfHeaderError(ValueError):
    """The header cannot be parsed."""


@dataclass(frozen=True)
class EdfHeader:
    file_type: str  # "EDF", "EDF+C", "EDF+D", "BDF", "BDF+C" or "BDF+D"
    header_bytes: int
    n_records: int  # -1 when the header says the number is unknown
    record_duration_s: float
    labels: tuple[str, ...]
    samples_per_record: tuple[int, ...]
    bytes_per_sample: int

    @property
    def is_bdf(self) -> bool:
        return self.file_type.startswith("BDF")

    @property
    def is_discontinuous(self) -> bool:
        return self.file_type.endswith("+D")

    @property
    def record_bytes(self) -> int:
        return sum(self.samples_per_record) * self.bytes_per_sample

    @property
    def signal_labels(self) -> tuple[str, ...]:
        """Labels of the signals, without the EDF+/BDF+ annotation signal."""
        return tuple(lab for lab in self.labels if lab not in EDF_ANNOTATION_LABELS)

    def size_problems(self, file_size: int) -> tuple[list[str], list[str]]:
        """Compare the file size with the header: (fatal problems, warnings)."""
        fatal: list[str] = []
        notes: list[str] = []
        data_bytes = file_size - self.header_bytes
        if self.record_bytes <= 0:
            fatal.append("the header gives no samples per data record")
            return fatal, notes
        if data_bytes <= 0:
            fatal.append("the file contains a header but no data")
            return fatal, notes
        whole, rest = divmod(data_bytes, self.record_bytes)
        if self.n_records == -1:
            notes.append(
                f"the header does not give the number of data records (the recording may not have been stopped "
                f"properly); {whole} complete record(s) were found"
            )
            if rest:
                notes.append(f"the last {rest} byte(s) do not form a complete data record and are ignored")
            if whole == 0:
                fatal.append("the file does not contain a single complete data record")
            return fatal, notes
        if whole < self.n_records:
            fatal.append(
                f"the header announces {self.n_records} data record(s) of {self.record_duration_s:g} s but the file "
                f"holds only {whole}" + (" and part of another" if rest else "")
                + ", so it is probably truncated (for example an interrupted copy)"
            )
        elif whole > self.n_records or rest:
            fatal.append(
                f"the file is {data_bytes - self.n_records * self.record_bytes} byte(s) longer than the "
                f"{self.n_records} data record(s) its header announces, so header and data disagree"
            )
        return fatal, notes


def _field(block: bytes, start: int, length: int) -> str:
    return block[start : start + length].decode("latin-1").strip()


def read_edf_header(path: Path | str) -> EdfHeader:
    """Parse the fixed part of an EDF/EDF+/BDF header."""
    p = Path(path)
    with open(p, "rb") as fh:
        main = fh.read(256)
        if len(main) < 256:
            raise EdfHeaderError(f"{p.name} is too short to hold an EDF header ({len(main)} bytes)")
        is_bdf = main[:1] == b"\xff"
        version = main[1:8].decode("latin-1").strip() if is_bdf else _field(main, 0, 8)
        if is_bdf and version != "BIOSEMI":
            raise EdfHeaderError(f"{p.name} does not start with a BDF identification code")
        if not is_bdf and version != "0":
            raise EdfHeaderError(f"{p.name} does not start with the EDF version code '0'")
        try:
            header_bytes = int(_field(main, 184, 8))
            n_records = int(_field(main, 236, 8))
            record_duration = float(_field(main, 244, 8))
            n_signals = int(_field(main, 252, 4))
        except ValueError as exc:
            raise EdfHeaderError(f"{p.name} has an unreadable header field: {exc}") from exc
        if n_signals < 1 or header_bytes != 256 * (n_signals + 1):
            raise EdfHeaderError(
                f"{p.name}: header size {header_bytes} does not match {n_signals} signal(s)"
            )
        signals = fh.read(256 * n_signals)
        if len(signals) < 256 * n_signals:
            raise EdfHeaderError(f"{p.name}: the signal headers are incomplete")
    reserved = _field(main, 192, 44)
    family = "BDF" if is_bdf else "EDF"
    file_type = family
    for kind in ("+C", "+D"):
        if reserved.startswith(("EDF" + kind, "BDF" + kind)):
            file_type = family + kind
    labels = tuple(_field(signals, i * 16, 16) for i in range(n_signals))
    offset = n_signals * (16 + 80 + 8 + 8 + 8 + 8 + 8 + 80)
    try:
        samples = tuple(int(_field(signals, offset + i * 8, 8)) for i in range(n_signals))
    except ValueError as exc:
        raise EdfHeaderError(f"{p.name}: unreadable number of samples per record: {exc}") from exc
    return EdfHeader(
        file_type=file_type,
        header_bytes=header_bytes,
        n_records=n_records,
        record_duration_s=record_duration,
        labels=labels,
        samples_per_record=samples,
        bytes_per_sample=3 if is_bdf else 2,
    )
