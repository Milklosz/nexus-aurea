# Independent design critique (Opus subagent) and what was done about it

Reviewer: the design subagent (spawned with `model: opus`, effort `high`; the harness does not report
the resolved model version, so "Opus 5.5" is not claimed) re-reviewed the rendered React build from
the screenshots, not the prototype. 12 findings; disposition:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | blocker | Home could show no focused tile (focus state came from DOM focus; cleared on window blur / at mount) | Fixed: focus is the dock's default, only "elsewhere" after a focus event outside the dock; test covers blur/return |
| 2 | blocker | Control Center collapsed at 4K (px-sized dialog vs rem scaling) | Fixed: reference-px sheet; verified at 4K |
| 3 | blocker | Text below 20 reference px in Control Center and search | Fixed with a type floor; verified |
| 4 | major | Opening focus on the ×; × looked primary | Fixed: focus starts on the open tab, × is quiet until focused |
| 5 | major | Selected / pressed / focused indistinguishable in sheets | Fixed: focus = light plate, selected = underline, pressed = check mark (no second ring) |
| 6 | major | Clipped content, narrow Remote card | Fixed: fade mask and padding on panels, full-width cards |
| 7 | major | Modal overlapped the dock and cut the Home title | Fixed: right-hand sheet |
| 8 | major | Generic tells in Control Center / Search (English labels, keyboard legend, status noise, no visible input) | Partly fixed: Polish section names, one hint, visible search field, no type tags / result count. Not done: moving footer actions into a "System" tab, collapsing Remote status tiles |
| 9 | major | All scenes one picture recoloured | Partly fixed: horizon, light position, layer count and terrain frequency vary. Not done: new composition types ("night", "plateau") |
| 10 | major | Half-sun disc and speed lines | Fixed: wide flat horizon glow, broad faint streaks |
| 11 | major | Prime Video sea read as blinds + barcode | Fixed: smooth water plane and soft reflection |
| 12 | minor | Selected tile low contrast | Fixed: selected keeps the idle plate (accents stay ≥ 4.5:1) and gets an underline |

Screenshots after the fixes: `design/screens/`.
