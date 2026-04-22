const canvas = document.getElementById("bezierCanvas");
const ctx = canvas.getContext("2d");
const orderInput = document.getElementById("orderInput");
const bgImageInput = document.getElementById("bgImageInput");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const resetViewButton = document.getElementById("resetViewButton");
const CURVE_SAMPLE_COUNT = 250;
const MIDPOINT_T = 0.5;

const state = {
  order: Number(orderInput.value),
  points: [],
  drag: {
    type: null,
    pointIndex: -1,
    pointerId: null,
    lastPosition: null,
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
  const count = order + 1;
  const spacing = canvas.width / (count + 1);
  return Array.from({ length: count }, (_, i) => ({
    x: spacing * (i + 1),
    y: canvas.height * (0.28 + (i % 2) * 0.44),
  }));
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

// Returns the two de Casteljau level-(degree-1) points at t=0.5 for degree >= 4.
// These are P_{0,d-1} (left) and P_{1,d-1} (right), which together define the
// tangent direction and position at the curve midpoint.
// For degree 3 (cubic) this is intentionally omitted: the existing orange handles P1 and P2
// already give direct control over the full curve, so extra de Casteljau handles would
// be redundant and confusing. Returns null for degree < 4.
function getDeCasteljauTangentHandles() {
  const d = state.points.length - 1;
  if (d < 4) return null;
  const scale = Math.pow(2, d - 1);
  let lx = 0, ly = 0, rx = 0, ry = 0;
  for (let k = 0; k < d; k += 1) {
    const c = binomial(d - 1, k);
    lx += c * state.points[k].x;
    ly += c * state.points[k].y;
    rx += c * state.points[k + 1].x;
    ry += c * state.points[k + 1].y;
  }
  return {
    left: { x: lx / scale, y: ly / scale },
    right: { x: rx / scale, y: ry / scale },
  };
}

// Given a dragged position for the left (isLeft=true) or right (isLeft=false) de Casteljau
// tangent handle, back-solves for the middle control point and updates state.points.
// Left handle → solves for P_{floor(d/2)}; right handle → solves for P_{ceil(d/2)}.
function solveMiddleControlFromHandle(isLeft, handlePos) {
  const points = state.points;
  const d = points.length - 1;
  const scale = Math.pow(2, d - 1);
  const m = isLeft ? Math.floor(d / 2) : Math.ceil(d / 2);
  let sumX = 0, sumY = 0, coeffM;
  if (isLeft) {
    // P_{0,d-1} = (1/scale) * sum_{k=0}^{d-1} C(d-1,k) * P_k
    coeffM = binomial(d - 1, m);
    for (let k = 0; k < d; k += 1) {
      if (k === m) continue;
      const c = binomial(d - 1, k);
      sumX += c * points[k].x;
      sumY += c * points[k].y;
    }
  } else {
    // P_{1,d-1} = (1/scale) * sum_{k=0}^{d-1} C(d-1,k) * P_{k+1}
    // Coefficient of P_m is C(d-1, m-1)
    coeffM = binomial(d - 1, m - 1);
    for (let k = 0; k < d; k += 1) {
      if (k === m - 1) continue;
      const c = binomial(d - 1, k);
      sumX += c * points[k + 1].x;
      sumY += c * points[k + 1].y;
    }
  }
  // coeffM is always positive for d >= 4 (binomial coefficient in the interior of Pascal's triangle).
  if (coeffM === 0) return;
  points[m] = {
    x: (scale * handlePos.x - sumX) / coeffM,
    y: (scale * handlePos.y - sumY) / coeffM,
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
}

function setCurveOrder(order) {
  state.order = clamp(order, 1, 8);
  orderInput.value = String(state.order);
  state.points = createDefaultPoints(state.order);
  draw();
}

function getViewportCenter() {
  const rect = canvas.getBoundingClientRect();
  return { x: rect.width / 2, y: rect.height / 2 };
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
    const midpoint = evaluateBezier(state.points, MIDPOINT_T);
    ctx.beginPath();
    ctx.arc(midpoint.x, midpoint.y, 6 / state.zoom, 0, Math.PI * 2);
    ctx.fillStyle = "#ffec9a";
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = "#5a4a0a";
    ctx.stroke();
  }
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
        beginDrag("mid-tangent-handle", event, { pointIndex: 0 });
        return;
      }
      if (Math.hypot(handles.right.x - position.x, handles.right.y - position.y) <= hitRadius) {
        beginDrag("mid-tangent-handle", event, { pointIndex: 1 });
        return;
      }
    }

    const midpoint = evaluateBezier(state.points, MIDPOINT_T);
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
    solveMiddleControlFromHandle(state.drag.pointIndex === 0, position);
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
