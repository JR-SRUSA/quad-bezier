# Bezier Editor Spec (v0.1)

## Goal

Provide a lightweight HTML/CSS/JS web app that lets users draw and edit a Bezier curve using visible control points, including tangent visualization, with optional background image support and shared zoom behavior.

## Terminology

In this project UI/spec, **curve order** is intentionally used as an alias for **Bezier degree**.  
Formal math texts may define "order" differently, but this app uses:
- order 4 = degree 4 = 5 control points

## Functional Requirements

1. Render a default 4th-order (degree 4) Bezier curve on a canvas.
2. Allow curve order customization; control points count is `order + 1`.
3. Show control points and allow direct manipulation by dragging.
4. Display tangent guides at the start and end of the curve.
5. Allow uploading a background image and render it on the same canvas coordinate space.
6. Support zoom in/out where image and curve scale together.

## Non-Functional Requirements

- Keep implementation lightweight with standard web platform APIs.
- No required backend services.
- Works as static files opened in a browser.

## Initial UX

- Control panel for:
  - Curve order input
  - Zoom in / zoom out / reset view
  - Background image upload
- Canvas drawing area for:
  - Background image
  - Control polygon
  - Draggable control points
  - Tangent guides
  - Bezier curve
