// The Help tab of the annotation view: the desktop application's help, with the browser's keys.

import { IS_MAC, CTRL } from '../util.js';

// The arrow keys are drawn icons (app.css), since the typeface has no arrows.
const ARROW_NAMES = { left: 'Left arrow', right: 'Right arrow', up: 'Up arrow', down: 'Down arrow' };
const arrow = (dir) => `<kbd aria-label="${ARROW_NAMES[dir]}"><span class="ico ico-arrow-${dir}" aria-hidden="true"></span></kbd>`;
const HOME_END = IS_MAC ? `<kbd>fn</kbd>+${arrow('left')} / <kbd>fn</kbd>+${arrow('right')}` : '<kbd>Home</kbd> / <kbd>End</kbd>';
const PAGE = IS_MAC ? `<kbd>fn</kbd>+${arrow('up')} / <kbd>fn</kbd>+${arrow('down')}` : '<kbd>Page Up</kbd> / <kbd>Page Down</kbd>';

export const KEY_HINT = 'Drag to mark  ·  1–9 type  ·  M start, M end  ·  D confidence  ·  N / P next, previous  ·  B pause  ·  ? help';
export const REVIEW_HINT = 'N / P  next, previous item to look at  ·  arrow keys scroll  ·  ? help';
/** The same hints for a touch screen (an iPad without a keyboard). */
export const TOUCH_HINT = 'Drag to mark  ·  tap a numbered type  ·  two fingers move, pinch for more or less time  ·  press and hold an annotation for its menu';
export const TOUCH_REVIEW_HINT = 'Tap an item in What to look at  ·  two fingers move, pinch for more or less time';
export const TOUCH_VIEW_HINT = 'Two fingers move, pinch for more or less time';

/** The help's section for a touch screen. */
export const TOUCH_HELP_HTML = `
<h3>On a touch screen (an iPad)</h3>
<ul>
<li><b>One finger</b> (or the Pencil) works as the mouse does: drag across the EEG to mark an
artifact, tap an annotation to select it, drag its edge to resize it, and tap a channel's name or
trace to choose that channel.</li>
<li><b>Two fingers</b> move the EEG: sideways through time and up and down through the channels.
<b>Pinch</b> sideways to show more or less time.</li>
<li><b>Press and hold</b> an annotation for its menu (the common types, Edit times…, Edit
channels…, Set confidence…, Add a note…, Delete), and <b>double-tap</b> it to choose its type from
the list. The Confidence button under the Annotations list gives the selected annotation the next
level with one tap.</li>
<li>The buttons under the EEG move through time and the channels and change how much is shown,
as the keys do on a computer, and one shows the next part not yet viewed. The <b>View</b> buttons
switch the overlay on and off, show one channel alone (with buttons for the previous and next
channel), open <b>Go to time</b> and <b>Show all</b>. Pause, at the top, stops the clock. A keyboard
attached to the iPad works as on a computer.</li>
<li>In <b>Channels…</b>, <b>Map</b> shows the electrodes on the head: tap one to choose it, drag
with the Pencil to choose several in a box, and drag with a finger to move a large map.</li>
</ul>
`;

