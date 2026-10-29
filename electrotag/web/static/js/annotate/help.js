// The Help tab of the annotation view: the desktop application's help, with the browser's keys.

import { IS_MAC, CTRL } from '../util.js';
import { docsUrl } from '../ui/docs.js';

// The arrow keys are drawn icons (app.css), since the typeface has no arrows.
const ARROW_NAMES = { left: 'Left arrow', right: 'Right arrow', up: 'Up arrow', down: 'Down arrow' };
const arrow = (dir) => `<kbd aria-label="${ARROW_NAMES[dir]}"><span class="ico ico-arrow-${dir}" aria-hidden="true"></span></kbd>`;
const HOME_END = IS_MAC ? `<kbd>fn</kbd>+${arrow('left')} / <kbd>fn</kbd>+${arrow('right')}` : '<kbd>Home</kbd> / <kbd>End</kbd>';
const PAGE = IS_MAC ? `<kbd>fn</kbd>+${arrow('up')} / <kbd>fn</kbd>+${arrow('down')}` : '<kbd>Page Up</kbd> / <kbd>Page Down</kbd>';

export const KEY_HINT = 'Drag to mark  ·  1–9 type  ·  M start, M end  ·  D, 1–5 confidence  ·  N / P next, previous  ·  B pause  ·  ? help';
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
<li><b>Press and hold</b> an annotation for its menu (the common types, Other type, Edit times…,
Edit channels…, Confidence, Add a note…, Apply to whole montage, Delete), and <b>double-tap</b> it
to choose its type from the list. With a channel-specific annotation selected, tap a channel's name
to add that channel to it or take it out. The numbers 1 to 5 under the Annotations list rate the selected annotation with one
tap.</li>
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
<tr><td>Click empty EEG</td><td>place the time cursor, which shows the exact time (with Selected channels, a click on a trace also chooses its channel)</td></tr>
<tr><td><kbd>,</kbd> / <kbd>.</kbd></td><td>move the time cursor back / forward a little (Shift: ten times as far)</td></tr>
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
(<kbd>O</kbd>). Show all is for finding your way: the parts it shows do not count as viewed. On a long
recording the EEG is drawn as it is read, with how much has been read so far shown over it.</p>
<p>When the rows are too short for every channel's name, every second or third channel is named;
point at a row to see its name, or show fewer channels (${PAGE}).</p>
<p>On the overview bar, the parts of the recording that have not been on the screen yet are white
with a thin grey line above them; the Recording tab and the status line say how much you have viewed.</p>
<p>Vertical dashed lines labelled in teal are the <b>original experimental events</b>.
They cannot be edited. Hatched grey zones mark where the display filters may
distort the signal (recording edges and discontinuities) and where the recording has no data;
<b>Show filter edge zones</b>, in the Recording tab, hides or shows them.</p>

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
<li><b>Drag</b> across the EEG from the start to the end of the artifact; a drag that starts
inside another annotation draws a new one too. Or, with the keyboard, point at the start and press
<kbd>M</kbd>, then point at the end and press <kbd>M</kbd> again; you can scroll in between, which
is the easy way to mark an artifact longer than the screen, and a note at the foot of the EEG shows
the mark waiting for its end. <kbd>[</kbd> and <kbd>]</kbd> mark the start and the end separately,
and <kbd>Esc</kbd> cancels a started mark. Without a mouse, these keys mark at the time cursor:
place it with <kbd>G</kbd> and move it with <kbd>,</kbd> and <kbd>.</kbd>.</li>
</ol>
<p>You can also draw first and choose the type afterwards: click the new
annotation and press a number, or double-click it to choose any type.</p>
<p><b>Draw/edit</b>, at the top, is on while you annotate. Press it to switch to view only, in
which nothing can be drawn or changed by accident (the toolbar then reads <i>View only</i>); press
it again to mark artifacts.</p>

