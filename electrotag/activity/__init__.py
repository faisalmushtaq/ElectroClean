"""Analysis of the interaction logs: what annotators did, how long it took, and how that changed.

``logs`` reads the visit logs, ``summary`` turns them into tidy tables (one row per visit and one
per annotator × recording × visit), ``report`` writes a self-contained HTML report with learning
curves, and ``cli`` is the ``electrotag-activity`` command. The file format and every column are
described in docs/activity_logs.md.
"""
