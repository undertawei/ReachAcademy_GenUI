import Matter from 'matter-js';

import {
  color,
  fillTarget,
  frozenController,
  registerScienceKit,
} from './science-kit-runtime.shared';

registerScienceKit('mechanics-matter', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const worldSpec = spec.world as {
    width: number;
    height: number;
    gravity: { x: number; y: number };
  };
  const engine = Matter.Engine.create({
    gravity: { x: worldSpec.gravity.x, y: worldSpec.gravity.y },
  });
  const createBodies = () =>
    (spec.bodies as Array<Record<string, unknown>>).map((body) => {
      const position = body.position as { x: number; y: number };
      const shape = String(body.shape);
      const options: Matter.IBodyDefinition = {
        angle: Number(body.angle),
        isStatic: Boolean(body.isStatic),
        friction: Number(body.friction),
        restitution: Number(body.restitution),
        render: { fillStyle: color(body.colorToken) },
      };
      const created =
        shape === 'circle'
          ? Matter.Bodies.circle(position.x, position.y, Number(body.radius), options)
          : Matter.Bodies.rectangle(
              position.x,
              position.y,
              Number(body.width),
              Number(body.height),
              options,
            );
      created.label = String(body.id);
      if (!created.isStatic && body.mass !== null) Matter.Body.setMass(created, Number(body.mass));
      const velocity = body.velocity as { x: number; y: number };
      Matter.Body.setVelocity(created, velocity);
      Matter.Body.setAngularVelocity(created, Number(body.angularVelocity));
      return created;
    });
  const createConstraints = (bodyMap: Map<string, Matter.Body>) =>
    (spec.constraints as Array<Record<string, unknown>>).map((constraint) => {
      const anchorA = constraint.anchorA as { x: number; y: number };
      const anchorB = constraint.anchorB as { x: number; y: number };
      const created = Matter.Constraint.create({
        bodyA: constraint.bodyA === null ? undefined : bodyMap.get(String(constraint.bodyA)),
        bodyB: constraint.bodyB === null ? undefined : bodyMap.get(String(constraint.bodyB)),
        pointA: anchorA,
        pointB: anchorB,
        length: Number(constraint.length),
        stiffness: Number(constraint.stiffness),
        damping: Number(constraint.damping),
        render: { strokeStyle: '#64748b', lineWidth: 2 },
      });
      created.label = String(constraint.id);
      return created;
    });
  let bodies = createBodies();
  let bodyMap = new Map(bodies.map((body) => [body.label, body]));
  let constraints = createConstraints(bodyMap);
  Matter.Composite.add(engine.world, [...bodies, ...constraints]);
  const render = Matter.Render.create({
    element: target,
    engine,
    options: {
      width: Math.min(1200, worldSpec.width),
      height: Math.min(720, worldSpec.height),
      wireframes: false,
      background: '#f8fafc',
    },
  });
  Object.assign(target.style, {
    alignItems: 'center',
    display: 'flex',
    justifyContent: 'center',
    overflow: 'hidden',
  });
  const fitCanvas = () => {
    const scale = Math.min(
      target.clientWidth / render.options.width!,
      target.clientHeight / render.options.height!,
    );
    render.canvas.style.width = `${render.options.width! * scale}px`;
    render.canvas.style.height = `${render.options.height! * scale}px`;
  };
  const resizeObserver = new ResizeObserver(fitCanvas);
  resizeObserver.observe(target);
  fitCanvas();
  const mouse = Matter.Mouse.create(render.canvas);
  const mouseConstraint = Matter.MouseConstraint.create(engine, {
    mouse,
    constraint: { stiffness: 0.2, render: { visible: false } },
  });
  Matter.Composite.add(engine.world, mouseConstraint);
  const controls = document.createElement('div');
  Object.assign(controls.style, {
    position: 'absolute',
    inset: '8px auto auto 8px',
    display: 'grid',
    gap: '6px',
    padding: '8px',
    background: 'rgb(255 255 255 / .9)',
    font: '14px system-ui',
    maxWidth: '220px',
  });
  const parameterInputs = new Map<string, HTMLInputElement>();
  const applyParameter = (
    parameter: Record<string, unknown>,
    input: HTMLInputElement,
    emit: boolean,
  ) => {
    const value = Number(input.value);
    const targetSpec = parameter.target as { kind: string; targetId?: string };
    const body = targetSpec.targetId ? bodyMap.get(targetSpec.targetId) : undefined;
    const constraint = targetSpec.targetId
      ? constraints.find((candidate) => candidate.label === targetSpec.targetId)
      : undefined;
    if (targetSpec.kind === 'gravity-x') engine.gravity.x = value;
    else if (targetSpec.kind === 'gravity-y') engine.gravity.y = value;
    else if (targetSpec.kind === 'body-mass' && body) Matter.Body.setMass(body, value);
    else if (targetSpec.kind === 'body-velocity-x' && body)
      Matter.Body.setVelocity(body, { x: value, y: body.velocity.y });
    else if (targetSpec.kind === 'body-velocity-y' && body)
      Matter.Body.setVelocity(body, { x: body.velocity.x, y: value });
    else if (targetSpec.kind === 'body-restitution' && body) body.restitution = value;
    else if (targetSpec.kind === 'constraint-stiffness' && constraint) constraint.stiffness = value;
    if (emit)
      target.dispatchEvent(
        new CustomEvent('reach-science-kit-change', {
          detail: { kind: 'parameter', parameterId: parameter.id, value },
        }),
      );
  };
  for (const parameter of spec.parameters as Array<Record<string, unknown>>) {
    const label = document.createElement('label');
    label.textContent = String(parameter.label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(parameter.minimum);
    input.max = String(parameter.maximum);
    input.step = String(parameter.step);
    input.value = String(parameter.initial);
    input.addEventListener('input', () => applyParameter(parameter, input, true));
    parameterInputs.set(String(parameter.id), input);
    label.append(input);
    controls.append(label);
  }
  if (controls.childElementCount > 0) target.append(controls);
  let frame = 0;
  let last = performance.now();
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    const steps = Math.min(4, Math.max(1, Math.round((now - last) / (1000 / 60))));
    for (let index = 0; index < steps; index += 1) Matter.Engine.update(engine, 1000 / 60);
    Matter.Render.world(render);
    last = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  const reset = () => {
    for (const item of [...bodies, ...constraints]) Matter.Composite.remove(engine.world, item);
    bodies = createBodies();
    bodyMap = new Map(bodies.map((body) => [body.label, body]));
    constraints = createConstraints(bodyMap);
    Matter.Composite.add(engine.world, [...bodies, ...constraints]);
    for (const parameter of spec.parameters as Array<Record<string, unknown>>) {
      const input = parameterInputs.get(String(parameter.id));
      if (!input) continue;
      input.value = String(parameter.initial);
      applyParameter(parameter, input, false);
    }
  };
  Matter.Events.on(mouseConstraint, 'enddrag', (event) => {
    const body = (event as unknown as { body?: Matter.Body }).body;
    if (!body) return;
    target.dispatchEvent(
      new CustomEvent('reach-science-kit-change', {
        detail: {
          kind: 'body-moved',
          bodyId: body.label,
          x: body.position.x,
          y: body.position.y,
          angle: body.angle,
        },
      }),
    );
  });
  return frozenController(
    reset,
    () => {
      stopped = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(frame);
      Matter.Render.stop(render);
      Matter.Engine.clear(engine);
      render.canvas.remove();
      target.replaceChildren();
    },
    () => ({
      gravity: { x: engine.gravity.x, y: engine.gravity.y },
      parameters: [...parameterInputs].map(([id, input]) => ({ id, value: Number(input.value) })),
      bodies: bodies.map((body) => ({
        id: body.label,
        x: body.position.x,
        y: body.position.y,
        angle: body.angle,
        velocityX: body.velocity.x,
        velocityY: body.velocity.y,
        angularVelocity: body.angularVelocity,
      })),
    }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const candidate = state as { gravity?: unknown; parameters?: unknown; bodies?: unknown };
      const gravity = candidate.gravity as { x?: unknown; y?: unknown } | undefined;
      if (!gravity || !Number.isFinite(gravity.x) || !Number.isFinite(gravity.y)) return false;
      if (
        !Array.isArray(candidate.parameters) ||
        candidate.parameters.length !== parameterInputs.size ||
        !Array.isArray(candidate.bodies) ||
        candidate.bodies.length !== bodyMap.size
      )
        return false;
      const restoredParameters = new Map<string, number>();
      for (const item of candidate.parameters) {
        if (typeof item !== 'object' || item === null) return false;
        const value = item as { id?: unknown; value?: unknown };
        if (
          typeof value.id !== 'string' ||
          !parameterInputs.has(value.id) ||
          restoredParameters.has(value.id) ||
          !Number.isFinite(value.value)
        )
          return false;
        restoredParameters.set(value.id, Number(value.value));
      }
      const restoredBodies = new Map<
        string,
        {
          x: number;
          y: number;
          angle: number;
          velocityX: number;
          velocityY: number;
          angularVelocity: number;
        }
      >();
      for (const item of candidate.bodies) {
        if (typeof item !== 'object' || item === null) return false;
        const value = item as Record<string, unknown>;
        if (
          typeof value.id !== 'string' ||
          !bodyMap.has(value.id) ||
          restoredBodies.has(value.id) ||
          !['x', 'y', 'angle', 'velocityX', 'velocityY', 'angularVelocity'].every((key) =>
            Number.isFinite(value[key]),
          )
        )
          return false;
        restoredBodies.set(value.id, {
          x: Number(value.x),
          y: Number(value.y),
          angle: Number(value.angle),
          velocityX: Number(value.velocityX),
          velocityY: Number(value.velocityY),
          angularVelocity: Number(value.angularVelocity),
        });
      }
      engine.gravity.x = Number(gravity.x);
      engine.gravity.y = Number(gravity.y);
      for (const [id, value] of restoredParameters) {
        const input = parameterInputs.get(id)!;
        input.value = String(value);
        const parameter = (spec.parameters as Array<Record<string, unknown>>).find(
          (item) => String(item.id) === id,
        )!;
        applyParameter(parameter, input, false);
      }
      for (const [id, value] of restoredBodies) {
        const body = bodyMap.get(id)!;
        Matter.Body.setPosition(body, { x: value.x, y: value.y });
        Matter.Body.setAngle(body, value.angle);
        Matter.Body.setVelocity(body, { x: value.velocityX, y: value.velocityY });
        Matter.Body.setAngularVelocity(body, value.angularVelocity);
      }
      Matter.Render.world(render);
      return true;
    },
  );
});
