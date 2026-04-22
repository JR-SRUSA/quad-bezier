const canvas = document.getElementById("bezierCanvas");
const ctx = canvas.getContext("2d");
const deriv1Canvas = document.getElementById("deriv1Canvas");
const deriv1Ctx = deriv1Canvas.getContext("2d");
const deriv2Canvas = document.getElementById("deriv2Canvas");
const deriv2Ctx = deriv2Canvas.getContext("2d");
const orderInput = document.getElementById("orderInput");
const bgImageInput = document.getElementById("bgImageInput");
const middleTInput = document.getElementById("middleTInput");
const middleTValue = document.getElementById("middleTValue");
const minRadiusInfo = document.getElementById("minRadiusInfo");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const resetViewButton = document.getElementById("resetViewButton");
const CURVE_SAMPLE_COUNT = 250;
const DEFAULT_MIDDLE_T = 0.5;
const MIN_SPEED_SQ_THRESHOLD = 1e-10;
const MIN_CURVATURE_MAG_THRESHOLD = 1e-7;
const MIN_DETERMINANT_THRESHOLD = 1e-12;

const state = {
  order: Number(orderInput.value),
  points: [],
  middleT: DEFAULT_MIDDLE_T,
  drag: {
    type: null,
    pointIndex: -1,
    pointerId: null,
    lastPosition: null,
    // Snapshot of the yellow midpoint position taken at drag-start for mid-tangent-handle drags.
    // Used by the constrained quintic solve to keep the midpoint fixed while the handle moves.
    startYellow: null,
  },
  zoom: 1,
  minZoom: 0.25,
  maxZoom: 6,
  offsetX: 0,
  offsetY: 0,
  backgroundImage: null,
  backgroundImageObjectURL: null,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toWorldCoordinates(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = ((clientX - rect.left) * scaleX - state.offsetX) / state.zoom;
  const y = ((clientY - rect.top) * scaleY - state.offsetY) / state.zoom;
  return { x, y };
}

function createDefaultPoints(order) {
  const n = order;
  return Array.from({ length: n + 1 }, (_, i) => ({
    x: canvas.width * (0.15 + 0.7 * (i / n)),
    y: canvas.height * (0.2 + 0.6 * 4 * (i / n) * (1 - i / n)),
  }));
}

// Exact degree elevation: returns n+2 control points for a degree-(n+1) curve
// that traces the exact same path as the given n+1 points for degree n.
function elevateDegree(points) {
  const n = points.length - 1;
  const result = new Array(n + 2);
  result[0] = { ...points[0] };
  for (let i = 1; i <= n; i += 1) {
    const alpha = i / (n + 1);
    result[i] = {
      x: alpha * points[i - 1].x + (1 - alpha) * points[i].x,
      y: alpha * points[i - 1].y + (1 - alpha) * points[i].y,
    };
  }
  result[n + 1] = { ...points[n] };
  return result;
}

// Approximate degree reduction: returns n control points for a degree-(n-1) curve
// that best approximates the given n+1 control points for degree n.
// Uses the Forrest left/right blend to preserve both endpoints exactly.
function reduceDegree(points) {
  const n = points.length - 1;
  if (n <= 1) return points.map((p) => ({ ...p }));

  // Left-to-right: enforce Q[0] = P[0], derive the rest forward
  const left = new Array(n);
  left[0] = { ...points[0] };
  for (let k = 1; k < n - 1; k += 1) {
    const alpha = k / n;
    left[k] = {
      x: (points[k].x - alpha * left[k - 1].x) / (1 - alpha),
      y: (points[k].y - alpha * left[k - 1].y) / (1 - alpha),
    };
  }
  left[n - 1] = { ...points[n] };

  // Right-to-left: enforce Q[n-1] = P[n], derive the rest backward
  const right = new Array(n);
  right[n - 1] = { ...points[n] };
  for (let k = n - 1; k > 1; k -= 1) {
    const alpha = k / n;
    right[k - 1] = {
      x: (points[k].x - (1 - alpha) * right[k].x) / alpha,
      y: (points[k].y - (1 - alpha) * right[k].y) / alpha,
    };
  }
  right[0] = { ...points[0] };

  // Blend: linearly interpolate between left and right so both endpoints are exact
  const result = new Array(n);
  result[0] = { ...points[0] };
  result[n - 1] = { ...points[n] };
  for (let i = 1; i < n - 1; i += 1) {
    const lambda = i / (n - 1);
    result[i] = {
      x: (1 - lambda) * left[i].x + lambda * right[i].x,
      y: (1 - lambda) * left[i].y + lambda * right[i].y,
    };
  }
  return result;
}

function evaluateBezier(points, t) {
  const work = points.map((point) => ({ ...point }));
  for (let level = 1; level < work.length; level += 1) {
    for (let i = 0; i < work.length - level; i += 1) {
      work[i] = {
        x: work[i].x * (1 - t) + work[i + 1].x * t,
        y: work[i].y * (1 - t) + work[i + 1].y * t,
      };
    }
  }
  return work[0];
}

function evaluateBezierDerivative(points, t) {
  const degree = points.length - 1;
  if (degree <= 0) {
    return { x: 0, y: 0 };
  }
  const derivativePoints = Array.from({ length: degree }, (_, i) => ({
    x: degree * (points[i + 1].x - points[i].x),
    y: degree * (points[i + 1].y - points[i].y),
  }));
  return evaluateBezier(derivativePoints, t);
}

function evaluateBezierSecondDerivative(points, t) {
  const degree = points.length - 1;
  if (degree <= 1) {
    return { x: 0, y: 0 };
  }
  const d1Points = Array.from({ length: degree }, (_, i) => ({
    x: degree * (points[i + 1].x - points[i].x),
    y: degree * (points[i + 1].y - points[i].y),
  }));
  const deg1 = d1Points.length - 1;
  if (deg1 <= 0) {
    return { x: 0, y: 0 };
  }
  const d2Points = Array.from({ length: deg1 }, (_, i) => ({
    x: deg1 * (d1Points[i + 1].x - d1Points[i].x),
    y: deg1 * (d1Points[i + 1].y - d1Points[i].y),
  }));
  return evaluateBezier(d2Points, t);
}

function bernsteinWeights(degree, t) {
  const oneMinusT = 1 - t;
  return Array.from({ length: degree + 1 }, (_, k) => (
    binomial(degree, k) * Math.pow(oneMinusT, degree - k) * Math.pow(t, k)
  ));
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  // Compute via the multiplicative formula C(n,k) = n*(n-1)*...*(n-k+1) / k!
  // Each step divides an integer product, so intermediate values stay exact integers.
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

// Returns the two de Casteljau level-(degree-1) points at state.middleT for degree >= 4.
// These are P_{0,d-1} (left) and P_{1,d-1} (right), which together define the
// tangent direction and position at the chosen on-curve parameter.
// For degree 3 (cubic) this is intentionally omitted: the existing orange handles P1 and P2
// already give direct control over the full curve, so extra de Casteljau handles would
// be redundant and confusing. Returns null for degree < 4.
function getDeCasteljauTangentHandles() {
  const d = state.points.length - 1;
  if (d < 4) return null;
  const weights = bernsteinWeights(d - 1, state.middleT);
  let lx = 0, ly = 0, rx = 0, ry = 0;
  for (let k = 0; k < d; k += 1) {
    lx += weights[k] * state.points[k].x;
    ly += weights[k] * state.points[k].y;
    rx += weights[k] * state.points[k + 1].x;
    ry += weights[k] * state.points[k + 1].y;
  }
  return {
    left: { x: lx, y: ly },
    right: { x: rx, y: ry },
  };
}

// Given a dragged position for the left (isLeft=true) or right (isLeft=false) de Casteljau
// tangent handle, back-solves for the middle control point and updates state.points.
// Left handle → solves for P_{floor(d/2)}; right handle → solves for P_{ceil(d/2)}.
function solveMiddleControlFromHandle(isLeft, handlePos) {
  const points = state.points;
  const d = points.length - 1;
  const weights = bernsteinWeights(d - 1, state.middleT);
  const m = isLeft ? Math.floor(d / 2) : Math.ceil(d / 2);
  let sumX = 0, sumY = 0, coeffM;
  if (isLeft) {
    // P_{0,d-1}(t) = sum_{k=0}^{d-1} B_{d-1,k}(t) * P_k
    coeffM = weights[m];
    for (let k = 0; k < d; k += 1) {
      if (k === m) continue;
      sumX += weights[k] * points[k].x;
      sumY += weights[k] * points[k].y;
    }
  } else {
    // P_{1,d-1}(t) = sum_{k=0}^{d-1} B_{d-1,k}(t) * P_{k+1}
    coeffM = weights[m - 1];
    for (let k = 0; k < d; k += 1) {
      if (k === m - 1) continue;
      sumX += weights[k] * points[k + 1].x;
      sumY += weights[k] * points[k + 1].y;
    }
  }
  // coeffM is always positive for d >= 4 and 0 < t < 1 (interior Bernstein coefficient).
  if (coeffM === 0) return;
  points[m] = {
    x: (handlePos.x - sumX) / coeffM,
    y: (handlePos.y - sumY) / coeffM,
  };
}

// Constrained solve for quintic (d=5) only.
// Given one dragged handle and the yellow on-curve point that must stay fixed at parameter t,
// computes the opposite handle from yellow = (1-t)*left + t*right, then solves for P[2] and P[3]
// from the resulting two linear equations for P_{0,4}(t) and P_{1,4}(t).
function solveMiddleControlsConstrained(isLeft, handlePos, fixedYellow) {
  const points = state.points;
  const d = points.length - 1;
  if (d !== 5) return;
  const t = state.middleT;
  if (t <= 0 || t >= 1) return;
  const oneMinusT = 1 - t;
  const weights = bernsteinWeights(4, t);
  const newLeft = isLeft
    ? handlePos
    : {
      x: (fixedYellow.x - t * handlePos.x) / oneMinusT,
      y: (fixedYellow.y - t * handlePos.y) / oneMinusT,
    };
  const newRight = isLeft
    ? {
      x: (fixedYellow.x - oneMinusT * handlePos.x) / t,
      y: (fixedYellow.y - oneMinusT * handlePos.y) / t,
    }
    : handlePos;
  const b1x = newLeft.x - (weights[0] * points[0].x + weights[1] * points[1].x + weights[4] * points[4].x);
  const b1y = newLeft.y - (weights[0] * points[0].y + weights[1] * points[1].y + weights[4] * points[4].y);
  const b2x = newRight.x - (weights[0] * points[1].x + weights[3] * points[4].x + weights[4] * points[5].x);
  const b2y = newRight.y - (weights[0] * points[1].y + weights[3] * points[4].y + weights[4] * points[5].y);
  const a11 = weights[2];
  const a12 = weights[3];
  const a21 = weights[1];
  const a22 = weights[2];
  const determinant = a11 * a22 - a12 * a21;
  if (Math.abs(determinant) < MIN_DETERMINANT_THRESHOLD) return;
  points[2] = {
    x: (b1x * a22 - b2x * a12) / determinant,
    y: (b1y * a22 - b2y * a12) / determinant,
  };
  points[3] = {
    x: (a11 * b2x - a21 * b1x) / determinant,
    y: (a11 * b2y - a21 * b1y) / determinant,
  };
}

function distancePointToSegment(point, start, end) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = clamp(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / segmentLengthSquared,
    0,
    1,
  );
  const projected = {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t,
  };
  return Math.hypot(point.x - projected.x, point.y - projected.y);
}

function getMiddleControlTargetIndex() {
  if (state.points.length <= 2) {
    return -1;
  }
  return Math.floor(state.points.length / 2);
}

function beginDrag(type, event, options = {}) {
  state.drag.type = type;
  state.drag.pointIndex = options.pointIndex ?? -1;
  state.drag.pointerId = event.pointerId;
  state.drag.lastPosition = options.lastPosition ?? null;
  state.drag.startYellow = options.startYellow ?? null;
  canvas.setPointerCapture(event.pointerId);
}

function dragControlPointByDelta(pointIndex, position) {
  if (pointIndex < 0 || pointIndex >= state.points.length || !state.drag.lastPosition) {
    return;
  }
  const deltaX = position.x - state.drag.lastPosition.x;
  const deltaY = position.y - state.drag.lastPosition.y;
  state.points[pointIndex] = {
    x: state.points[pointIndex].x + deltaX,
    y: state.points[pointIndex].y + deltaY,
  };
  state.drag.lastPosition = position;
}

function clearDrag(event) {
  if (state.drag.pointerId !== null && event) {
    canvas.releasePointerCapture(event.pointerId);
  }
  state.drag.type = null;
  state.drag.pointIndex = -1;
  state.drag.pointerId = null;
  state.drag.lastPosition = null;
  state.drag.startYellow = null;
}

function setCurveOrder(order) {
  const newOrder = clamp(order, 1, 8);
  orderInput.value = String(newOrder);
  const currentOrder = state.points.length - 1;
  if (state.points.length > 0 && currentOrder !== newOrder) {
    let pts = state.points;
    if (newOrder > currentOrder) {
      for (let d = currentOrder; d < newOrder; d += 1) {
        pts = elevateDegree(pts);
      }
    } else {
      for (let d = currentOrder; d > newOrder; d -= 1) {
        pts = reduceDegree(pts);
      }
    }
    state.points = pts;
  } else if (state.points.length === 0) {
    state.points = createDefaultPoints(newOrder);
  }
  state.order = newOrder;
  draw();
}

function getMiddleTBounds() {
  const minAttr = parseFloat(middleTInput.min);
  const maxAttr = parseFloat(middleTInput.max);
  return {
    min: Number.isFinite(minAttr) ? minAttr : 0.05,
    max: Number.isFinite(maxAttr) ? maxAttr : 0.95,
  };
}

function setMiddleParameter(nextT) {
  const { min, max } = getMiddleTBounds();
  state.middleT = clamp(nextT, min, max);
  middleTInput.value = state.middleT.toFixed(2);
  middleTValue.value = state.middleT.toFixed(2);
  draw();
}

function getViewportCenter() {
  const rect = canvas.getBoundingClientRect();
  return { x: rect.width / 2, y: rect.height / 2 };
}

// Rounds maxAbs up to a "nice" number (1, 2, or 5 times a power of ten) for y-axis scaling.
function niceYMax(maxAbs) {
  if (maxAbs === 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxAbs)));
  const normalized = maxAbs / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function formatAxisValue(v) {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 10000 || abs < 0.01) return v.toExponential(1);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

