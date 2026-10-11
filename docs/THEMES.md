# Themes

A theme sets how the crew of agents looks and talks: the crew's name, a name and
a picture for each member, the lines shown while they work, the app's title, an
accent colour and the page colours. It changes only names, pictures and colours. The pipeline, the prompts and what
the agents do stay the same.

Pick one in **Settings → How should the factory look?**, or set `THEME` in
`.env` (an env value pins the choice and locks the question).

## The crew

Every theme has five members, one per **slot**:

| Slot | Does | Classic | The Hive |
| --- | --- | --- | --- |
| `orchestrator` | Hands work from member to member, holds the check-ins, delivers | Coordinator | The Queen |
| `planner` | Plans the change | Planner | Scout |
| `implementer` | Writes the code | Implementer | Builder |
| `tester` | Tests it | Tester | Guard |
| `reviewer` | Reviews it | Reviewer | Inspector |

Where they show up:

- **Job page**: the crew stage above the steps. The orchestrator stands in the
  middle and the four members around it. Whoever has the work is lit, larger and
  animated; the rest are still. When work changes hands, the theme's glyph flies
  from the orchestrator to the member. A caption below says what is happening.
- **Working on now** (Jobs page): a small strip of the five on each running job,
  with a line such as "Builder is writing code".
- **Step names**: "Scout · Plan", "Builder · Build" and so on.
- **Settings**: the five pictures, and the theme picker.

With no pictures, members show the first letter of their name. A theme with no
pictures at all shows a single line instead of the stage. Classic never does:
it has built-in placeholder pictures, so a new install shows the full stage.

If the browser asks for reduced motion, nothing moves. Only the lit member's
ring shows who has the work.

## Built-in themes

- **classic** (default): neutral names, and lines that say plainly what each
  member is doing ("Reading the ticket", "Running the tests"). The app is called
  "Agentic Software Factory". Dracula colours: dark background (`#282a36`),
  light text (`#f8f8f2`) and a purple accent (`#bd93f9`).
- **hive**: the crew is The Hive. The Queen hands the work from bee to bee.
  The app is called "The Hive Mind". Gold accent, warm dark background with
  cream text, 🍯 handoff glyph, and a faint honeycomb in the top-right corner.

Classic ships with **placeholder pictures**: a simple icon in a circle for each
member, served from `/themes/classic/`. Settings shows them as "Built-in
placeholder". A picture you upload replaces the placeholder. The Hive ships
**without pictures**. Upload your own for any theme, built-in or
custom (see below). Built-in names and lines can't be edited. To change them,
download the starter theme, give it a new `id`, and upload it as your own theme.

## Pictures

In **Settings → Crew pictures**, use **Upload pictures…** with a zip of one or
more pictures (only the pictures inside are replaced), or **Remove** one. Pictures belong to a theme, so switching themes switches pictures.

- PNG, JPEG, GIF or WebP, up to `AVATAR_MAX_MB` (default 5 MB) each. One upload
  can carry five pictures' worth (25 MB by default), so a full set fits.
- Square works best. They are shown round, at about 96 px on the job page and
  20 px in Working on now. Pixel art stays crisp (`image-rendering: pixelated`).
- Name each picture after its member: `orchestrator.gif`, `planner.png`, …
  `queen.<ext>` also counts as `orchestrator`.

### A picture per state

A member can have a picture for each state it shows in. Add the state to the
name:

| Name | Shown |
| --- | --- |
| `planner-idle.webp` | before its step starts (and if it is skipped or the job stops first) |
| `planner-working.webp` | while it has the work, including when it is asking you something |
| `planner-done.webp` | once its step is finished |
| `planner.png` | the plain picture: any state without its own |

For the coordinator (`orchestrator`, or `queen`), *working* is while it hands
work over, holds a check-in, sorts out a conflict or delivers. *Done* is once
the job is delivered. *Idle* is the rest of the time.

A member can have all four, some of them, or one plain picture. If it has
neither a picture for the state nor a plain one, it shows another of its
pictures.

How they show:

- **A member with only a plain picture** works as before. The animation plays
  only while it has the work, a finished member is greyed and a member that
  hasn't started is faded.
- **A member with state pictures** shows its state in the picture itself, so it
  isn't greyed or faded. On the job page each one's animation plays, so you see
  the whole crew moving. In Working on now only the one with the work moves.
- State pictures are shown whole (not cropped to the circle) on white, so
  pictures drawn on a white background fit as they are.
- With *reduce motion* on, nobody moves.

In Settings each member with state pictures shows them under its main one.
Remove one with its ×, or all of a member's pictures with **Remove all**.

### Page decoration

A theme can have one picture for the page itself: `decor.png` (or `.jpg`,
`.gif`, `.webp`) in a pictures zip or a theme pack. It has no states.

- It replaces the theme's `decor` pattern (the Hive's honeycomb), and shows
  even for a theme without one.
- It sits in the same place: faint, in the page's top-right corner, about
  260 px wide (140 px on a phone), fading out toward the page. It never takes
  a click and is hidden from screen readers.

In Settings it is the **Page decoration** row under the crew, with a preview
and **Remove**. Remove it and the pattern (if any) comes back.

## Theme packs

A custom theme is a zip:

