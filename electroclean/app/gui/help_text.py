"""Short instructions shown in the annotation window's Help panel."""

from __future__ import annotations

import platform

_MAC = platform.system() == "Darwin"
_HOME_END = "fn+← / fn+→" if _MAC else "Home / End"
_PAGE = "fn+↑ / fn+↓" if _MAC else "Page Up / Page Down"
_CTRL = "⌘" if _MAC else "Ctrl"
#: How to undo, as shown in status messages.
UNDO_HINT = f"{_CTRL}+Z to undo"
#: The reminder of the annotating keys, shown at the bottom of the annotation window.
KEY_HINT = "Drag to mark  ·  1–9 type  ·  M start, M end  ·  / find a type  ·  N / P next, previous  ·  ? help"

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
<li>Choose the <b>type</b>: press a number key <b>1</b> to <b>9</b>, click one of the
numbered buttons after <i>Draw as</i>, or choose from the menu next to them. Press
<b>/</b> to find any type by typing part of its name or its code (for example
<i>blink</i> or <i>103</i>) and Enter.</li>
<li>Choose whether it affects the <b>whole montage</b> or only <b>selected channels</b>
(the switch after <i>Applies to</i>, or the key <b>C</b>). For selected channels,
click channel names or traces to select them (they turn magenta), or use
<b>Channels…</b>.</li>
<li><b>Drag</b> across the EEG from the start to the end of the artifact. Or, with the
keyboard, point at the start and press <b>M</b>, then point at the end and press
<b>M</b> again; you can scroll in between, which is the easy way to mark an artifact
longer than the screen. <b>[</b> and <b>]</b> mark the start and the end
separately, and <b>Esc</b> cancels a started mark.</li>
</ol>
<p>You can also draw first and choose the type afterwards: click the new
annotation and press a number, or double-click it to choose any type.</p>

<h3>Changing an annotation</h3>
<ul>
<li><b>Click</b> it to select it (or pick it in the Annotations list). While annotations
are selected the toolbar reads <i>Change to</i>: a number key, a type button or the
menu changes their type. <b>Esc</b>, a click on empty EEG or a new drag ends the
selection, and the toolbar reads <i>Draw as</i> again.</li>
<li><b>Double-click</b> it to choose its new type from the searchable list, or
<b>right-click</b> it for the common types and more options (edit channels, delete).</li>
<li><b>N</b> and <b>P</b> select the next and previous annotation and bring it into view.</li>
<li><b>Drag an edge</b> to resize; <b>Shift+drag</b> the middle to move it.</li>
<li><b>Shift+click</b> a channel inside an annotation to add or remove that channel.</li>
<li><b>Delete</b> (or Backspace) removes the selected annotation; <b>{_CTRL}+Z</b> undoes and
<b>{_CTRL}+Y</b> (or {_CTRL}+Shift+Z) redoes.</li>
<li>Overlapping annotations of the same type on the same channels are merged
automatically. To merge others of one type, select them in the list and press
<b>Merge</b>.</li>
</ul>

<h3>Keys for annotating</h3>
<table cellspacing="2">
<tr><td><b>1</b> to <b>9</b></td><td>type of the next annotation, or of the selected ones</td></tr>
<tr><td><b>/</b></td><td>find any type by name or code</td></tr>
<tr><td><b>M</b></td><td>mark the start, then the end, at the pointer</td></tr>
<tr><td><b>[</b> / <b>]</b></td><td>mark the start / the end at the pointer</td></tr>
<tr><td><b>C</b></td><td>whole montage or selected channels</td></tr>
<tr><td><b>N</b> / <b>P</b></td><td>next / previous annotation</td></tr>
<tr><td><b>Esc</b></td><td>cancel a started mark, or end the selection</td></tr>
<tr><td><b>Delete</b></td><td>delete the selected annotation</td></tr>
<tr><td><b>{_CTRL}+Z</b> / <b>{_CTRL}+Y</b></td><td>undo / redo</td></tr>
</table>

<h3>Finishing</h3>
<p>Press <b>Save and Finish</b> when you have reviewed the whole recording. If you
close the window without saving, your annotations for this recording are
discarded and it stays incomplete.</p>
"""