// Samples tangent angle (degrees) and radius of curvature at CURVE_SAMPLE_COUNT+1 evenly-spaced t values.
// Arc length (chord-length approximation) is accumulated and used as the x-axis for both graphs.
// Returns { samplesAngle, samplesRadius, totalArcLength, minRadiusSample } where each sample is { s, v }.
function buildDerivativeSamples() {
  if (state.points.length < 2) {
    return { samplesAngle: [], samplesRadius: [], totalArcLength: 0, minRadiusSample: null };
  }
  const n = CURVE_SAMPLE_COUNT;
  const samplesAngle = [];
  const samplesRadius = [];
  let minRadiusSample = null;
  let arcLen = 0;
  let prevPoint = evaluateBezier(state.points, 0);
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const point = evaluateBezier(state.points, t);
    if (i > 0) {
      arcLen += Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y);
    }
    prevPoint = point;
    const d1 = evaluateBezierDerivative(state.points, t);
    const d2 = evaluateBezierSecondDerivative(state.points, t);
    const speed2 = d1.x * d1.x + d1.y * d1.y;
    const angle = speed2 < MIN_SPEED_SQ_THRESHOLD ? 0 : Math.atan2(d1.y, d1.x) * (180 / Math.PI);
    const curvature = speed2 < MIN_SPEED_SQ_THRESHOLD ? 0 : (d1.x * d2.y - d1.y * d2.x) / Math.pow(speed2, 1.5);
    const absCurvature = Math.abs(curvature);
    const radius = absCurvature < MIN_CURVATURE_MAG_THRESHOLD
      ? null
      : 1 / absCurvature;
    samplesAngle.push({ s: arcLen, v: angle });
    samplesRadius.push({ s: arcLen, v: radius });
    if (radius !== null && (!minRadiusSample || radius < minRadiusSample.v)) {
      minRadiusSample = { s: arcLen, v: radius, t };
    }
  }
  return { samplesAngle, samplesRadius, totalArcLength: arcLen, minRadiusSample };
}