```
my-theme.zip
├── theme.json        required for a new theme
├── orchestrator.gif  optional, a plain picture per member
├── planner.png
├── implementer.png
├── tester.png
├── reviewer.png
├── queen-idle.webp   optional, a picture per state (see above)
├── queen-working.webp
├── queen-done.webp
└── decor.png         optional, the page decoration (see above)
```

**Download a starter theme** (Settings → Crew pictures) gives you a working
`theme.json` to edit. Upload the zip with **Add a theme…**. Uploading again with the same `id` replaces
the manifest and keeps any pictures you don't include.

### `theme.json`

```json
{
  "id": "space",
  "name": "Mission Control",
  "description": "A launch crew.",
  "crew": { "name": "Mission Control" },
  "members": {
    "orchestrator": { "name": "Flight" },
    "planner": { "name": "Navigator" },
    "implementer": { "name": "Engineer" },
    "tester": { "name": "Test Pilot" },
    "reviewer": { "name": "Inspector" }
  },
  "quips": {
    "planner": ["Plotting the course", "Checking the star charts"],
    "implementer": ["Bolting the stages together"]
  },
  "moods": {
    "handoff": ["{orchestrator} hands {ticket} to {member}"],
    "gate": ["{orchestrator} is waiting for your go"],
    "delivered": ["Splashdown! {crew} delivered"]
  },
  "accent": "#3b82f6",
  "handoffGlyph": "🚀",
  "appTitle": "Mission Control",
  "background": "#0b1020",
  "text": "#e8ecf6"
}
```

| Field | Rules |
| --- | --- |
| `id` | 2–32 lower-case letters, digits or dashes. Can't be `classic` or `hive`. |
| `name`, `crew.name`, `members.*.name` | Up to 40 characters. All five members required. |
| `description` | Optional, up to 200 characters. |
| `quips.<slot>` | Optional. 1–12 lines of up to 120 characters, shown while that member works. |
| `moods.<mood>` | Optional. 1–8 lines of up to 120 characters for the caption. |
| `accent` | Optional hex colour, `#rrggbb`. |
| `handoffGlyph` | Optional emoji or symbol, up to 8 characters. |
| `appTitle` | Optional. The product name in the sidebar and browser tab, up to 40 characters. Without one, "Agentic Software Factory". |
| `background`, `text` | Optional hex colours, `#rrggbb`, for the page. Panels and borders are mixed from them. A missing one is the app's own (`#0f1115` / `#e6e8ec`). Text on background must contrast at least 4.5:1, or the theme is refused. |
| `decor` | Optional. A built-in pattern drawn faintly in the page's top-right corner, in the accent colour. Only `honeycomb` for now; anything else is refused. A `decor.png` picture, if the theme has one, shows in its place (see Page decoration). |

A slot or mood you leave out uses the classic lines.

**Moods**: `handoff`, `working`, `gate` (waiting on a check-in), `question` (a
member asked you something), `conflict` (merge conflict), `delivering`,
`delivered`, `failed`, `idle`.

**Placeholders** in quips and mood lines: `{orchestrator}`, `{member}`, `{crew}`,
`{ticket}`. Anything else in braces is shown as written.

### Safety

A theme is plain text and pictures. Every string is rendered as text, never as
HTML, and the only styles a theme sets are its accent, background and text
colours (hex only). So an
uploaded theme can't inject markup, scripts or CSS. Unknown fields are refused.
Each picture's bytes must match its type. Pictures are served from the
factory's own origin.

## API

Reading needs no special rights. Changes are recorded against the signed-in
person.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/theme` | The active theme: manifest, `images` (one picture per member), `stateImages` (every picture, by member and state) and `decorImage` (the page decoration, or `null`) |
| `PUT` | `/api/theme` | `{ "id": "hive" }` switches the active theme |
| `GET` | `/api/themes` | Every theme, for the picker |
| `GET` | `/api/themes/template.zip` | The starter pack |
| `POST` | `/api/themes` | `{ "zipBase64": "…" }` adds or replaces a custom theme |
| `DELETE` | `/api/themes/:id` | Removes a custom theme and its pictures |
| `POST` | `/api/themes/:id/images` | `{ "zipBase64": "…" }` adds or replaces pictures (any theme) |
| `GET` | `/api/themes/:id/images/:slot?v=…` | The plain picture (cached for good; `v` changes on replace) |
| `GET` | `/api/themes/:id/images/:slot/:state?v=…` | The member's `idle`, `working` or `done` picture |
| `DELETE` | `/api/themes/:id/images/:slot/:state` | Removes one state picture |
| `DELETE` | `/api/themes/:id/images/:slot` | Removes every picture the member has |
| `GET` | `/api/themes/:id/images/decor?v=…` | The page decoration picture |
| `DELETE` | `/api/themes/:id/images/decor` | Removes the page decoration picture |

If `THEME` names a theme that doesn't exist, classic is served and
`GET /api/theme` returns the requested id in `requested`, so the page can show it.

## Upgrading

Migration `018_theme` copies any per-role avatars uploaded before themes
existed onto the **classic** theme, so they stay where they were.

Migration `019_theme_image_state` adds the state. Every existing picture
becomes the member's plain picture, so it shows where it did.
