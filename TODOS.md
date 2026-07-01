# TODOs

## Design Debt

- [x] Add a concise `DESIGN.md` for VideoGen's app UI rules.
  - What: Document the design contract for dense local video workflow UI, status copy, AI override language, density controls, close buttons, and responsive card behavior.
  - Why: Prevent visual and copy drift from returning after the current generation-review workflow fixes.
  - Pros: High leverage, small file, useful for future design reviews and implementation.
  - Cons: Adds one docs artifact to maintain.
  - Context: The 2026-07-01 plan design review found no existing `DESIGN.md`; several issues came from design rules living only in scattered JSX/CSS.
  - Depends on / blocked by: None.

- [x] Make the generation checkpoint explicit in the app UI.
  - What: Update dashboard, create-sidebar, and review copy so users understand that Generate video first creates a plan, then enters a required Review and complete checkpoint before render.
  - Why: Prevent the workflow from feeling broken when a user clicks Generate and lands in review instead of immediately getting an export.
  - Pros: Reduces confusion around empty review queues, already-reviewed clips, add-more recovery, and music-length warnings.
  - Cons: Requires a small copy and UI consistency pass across several locations.
  - Context: The 2026-07-01 plan design review approved making generation review a named required checkpoint and previewing that checkpoint before the user clicks Generate.
  - Depends on / blocked by: None.
