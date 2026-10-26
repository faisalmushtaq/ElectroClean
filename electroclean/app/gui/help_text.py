"""Short instructions shown in the annotation window's Help panel."""

from __future__ import annotations

import platform

_MAC = platform.system() == "Darwin"
_HOME_END = "fn+← / fn+→" if _MAC else "Home / End"
_PAGE = "fn+↑ / fn+↓" if _MAC else "Page Up / Page Down"
_CTRL = "⌘" if _MAC else "Ctrl"

HELP_HTML = f"""
<h3>Moving around the recording</h3>
<table cellspacing="2">
<tr><td><b>← / →</b></td><td>scroll back / forward (Shift: a whole page)</td></tr>
<tr><td><b>↑ / ↓</b></td><td>scroll up / down through channels</td></tr>
<tr><td><b>{_HOME_END}</b></td><td>show less / more time</td></tr>
<tr><td><b>{_PAGE}</b></td><td>show fewer / more channels</td></tr>
<tr><td><b>− / +</b></td><td>decrease / increase amplitude</td></tr>
<tr><td><b>Click the plot</b></td><td>place a time cursor showing the exact time</td></tr>
<tr><td><b>x</b></td><td>crosshair showing time and amplitude</td></tr>
<tr><td><b>Overview bar</b></td><td>(bottom) shows where you are; click it to jump</td></tr>
</table>
<p>Vertical lines labelled in teal are the <b>original experimental events</b>.
They cannot be edited. Hatched grey zones mark where the display filters may
distort the signal (recording edges and discontinuities).</p>

<h3>Marking an artifact</h3>
<ol>
<li>Choose the <b>artifact type</b> in the toolbar.</li>
<li>Choose whether it affects the <b>whole montage</b> or only <b>selected channels</b>.
In <i>Selected channels</i> mode, click channel names or traces to select them
(they turn magenta), or use <b>Choose channels…</b>.</li>
<li><b>Drag</b> across the EEG to mark the interval. You can drag over an existing
annotation to add an overlapping one.</li>
</ol>

<h3>Changing an annotation</h3>
<ul>
<li><b>Click</b> it to select it (or pick it in the Annotations list).</li>
<li><b>Drag an edge</b> to resize; <b>Shift+drag</b> the middle to move it.</li>
<li><b>Shift+click</b> a channel inside an annotation to add or remove that channel.</li>
<li><b>Right-click</b> for more options (change label, edit channels, delete).</li>
<li><b>Delete</b> removes the selected annotation; <b>{_CTRL}+Z</b> undoes and
<b>{_CTRL}+Y</b> (or {_CTRL}+Shift+Z) redoes.</li>
<li>Same-type annotations are never merged automatically. To merge, select them
in the list and press <b>Merge</b>.</li>
</ul>

<h3>Finishing</h3>
<p>Press <b>Save and Finish</b> when you have reviewed the whole recording. If you
close the window without saving, your annotations for this recording are
discarded and it stays incomplete.</p>
"""