<h3>Changing an annotation</h3>
<ul>
<li><b>Click</b> it to select it (or pick it in the Annotations list). While annotations
are selected the toolbar reads <i>Change to</i>: a number key, a type button or the
menu changes their type. <kbd>Esc</kbd>, a click on empty EEG or a new drag ends the
selection, and the toolbar reads <i>Draw as</i> again.</li>
<li><b>Double-click</b> it to choose its new type from the searchable list, or
<b>right-click</b> it for its menu: the common types, Other type, Edit times…, Edit channels…,
Confidence, Add a note…, Apply to whole montage (for a channel-specific annotation) and Delete.</li>
<li><kbd>N</kbd> and <kbd>P</kbd> select the next and previous annotation and bring it into view;
with nothing selected, <kbd>N</kbd> starts from the first annotation on the screen. After the
last, they come round to the first.</li>
<li><b>Drag an edge</b> to resize; <b>Shift+drag</b> the middle to move it. The line at the bottom
gives the new times.</li>
<li>To change the <b>channels</b> of an annotation, select it, then <b>Shift+click</b> a channel
anywhere within its time to add that channel or take it out; with a channel-specific annotation
selected, a click on a channel's name does the same. Taking a channel out of a whole-montage
annotation leaves every other channel. An annotation keeps at least one channel: to remove the
last, delete the annotation or apply it to the whole montage. <b>Edit channels…</b> chooses them
from a list or the map.</li>
<li><kbd>Delete</kbd> (or Backspace) removes the selected annotation; <kbd>${CTRL}+Z</kbd> undoes and
<kbd>${CTRL}+Y</kbd> (or ${CTRL}+Shift+Z) redoes. Delete, Undo and Redo at the top are greyed
out when there is nothing for them to do.</li>
<li><b>Edit times…</b>, under the Annotations list, takes the start and end as seconds (12.5),
m:ss (1:05.25) or h:mm:ss.</li>
<li>Overlapping annotations of the same type on the same channels are merged
automatically. To merge others of one type, select them in the list and press
<b>Merge</b>.</li>
</ul>

<h3>Confidence and notes</h3>
<p>You can rate how confident you are that a mark is right, from <b>1</b> (not at all confident)
through 2 (slightly), 3 (moderately) and 4 (very) to <b>5</b> (completely confident). Press
<kbd>D</kbd>, then a number from <kbd>1</kbd> to <kbd>5</kbd>: it rates the selected annotation, or
the one you made last; <kbd>0</kbd> clears the rating and <kbd>Esc</kbd> cancels. A bar with the
numbers appears beside the annotation, which is outlined, and after <kbd>D</kbd> the number keys
rate and do not choose a type until you answer. You can also choose <b>Confidence</b> in the
annotation's menu, or tap a number under the Annotations list. A new annotation has no rating. If
your study asks for a rating on every annotation, the bar appears beside each new one and stays
until you answer: press <kbd>D</kbd> and a number, or click a number on the bar; the number keys
alone still choose the type, and <b>Later</b> or <kbd>Esc</kbd> leaves it unrated, which Save and
Finish lists. The tag of a rated annotation shows its rating, such as 3/5, and annotations rated 1
or 2 are drawn more lightly.
<b>Add a note…</b>, in the menu or under the list, keeps a short note with an annotation (up to 200
characters); a small note sign shows which annotations have one. Notes are saved with your
annotations for the study's researchers.</p>

<h3>Keys for annotating</h3>
<table class="keys">
<tr><td><kbd>1</kbd> to <kbd>9</kbd></td><td>type of the next annotation, or of the selected ones</td></tr>
<tr><td><kbd>/</kbd></td><td>find any type by name or code</td></tr>
<tr><td><kbd>M</kbd></td><td>mark the start, then the end, at the pointer (or the time cursor)</td></tr>
<tr><td><kbd>[</kbd> / <kbd>]</kbd></td><td>mark the start / the end at the pointer (or the time cursor)</td></tr>
<tr><td><kbd>,</kbd> / <kbd>.</kbd></td><td>move the time cursor</td></tr>
<tr><td><kbd>C</kbd></td><td>whole montage or selected channels</td></tr>
<tr><td><kbd>D</kbd>, then <kbd>1</kbd> to <kbd>5</kbd></td><td>rate your confidence in the selected (or newest) annotation; <kbd>0</kbd> clears it</td></tr>
<tr><td><kbd>N</kbd> / <kbd>P</kbd></td><td>next / previous annotation</td></tr>
<tr><td><kbd>Esc</kbd></td><td>cancel a started mark, or end the selection</td></tr>
<tr><td><kbd>Delete</kbd></td><td>delete the selected annotation</td></tr>
<tr><td><kbd>${CTRL}+Z</kbd> / <kbd>${CTRL}+Y</kbd></td><td>undo / redo</td></tr>
<tr><td><kbd>B</kbd></td><td>pause, and resume</td></tr>
<tr><td><kbd>U</kbd></td><td>the next part not yet viewed</td></tr>
<tr><td><kbd>G</kbd></td><td>go to a time</td></tr>
<tr><td><kbd>V</kbd> / <kbd>O</kbd> / <kbd>I</kbd></td><td>value under the pointer / overlay / one channel alone</td></tr>
<tr><td><kbd>H</kbd></td><td>in guided training: Show me</td></tr>
<tr><td><kbd>?</kbd></td><td>this help</td></tr>
</table>

