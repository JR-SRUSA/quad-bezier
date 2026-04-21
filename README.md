# quad-bezier

Lightweight browser app for drawing and editing Bezier curves over a canvas background image.

## Run

Open `index.html` in a browser.

## Features

- Default 4th-order (degree 4) Bezier curve with draggable control points
- Configurable order (degree) for custom control-point count
- Visible handles for start endpoint, end endpoint, and on-curve midpoint (degree ≥ 2) — all draggable
- Tangent guides at start/end (always) and midpoint (degree ≥ 2) — all draggable to reshape the curve
- Background image upload rendered on the same zoomed canvas space as the curve
- Zoom in/out controls (buttons and mouse wheel)

## Spec

See `SPEC.md`.
