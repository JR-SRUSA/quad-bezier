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
3. Show only three visible handles: the start endpoint, the end endpoint, and one on-curve handle at the midpoint of the curve (degree ≥ 2 only). Allow direct drag manipulation of all visible handles.
4. Display tangent guides at the start and end of the curve. When degree ≥ 2, also display a tangent guide at the on-curve midpoint handle.
5. Allow dragging of tangent guides to reposition their corresponding curve-shaping control points.
7. Allow uploading a background image and render it on the same canvas coordinate space.
8. Support zoom in/out where image and curve scale together.

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
  - Three draggable handles: start endpoint, end endpoint, on-curve midpoint (degree ≥ 2)
  - Tangent guides at start/end (always) and midpoint (degree ≥ 2), all draggable
  - Bezier curve