<h3>Pausing and breaks</h3>
<p>Press <b>Pause</b> (or <kbd>B</kbd>) when you step away: the clock that measures your time on the
recording stops, your draft is kept, and a panel covers the EEG until you press <b>Resume</b>.
Nothing can be changed while you are paused.
ElectroTag also pauses by itself after a few minutes without any input, and when the page is out
of sight for more than a few seconds (another tab or app, or a locked iPad). After a long stretch of
work it offers a break, which you can take or put off for 15 minutes.</p>

<h3>Finishing</h3>
<p>Press <b>Save and Finish</b> when you have reviewed the whole recording; if some parts have
not been on the screen, it lists them first and offers to take you to them. Your work is kept as a
draft while you annotate (in this browser and with the study, as the time at the top says), so if
you close the page you can continue later, where you left off; the recording is complete only once
it is saved with Save and Finish. When the study cannot be reached, the top reads <i>Draft kept in
this browser only</i> until the connection returns and the draft reaches the study again.</p>
`;

/** The last paragraph of the Help tab: where the annotators' guide is read (it opens in a new tab). */
export const GUIDE_HTML = `
<p class="guide-link">The <a href="${docsUrl('web/using.md')}" target="_blank" rel="noopener">annotators' guide</a>
(it opens in a new tab) describes every part of ElectroTag in more detail.</p>
`;

/** The help's section for the training programme (guided and practice recordings), first in their Help tab. */
export const TRAINING_HELP_HTML = `
<h3>Training</h3>
<p>In <b>Learn with the experts</b> the coach above shows the experts' annotations one at a time and
says how to mark each one: choose its type (a number key, or the numbered buttons next to Draw as),
choose its channels (<b>Whole montage</b>, or <b>Selected channels</b> and a click on each channel
name at the left of the EEG), then drag across the EEG. It checks your work after every change and
says what to put right. Press <b>Continue</b> (<kbd>Enter</kbd> or <kbd>Space</kbd>) when it
matches, or <b>Show me</b> (<kbd>H</kbd>) to have the experts' annotation placed for you. When the
coach holds more than it shows, <b>More below</b> under it scrolls on.</p>
<p><b>Stars</b> show how you are getting on: three for an artifact matched at the first try, two
within three tries, and one after more tries or with Show me. They are there to show your
progress; passing depends on the practice score below.</p>
<p>In <b>On your own</b> you annotate a practice recording without help. After Save and Finish your
<b>score</b> compares your annotations with the experts': it is highest when you find every artifact
they marked, with the right type, and make no marks they did not make, and each missed artifact,
extra mark or wrong type lowers it. To pass, the score and the share of the artifacts you found that
have the right type must each reach the pass mark, which the review states. The review labels your
annotations <i>You</i> and the experts' <i>Experts</i>, marks each difference on the EEG
(<i>Missed</i>, <i>Extra</i>, <i>Should be …</i>) and lists it under What to look at, where
<kbd>N</kbd> and <kbd>P</kbd> step through them. If you do not pass, your training path offers a
practice recording again: another one when there are several, so that you do not repeat answers you
have just seen.</p>
`;

/** The Help tab: on a touch screen the touch section comes first, elsewhere just before Finishing; in
 *  training, the training section comes first of all. */
export function helpHtml(touch, { training = false } = {}) {
  const html = touch ? TOUCH_HELP_HTML + HELP_HTML : HELP_HTML.replace('<h3>Finishing</h3>', `${TOUCH_HELP_HTML}<h3>Finishing</h3>`);
  return (training ? TRAINING_HELP_HTML + html : html) + GUIDE_HTML;
}
