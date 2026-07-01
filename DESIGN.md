# VideoGen Design Contract

VideoGen is a dense local video workflow app, not a marketing site. The first screen after a project opens should help the user add footage, inspect clip readiness, choose music, and generate through a required review checkpoint.

## Workflow

- Generation is a two-step action: Generate video creates a plan, then Review and complete confirms planned parts before render.
- If all planned parts are already reviewed, the review page shows All planned parts reviewed and the final music-length check.
- If approved video duration is shorter than selected music, keep the reviewed state and show a persistent dashboard recovery banner until the user changes clip selection, music, or music repeat.
- Manual clip selection always overrides AI rejection. Keep the AI rejected label, but explain that it is a recommendation and the user can select it as a false red flag.
- Lucky selection stays conservative and should avoid AI-rejected clips unless the user manually selects them.

## Layout

- The dashboard uses three functional zones: footage source, clip workspace, and create sidebar.
- Cards should be compact and scannable. Do not nest cards inside cards.
- The dense grid mode uses a symbolic density icon, not a literal number. It may show four cards per row only when each card has enough width for text and controls.
- At narrower desktop widths, dense grid falls back to two cards per row. At mobile widths, all clip views become one column.

## Copy

- Use direct English UI copy only.
- Avoid hidden workflow language. The create sidebar should say the next checkpoint is review before render.
- Keep status copy action-oriented: saved, approved duration, music target, shortfall, and next action.

## Accessibility

- Interactive clip cards must have visible focus states.
- Checkbox hit targets should be at least 44px.
- Text in clip cards, toolbar buttons, and review panels must truncate or wrap predictably without overlapping controls.
- Close buttons and icon buttons must be visible in both dark and light themes.
