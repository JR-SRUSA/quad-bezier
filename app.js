const canvas = document.getElementById("bezierCanvas");
const ctx = canvas.getContext("2d");
const orderInput = document.getElementById("orderInput");
const bgImageInput = document.getElementById("bgImageInput");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const resetViewButton = document.getElementById("resetViewButton");
const CURVE_SAMPLE_COUNT = 250;
const MIDPOINT_T = 0.5;
const MIDPOINT_TANGENT_HALF_LENGTH = 60;

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
  const x = (clientX - rect.left - state.offsetX) / state.zoom;
  const y = (clientY - rect.top - state.offsetY) / state.zoom;
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

function getMidpointCurveData() {
  const point = evaluateBezier(state.points, MIDPOINT_T);
  let tangent = evaluateBezierDerivative(state.points, MIDPOINT_T);
  let tangentLength = Math.hypot(tangent.x, tangent.y);

  if (tangentLength < 0.0001) {
    const low = evaluateBezier(state.points, MIDPOINT_T - 0.01);
    const high = evaluateBezier(state.points, MIDPOINT_T + 0.01);
    tangent = { x: high.x - low.x, y: high.y - low.y };
    tangentLength = Math.hypot(tangent.x, tangent.y);
  }

  if (tangentLength < 0.0001) {
    tangent = { x: 1, y: 0 };
    tangentLength = 1;
  }

  const unit = {
    x: tangent.x / tangentLength,
    y: tangent.y / tangentLength,
  };

  return {
    point,
    tangentStart: {
      x: point.x - unit.x * MIDPOINT_TANGENT_HALF_LENGTH,
      y: point.y - unit.y * MIDPOINT_TANGENT_HALF_LENGTH,
    },
    tangentEnd: {
      x: point.x + unit.x * MIDPOINT_TANGENT_HALF_LENGTH,
      y: point.y + unit.y * MIDPOINT_TANGENT_HALF_LENGTH,
    },
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

  ctx.lineWidth = 1 / state.zoom;
  ctx.strokeStyle = "#8a93a3";
  ctx.beginPath();
  state.points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();

  if (state.points.length > 1) {
    ctx.strokeStyle = "#f39a1e";
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

  const midpointData = getMidpointCurveData();
  ctx.strokeStyle = "#4c8f3b";
  ctx.setLineDash([8 / state.zoom, 6 / state.zoom]);
  ctx.beginPath();
  ctx.moveTo(midpointData.tangentStart.x, midpointData.tangentStart.y);
  ctx.lineTo(midpointData.tangentEnd.x, midpointData.tangentEnd.y);
  ctx.stroke();
  ctx.setLineDash([]);

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

  state.points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7 / state.zoom, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = "#1e1f23";
    ctx.stroke();
  });

  ctx.beginPath();
  ctx.arc(midpointData.point.x, midpointData.point.y, 6 / state.zoom, 0, Math.PI * 2);
  ctx.fillStyle = "#ffec9a";
  ctx.fill();
  ctx.lineWidth = 2 / state.zoom;
  ctx.strokeStyle = "#5a4a0a";
  ctx.stroke();
}

canvas.addEventListener("pointerdown", (event) => {
  const position = toWorldCoordinates(event.clientX, event.clientY);
  const hitRadius = 10 / state.zoom;

  for (let i = state.points.length - 1; i >= 0; i -= 1) {
    const point = state.points[i];
    if (Math.hypot(point.x - position.x, point.y - position.y) <= hitRadius) {
      beginDrag("control-point", event, { pointIndex: i });
      return;
    }
  }

  const midpointData = getMidpointCurveData();
  if (Math.hypot(midpointData.point.x - position.x, midpointData.point.y - position.y) <= hitRadius) {
    beginDrag("middle-control", event);
    return;
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
      return;
    }
  }

  if (
    distancePointToSegment(position, midpointData.tangentStart, midpointData.tangentEnd) <= hitRadius
  ) {
    beginDrag("middle-tangent", event, { lastPosition: position });
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drag.type) {
    return;
  }
  const position = toWorldCoordinates(event.clientX, event.clientY);
  if (state.drag.type === "control-point" && state.drag.pointIndex >= 0) {
    state.points[state.drag.pointIndex] = position;
  } else if (state.drag.type === "middle-control") {
    const targetIndex = getMiddleControlTargetIndex();
    if (targetIndex >= 0) {
      const midpoint = evaluateBezier(state.points, MIDPOINT_T);
      state.points[targetIndex] = {
        x: state.points[targetIndex].x + (position.x - midpoint.x),
        y: state.points[targetIndex].y + (position.y - midpoint.y),
      };
    }
  } else if (state.drag.type === "start-tangent" && state.drag.lastPosition && state.points.length > 1) {
    const deltaX = position.x - state.drag.lastPosition.x;
    const deltaY = position.y - state.drag.lastPosition.y;
    state.points[1] = {
      x: state.points[1].x + deltaX,
      y: state.points[1].y + deltaY,
    };
    state.drag.lastPosition = position;
  } else if (state.drag.type === "end-tangent" && state.drag.lastPosition && state.points.length > 1) {
    const deltaX = position.x - state.drag.lastPosition.x;
    const deltaY = position.y - state.drag.lastPosition.y;
    const controlIndex = state.points.length - 2;
    state.points[controlIndex] = {
      x: state.points[controlIndex].x + deltaX,
      y: state.points[controlIndex].y + deltaY,
    };
    state.drag.lastPosition = position;
  } else if (state.drag.type === "middle-tangent" && state.drag.lastPosition) {
    const targetIndex = getMiddleControlTargetIndex();
    if (targetIndex >= 0) {
      const deltaX = position.x - state.drag.lastPosition.x;
      const deltaY = position.y - state.drag.lastPosition.y;
      state.points[targetIndex] = {
        x: state.points[targetIndex].x + deltaX,
        y: state.points[targetIndex].y + deltaY,
      };
      state.drag.lastPosition = position;
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