export const HELP_HTML = `
<h3>Moving around the recording</h3>
<table class="keys">
<tr><td>${arrow('left')} / ${arrow('right')}</td><td>scroll back / forward (Shift: a whole page)</td></tr>
<tr><td>${arrow('up')} / ${arrow('down')}</td><td>scroll up / down through channels (Shift: a whole page)</td></tr>
<tr><td>${HOME_END}</td><td>show less / more time</td></tr>
<tr><td>${PAGE}</td><td>show fewer / more channels</td></tr>
<tr><td><kbd>−</kbd> / <kbd>+</kbd></td><td>decrease / increase amplitude</td></tr>
<tr><td>Wheel or trackpad</td><td>scroll through time (Shift+wheel: through the channels)</td></tr>
<tr><td>Click empty EEG</td><td>place a time cursor showing the exact time</td></tr>
<tr><td>Overview bar</td><td>(bottom) shows where you are; click it to jump</td></tr>
<tr><td><kbd>U</kbd></td><td>the next part not yet viewed</td></tr>
<tr><td><kbd>G</kbd></td><td>go to a time: type seconds (12.5), m:ss or h:mm:ss and Enter; the time comes to the middle of the screen</td></tr>
<tr><td><kbd>Shift</kbd>+${IS_MAC ? `<kbd>fn</kbd>+${arrow('right')}` : '<kbd>End</kbd>'}</td><td>show all of the recording, as an overview; again to go back</td></tr>
<tr><td><kbd>V</kbd></td><td>the channel, time and value under the pointer, in the line at the bottom</td></tr>
<tr><td><kbd>O</kbd></td><td>overlay: the channels on screen on one shared axis</td></tr>
<tr><td><kbd>I</kbd></td><td>in the overlay, one channel alone; ${arrow('up')} / ${arrow('down')} go to the previous / next channel</td></tr>
</table>
<p>The <b>overlay</b> draws the channels on screen on one axis in thin lines, so that an artifact
that reaches many channels, such as a blink, stands out as a dark band. Point at a name on the left
to see that channel on top, or click it (or press <kbd>I</kbd>) to see it alone. In the overlay new
marks apply to the whole montage; for channel-specific marks, go back to the normal view
(<kbd>O</kbd>). Show all is for finding your way: the parts it shows do not count as viewed.</p>
<p>On the overview bar, the parts of the recording that have not been on the screen yet are white
with a thin grey line above them; the Recording tab and the status line say how much you have viewed.</p>
<p>Vertical dashed lines labelled in teal are the <b>original experimental events</b>.
They cannot be edited. Hatched grey zones mark where the display filters may
distort the signal (recording edges and discontinuities) and where the recording has no data.</p>

<h3>Marking an artifact</h3>
<ol>
<li>Choose the <b>type</b>: press a number key <kbd>1</kbd> to <kbd>9</kbd>, click one of the
numbered buttons after <i>Draw as</i>, or choose from the menu next to them. Press
<kbd>/</kbd> to find any type by typing part of its name or its code (for example
<i>blink</i> or <i>103</i>) and Enter.</li>
<li>Choose whether it affects the <b>whole montage</b> or only <b>selected channels</b>
(the switch in the toolbar, or the key <kbd>C</kbd>). For selected channels,
click channel names or traces to select them (they turn magenta), or use
<b>Channels…</b>, which lists the channels or, with <b>Map</b>, shows them on the head: click an
electrode to choose it, drag a box to choose several, or move between electrodes with the arrow
keys and choose with Space.</li>
<li><b>Drag</b> across the EEG from the start to the end of the artifact. Or, with the
keyboard, point at the start and press <kbd>M</kbd>, then point at the end and press
<kbd>M</kbd> again; you can scroll in between, which is the easy way to mark an artifact
longer than the screen. <kbd>[</kbd> and <kbd>]</kbd> mark the start and the end
separately, and <kbd>Esc</kbd> cancels a started mark.</li>
</ol>
<p>You can also draw first and choose the type afterwards: click the new
annotation and press a number, or double-click it to choose any type.</p>

<h3>Changing an annotation</h3>
<ul>
<li><b>Click</b> it to select it (or pick it in the Annotations list). While annotations
are selected the toolbar reads <i>Change to</i>: a number key, a type button or the
menu changes their type. <kbd>Esc</kbd>, a click on empty EEG or a new drag ends the
selection, and the toolbar reads <i>Draw as</i> again.</li>
<li><b>Double-click</b> it to choose its new type from the searchable list, or
<b>right-click</b> it for the common types and more options (edit channels, delete).</li>
<li><kbd>N</kbd> and <kbd>P</kbd> select the next and previous annotation and bring it into view.</li>
<li><b>Drag an edge</b> to resize; <b>Shift+drag</b> the middle to move it.</li>
<li><b>Shift+click</b> a channel inside an annotation to add or remove that channel.</li>
<li><kbd>Delete</kbd> (or Backspace) removes the selected annotation; <kbd>${CTRL}+Z</kbd> undoes and
<kbd>${CTRL}+Y</kbd> (or ${CTRL}+Shift+Z) redoes.</li>
<li>Overlapping annotations of the same type on the same channels are merged
automatically. To merge others of one type, select them in the list and press
<b>Merge</b>.</li>
</ul>

<h3>Confidence and notes</h3>
<p>When you are unsure of a mark, say how sure you are: press <kbd>D</kbd> to give the selected
annotation (or the one you made last) the next level of <b>confidence</b>, <i>definite</i>,
<i>probable</i> or <i>possible</i>, or use <b>Set confidence…</b> in its menu or the
<b>Confidence</b> button under the Annotations list. A new mark has no confidence until you give
one, unless your study starts every mark as definite. Probable and possible marks are drawn more
lightly. <b>Add a note…</b>, in the menu or under the list, keeps a short note with an annotation
(up to 200 characters); a small note sign shows which annotations have one. Notes are saved with
your annotations for the study's researchers.</p>

<h3>Keys for annotating</h3>
<table class="keys">
<tr><td><kbd>1</kbd> to <kbd>9</kbd></td><td>type of the next annotation, or of the selected ones</td></tr>
<tr><td><kbd>/</kbd></td><td>find any type by name or code</td></tr>
<tr><td><kbd>M</kbd></td><td>mark the start, then the end, at the pointer</td></tr>
<tr><td><kbd>[</kbd> / <kbd>]</kbd></td><td>mark the start / the end at the pointer</td></tr>
<tr><td><kbd>C</kbd></td><td>whole montage or selected channels</td></tr>
<tr><td><kbd>D</kbd></td><td>confidence of the selected (or newest) annotation: the next level</td></tr>
<tr><td><kbd>N</kbd> / <kbd>P</kbd></td><td>next / previous annotation</td></tr>
<tr><td><kbd>Esc</kbd></td><td>cancel a started mark, or end the selection</td></tr>
<tr><td><kbd>Delete</kbd></td><td>delete the selected annotation</td></tr>
<tr><td><kbd>${CTRL}+Z</kbd> / <kbd>${CTRL}+Y</kbd></td><td>undo / redo</td></tr>
<tr><td><kbd>B</kbd></td><td>pause, and resume</td></tr>
<tr><td><kbd>U</kbd></td><td>the next part not yet viewed</td></tr>
<tr><td><kbd>G</kbd></td><td>go to a time</td></tr>
<tr><td><kbd>V</kbd> / <kbd>O</kbd> / <kbd>I</kbd></td><td>value under the pointer / overlay / one channel alone</td></tr>
<tr><td><kbd>?</kbd></td><td>this help</td></tr>
</table>

<h3>Pausing and breaks</h3>
<p>Press <b>Pause</b> (or <kbd>B</kbd>) when you step away: the clock that measures your time on the
recording stops, your draft is kept, and a panel covers the EEG until you press <b>Resume</b>.
ElectroTag also pauses by itself after a few minutes without any input, and when the page is out
of sight for more than a few seconds (another tab or app, or a locked iPad). After a long stretch of
work it offers a break, which you can take or put off for 15 minutes.</p>

<h3>Finishing</h3>
<p>Press <b>Save and Finish</b> when you have reviewed the whole recording; if some parts have
not been on the screen, it lists them first and offers to take you to them. Your work is kept as a
draft while you annotate (in this browser and with the study, as the time at the top says), so if
you close the page you can continue later, where you left off; the recording is complete only once
it is saved with Save and Finish.</p>
`;

/** The Help tab: on a touch screen the touch section comes first, elsewhere just before Finishing. */
export function helpHtml(touch) {
  return touch ? TOUCH_HELP_HTML + HELP_HTML : HELP_HTML.replace('<h3>Finishing</h3>', `${TOUCH_HELP_HTML}<h3>Finishing</h3>`);
}
