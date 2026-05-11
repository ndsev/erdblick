# Docstring Ledger

This ledger tracks the production-code slices that were reviewed for prose-first class and
function doc comments. A slice is only marked done once the non-trivial declarations in that
slice were reviewed on the target branch.

## Done
- [x] `app/*.ts`
- [x] `app/auxiliaries`
- [x] `app/coords`
- [x] `app/diagnostics`
- [x] `app/environments`
- [x] `app/integrations`
- [x] `app/inspection`
- [x] `app/mapdata`
- [x] `app/mapview`
- [x] `app/mapview/deck`
- [x] `app/search`
- [x] `app/shared`
- [x] `app/styledata`
- [x] `libs/core/include/erdblick`
- [x] `libs/core/src`

## Outstanding
- [ ] Add a lightweight regression check for newly added undocumented declarations if the team
      decides the maintenance cost is worth it.
- [ ] Revisit tests, generated code, and third-party integration shims only if we decide they
      should follow the same doc-comment standard.