const DERIV_GRAPH_PADDING = { left: 62, right: 20, top: 30, bottom: 38 };

// Draws a scalar derivative graph (single line) onto a canvas.
// Horizontal axis: arc length (0–100% of total). Vertical axis: auto-scaled to data range.
// samples: array of { s, v } where v is the scalar value at arc-length s.
function drawDerivativeGraph(cvs, dctx, title, lineColor, samples, totalArcLength, options = {}) {
  const centered = options.centered === true;
  const markerLines = options.markerLines ?? [];
  const W = cvs.width;
  const H = cvs.height;
  const { left: PL, right: PR, top: PT, bottom: PB } = DERIV_GRAPH_PADDING;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, W, H);
  dctx.fillStyle = "#ffffff";
  dctx.fillRect(0, 0, W, H);

  if (samples.length === 0 || totalArcLength === 0) return;

  const finiteValueSamples = samples.filter((sample) => Number.isFinite(sample.v));
  if (finiteValueSamples.length === 0) return;

  let yDataMax = 0;
  let yDataMin = Infinity;
  for (const sample of finiteValueSamples) {
    const val = centered ? Math.abs(sample.v) : sample.v;
    yDataMax = Math.max(yDataMax, val);
    if (!centered) yDataMin = Math.min(yDataMin, val);
  }
  // For non-centered (positive-only) data such as radius: cap the display range at a fixed
  // multiple of the minimum value so that tight-bend features appear prominently rather than
  // being compressed at the bottom of the chart. Values above the cap are clipped to the top
  // edge of the plot area by the canvas clipping region.
  const MAX_RADIUS_DISPLAY_MULTIPLE = 4;
  if (!centered && Number.isFinite(yDataMin) && yDataMin > 0) {
    yDataMax = Math.min(yDataMax, yDataMin * MAX_RADIUS_DISPLAY_MULTIPLE);
  }
  const yMax = niceYMax(yDataMax);

  const toPlotX = (s) => PL + (s / totalArcLength) * plotW;
  const toPlotY = centered
    ? (v) => PT + plotH / 2 - (v / yMax) * (plotH / 2)
    : (v) => PT + plotH - (v / yMax) * plotH;

  // Horizontal grid lines and emphasized baseline.
  dctx.lineWidth = 1;
  const gridFracs = centered ? [-1, -0.5, 0.5, 1] : [0.25, 0.5, 0.75, 1];
  for (const frac of gridFracs) {
    dctx.strokeStyle = "#eceef4";
    dctx.beginPath();
    dctx.moveTo(PL, toPlotY(frac * yMax));
    dctx.lineTo(PL + plotW, toPlotY(frac * yMax));
    dctx.stroke();
  }
  dctx.strokeStyle = "#c8ccd8";
  dctx.beginPath();
  const baseY = toPlotY(0);
  dctx.moveTo(PL, baseY);
  dctx.lineTo(PL + plotW, baseY);
  dctx.stroke();

  // Y axis labels
  dctx.fillStyle = "#666b7a";
  dctx.font = "11px Arial";
  dctx.textAlign = "right";
  dctx.textBaseline = "middle";
  const labelFracs = centered ? [-1, -0.5, 0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  for (const frac of labelFracs) {
    dctx.fillText(formatAxisValue(frac * yMax), PL - 5, toPlotY(frac * yMax));
  }

  // X axis tick marks and percentage labels
  const xAxisBottom = PT + plotH;
  dctx.font = "11px Arial";
  dctx.textAlign = "center";
  dctx.textBaseline = "top";
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const x = PL + frac * plotW;
    dctx.strokeStyle = "#c8ccd8";
    dctx.lineWidth = 1;
    dctx.beginPath();
    dctx.moveTo(x, xAxisBottom);
    dctx.lineTo(x, xAxisBottom + 4);
    dctx.stroke();
    dctx.fillStyle = "#666b7a";
    dctx.fillText(`${(frac * 100) | 0}%`, x, xAxisBottom + 5);
  }

  // X axis description
  dctx.fillStyle = "#888fa0";
  dctx.textBaseline = "bottom";
  dctx.fillText("arc length", PL + plotW / 2, H - 2);

  // Plot border
  dctx.strokeStyle = "#b0b5c4";
  dctx.lineWidth = 1;
  dctx.strokeRect(PL, PT, plotW, plotH);

  // Clip line to the plot area
  dctx.save();
  dctx.beginPath();
  dctx.rect(PL, PT, plotW, plotH);
  dctx.clip();

  dctx.lineWidth = 1.5;
  dctx.strokeStyle = lineColor;
  dctx.beginPath();
  let hasSegment = false;
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i].v)) {
      hasSegment = false;
      continue;
    }
    const px = toPlotX(samples[i].s);
    const py = toPlotY(samples[i].v);
    if (!hasSegment) {
      dctx.moveTo(px, py);
      hasSegment = true;
    } else {
      dctx.lineTo(px, py);
    }
  }
  dctx.stroke();

  // Draw vertical marker lines (drawn on top of the data line, clipped to plot area).
  for (const marker of markerLines) {
    const mx = toPlotX(marker.s);
    dctx.strokeStyle = marker.color;
    dctx.lineWidth = 1.5;
    dctx.setLineDash([4, 4]);
    dctx.beginPath();
    dctx.moveTo(mx, PT);
    dctx.lineTo(mx, PT + plotH);
    dctx.stroke();
    dctx.setLineDash([]);
    if (marker.label) {
      dctx.font = "bold 10px Arial";
      dctx.textAlign = "center";
      dctx.textBaseline = "top";
      dctx.fillStyle = marker.color;
      dctx.fillText(marker.label, mx, PT + 2);
    }
  }

  dctx.restore();

  // Title
  dctx.fillStyle = "#1e1f23";
  dctx.font = "bold 12px Arial";
  dctx.textAlign = "left";
  dctx.textBaseline = "top";
  dctx.fillText(title, PL, 7);
}


function setZoom(nextZoom, anchor = getViewportCenter()) {
  const previousZoom = state.zoom;
  const clampedZoom = clamp(nextZoom, state.minZoom, state.maxZoom);
  if (clampedZoom === previousZoom) {
    return;
  }
  state.offsetX = anchor.x - ((anchor.x - state.offsetX) / previousZoom) * clampedZoom;
  state.offsetY = anchor.y - ((anchor.y - state.offsetY) / previousZoom) * clampedZoom;
  state.zoom = clampedZoom;
  draw();
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.setTransform(state.zoom, 0, 0, state.zoom, state.offsetX, state.offsetY);

  if (state.backgroundImage) {
    ctx.drawImage(state.backgroundImage, 0, 0);
  }

  if (state.points.length > 1) {
    ctx.strokeStyle = "#f39a1e";
    ctx.lineWidth = 1 / state.zoom;
    ctx.setLineDash([8 / state.zoom, 6 / state.zoom]);
    ctx.beginPath();
    ctx.moveTo(state.points[0].x, state.points[0].y);
    ctx.lineTo(state.points[1].x, state.points[1].y);
    ctx.moveTo(
      state.points[state.points.length - 1].x,
      state.points[state.points.length - 1].y,
    );
    ctx.lineTo(
      state.points[state.points.length - 2].x,
      state.points[state.points.length - 2].y,
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const showMidHandle = state.points.length > 2;
  const handles = getDeCasteljauTangentHandles();

  if (handles) {
    ctx.strokeStyle = "#4c8f3b";
    ctx.lineWidth = 1 / state.zoom;
    ctx.setLineDash([8 / state.zoom, 6 / state.zoom]);
    ctx.beginPath();
    ctx.moveTo(handles.left.x, handles.left.y);
    ctx.lineTo(handles.right.x, handles.right.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = "#2b63ff";
  ctx.lineWidth = 2 / state.zoom;
  ctx.beginPath();
  for (let i = 0; i <= CURVE_SAMPLE_COUNT; i += 1) {
    const t = i / CURVE_SAMPLE_COUNT;
    const point = evaluateBezier(state.points, t);
    if (i === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.stroke();

  if (state.points.length > 2) {
    const drawTangentTip = (x, y, fillColor) => {
      ctx.beginPath();
      ctx.arc(x, y, 5 / state.zoom, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.lineWidth = 1.5 / state.zoom;
      ctx.strokeStyle = "#1e1f23";
      ctx.stroke();
    };
    drawTangentTip(state.points[1].x, state.points[1].y, "#f39a1e");
    if (state.points.length > 3) {
      drawTangentTip(
        state.points[state.points.length - 2].x,
        state.points[state.points.length - 2].y,
        "#f39a1e",
      );
    }
    if (handles) {
      drawTangentTip(handles.left.x, handles.left.y, "#4c8f3b");
      drawTangentTip(handles.right.x, handles.right.y, "#4c8f3b");
    }
  }

  [state.points[0], state.points[state.points.length - 1]].forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7 / state.zoom, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = "#1e1f23";
    ctx.stroke();
  });

  if (showMidHandle) {
    const midpoint = evaluateBezier(state.points, state.middleT);
    ctx.beginPath();
    ctx.arc(midpoint.x, midpoint.y, 6 / state.zoom, 0, Math.PI * 2);
    ctx.fillStyle = "#ffec9a";
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = "#5a4a0a";
    ctx.stroke();
  }

  const { samplesAngle, samplesRadius, totalArcLength, minRadiusSample } = buildDerivativeSamples();
  if (minRadiusSample && totalArcLength > 0) {
    const lengthFraction = minRadiusSample.s / totalArcLength;
    minRadiusInfo.textContent = `Minimum radius: ${formatAxisValue(minRadiusSample.v)} at arc fraction ${lengthFraction.toFixed(3)}`;
  } else {
    minRadiusInfo.textContent = "Minimum radius: --";
  }

  // Draw a red diamond on the spline at the minimum-radius (tightest-bend) point.
  if (minRadiusSample) {
    const minRpt = evaluateBezier(state.points, minRadiusSample.t);
    const ds = 7 / state.zoom;
    ctx.save();
    ctx.translate(minRpt.x, minRpt.y);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-ds / 2, -ds / 2, ds, ds);
    ctx.fillStyle = "#cc3b2e";
    ctx.fill();
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.strokeStyle = "#1e1f23";
    ctx.stroke();
    ctx.restore();
  }

  // Arc-length position of the current middle-parameter handle, used to draw a marker line on
  // both derivative graphs so the slider's effect is immediately visible.
  const middleTSampleIdx = Math.min(Math.round(state.middleT * CURVE_SAMPLE_COUNT), CURVE_SAMPLE_COUNT);
  const middleTArcLength = samplesAngle[middleTSampleIdx]?.s ?? 0;
  const middleTMarker = { s: middleTArcLength, color: "#b06000", label: "t" };

  drawDerivativeGraph(
    deriv1Canvas, deriv1Ctx,
    "Tangent Angle (\u00b0)",
    "#2b63ff",
    samplesAngle, totalArcLength, { centered: true, markerLines: [middleTMarker] },
  );
  drawDerivativeGraph(
    deriv2Canvas, deriv2Ctx,
    "Radius of Curvature (R)",
    "#4c8f3b",
    samplesRadius, totalArcLength, {
      centered: false,
      markerLines: [
        middleTMarker,
        ...(minRadiusSample ? [{ s: minRadiusSample.s, color: "#cc3b2e", label: "R\u2098\u1d62\u2099" }] : []),
      ],
    },
  );
}

canvas.addEventListener("pointerdown", (event) => {
  const position = toWorldCoordinates(event.clientX, event.clientY);
  const hitRadius = 10 / state.zoom;

  const endpointIndices = [0, state.points.length - 1];
  for (const i of endpointIndices) {
    const point = state.points[i];
    if (Math.hypot(point.x - position.x, point.y - position.y) <= hitRadius) {
      beginDrag("control-point", event, { pointIndex: i });
      return;
    }
  }

  const showMidHandle = state.points.length > 2;

  if (showMidHandle) {
    const handles = getDeCasteljauTangentHandles();
    if (handles) {
      if (Math.hypot(handles.left.x - position.x, handles.left.y - position.y) <= hitRadius) {
        beginDrag("mid-tangent-handle", event, {
          pointIndex: 0,
          startYellow: evaluateBezier(state.points, state.middleT),
        });
        return;
      }
      if (Math.hypot(handles.right.x - position.x, handles.right.y - position.y) <= hitRadius) {
        beginDrag("mid-tangent-handle", event, {
          pointIndex: 1,
          startYellow: evaluateBezier(state.points, state.middleT),
        });
        return;
      }
    }

    const midpoint = evaluateBezier(state.points, state.middleT);
    if (Math.hypot(midpoint.x - position.x, midpoint.y - position.y) <= hitRadius) {
      beginDrag("middle-control", event, { lastPosition: position });
      return;
    }

    if (handles && distancePointToSegment(position, handles.left, handles.right) <= hitRadius) {
      beginDrag("middle-tangent", event, { lastPosition: position });
      return;
    }
  }

  if (state.points.length > 2) {
    if (Math.hypot(state.points[1].x - position.x, state.points[1].y - position.y) <= hitRadius) {
      beginDrag("control-point", event, { pointIndex: 1 });
      return;
    }
    if (
      state.points.length > 3 &&
      Math.hypot(
        state.points[state.points.length - 2].x - position.x,
        state.points[state.points.length - 2].y - position.y,
      ) <= hitRadius
    ) {
      beginDrag("control-point", event, { pointIndex: state.points.length - 2 });
      return;
    }
  }

  if (state.points.length > 1) {
    if (distancePointToSegment(position, state.points[0], state.points[1]) <= hitRadius) {
      beginDrag("start-tangent", event, { lastPosition: position });
      return;
    }

    const lastIndex = state.points.length - 1;
    if (
      distancePointToSegment(position, state.points[lastIndex], state.points[lastIndex - 1]) <=
      hitRadius
    ) {
      beginDrag("end-tangent", event, { lastPosition: position });
    }
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drag.type) {
    return;
  }
  const position = toWorldCoordinates(event.clientX, event.clientY);
  if (state.drag.type === "control-point" && state.drag.pointIndex >= 0) {
    state.points[state.drag.pointIndex] = position;
  } else if (state.drag.type === "middle-control" && state.drag.lastPosition) {
    const targetIndex = getMiddleControlTargetIndex();
    if (targetIndex >= 0) {
      dragControlPointByDelta(targetIndex, position);
    }
  } else if (state.drag.type === "start-tangent" && state.points.length > 1) {
    dragControlPointByDelta(1, position);
  } else if (state.drag.type === "end-tangent" && state.points.length > 1) {
    dragControlPointByDelta(state.points.length - 2, position);
  } else if (state.drag.type === "middle-tangent" && state.drag.lastPosition) {
    const targetIndex = getMiddleControlTargetIndex();
    if (targetIndex >= 0) {
      dragControlPointByDelta(targetIndex, position);
    }
  } else if (state.drag.type === "mid-tangent-handle") {
    const d = state.points.length - 1;
    if (d === 5 && state.drag.startYellow) {
      // For quintic: mirror the opposite handle through the fixed yellow dot so the midpoint
      // stays stationary while the dragged handle rotates or stretches the tangent.
      solveMiddleControlsConstrained(state.drag.pointIndex === 0, position, state.drag.startYellow);
    } else {
      // For other degrees: back-solve for the single middle control point (yellow will move).
      solveMiddleControlFromHandle(state.drag.pointIndex === 0, position);
    }
  }
  draw();
});

canvas.addEventListener("pointerup", (event) => {
  clearDrag(event);
});

canvas.addEventListener("pointercancel", (event) => {
  clearDrag(event);
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect = canvas.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    setZoom(state.zoom * zoomFactor, { x: anchorX, y: anchorY });
  },
  { passive: false },
);

orderInput.addEventListener("change", () => {
  setCurveOrder(Number(orderInput.value));
});
middleTInput.addEventListener("input", () => {
  setMiddleParameter(Number(middleTInput.value));
});

zoomInButton.addEventListener("click", () => setZoom(state.zoom * 1.2));
zoomOutButton.addEventListener("click", () => setZoom(state.zoom / 1.2));
resetViewButton.addEventListener("click", () => {
  state.zoom = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  draw();
});

bgImageInput.addEventListener("change", (event) => {
  if (state.backgroundImageObjectURL) {
    URL.revokeObjectURL(state.backgroundImageObjectURL);
    state.backgroundImageObjectURL = null;
  }

  const [file] = event.target.files;
  if (!file) {
    state.backgroundImage = null;
    draw();
    return;
  }

  const objectURL = URL.createObjectURL(file);
  state.backgroundImageObjectURL = objectURL;
  const image = new Image();
  image.onload = () => {
    if (state.backgroundImageObjectURL !== objectURL) {
      return;
    }
    state.backgroundImage = image;
    draw();
  };
  image.onerror = () => {
    if (state.backgroundImageObjectURL !== objectURL) {
      return;
    }
    console.error("Failed to load background image.");
    URL.revokeObjectURL(objectURL);
    state.backgroundImageObjectURL = null;
    state.backgroundImage = null;
    draw();
  };
  image.src = objectURL;
});

setCurveOrder(state.order);
setMiddleParameter(DEFAULT_MIDDLE_T);
