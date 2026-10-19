// Drives Inline Assist the way a person does.
//
// Assist lives in a closed shadow root and ignores events that are not trusted,
// so a script on the page (or a test calling element.click()) cannot reach it.
// This driver talks to it only through the browser's own channels:
//   - elements are found with CDP DOM.getDocument({ depth: -1, pierce: true }),
//     which includes closed shadow roots;
//   - position comes from DOM.getBoxModel, and clicks and typing are sent as
//     trusted Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText;
//   - state is read with Runtime.callFunctionOn on the shadow root object, which
//     is the same read access DevTools has and never dispatches an event.
const HOST_ID = 'hermes-inline-draft-host';

function findHost(node) {
  if (!node || typeof node !== 'object') return null;
  // CDP lists attributes as a flat [name, value, name, value, ...] array.
  const attributes = node.attributes || [];
  for (let index = 0; index < attributes.length - 1; index += 2) {
    if (attributes[index] === 'id' && attributes[index + 1] === HOST_ID) return node;
  }
  for (const child of node.children || []) {
    const found = findHost(child);
    if (found) return found;
  }
  if (node.contentDocument) {
    const found = findHost(node.contentDocument);
    if (found) return found;
  }
  return null;
}

async function shadowRootNode(client) {
  const { root } = await client.call('DOM.getDocument', { depth: -1, pierce: true });
  const host = findHost(root);
  const shadow = host?.shadowRoots?.[0] || null;
  return { host, shadow };
}

export async function assistRootObjectId(client) {
  const { shadow } = await shadowRootNode(client);
  if (!shadow?.backendNodeId) return null;
  const resolved = await client.call('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
  return resolved?.object?.objectId || null;
}

// Evaluates an expression with `__assistRoot` bound to the closed shadow root
// (null when Assist is not mounted). Mirrors client.evaluate().
export async function assistEvaluate(client, expression) {
  const objectId = await assistRootObjectId(client);
  const body = `const __assistRoot = ${objectId ? 'this' : 'null'}; return (${expression});`;
  const result = objectId
    ? await client.call('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { ${body} }`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    : await client.call('Runtime.evaluate', {
      expression: `(() => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Assist evaluation failed.');
  }
  return result.result?.value;
}

async function assistElementCenter(client, selector) {
  const { shadow } = await shadowRootNode(client);
  if (!shadow?.nodeId) throw new Error('Inline Assist is not mounted.');
  const { nodeId } = await client.call('DOM.querySelector', { nodeId: shadow.nodeId, selector });
  if (!nodeId) throw new Error(`Inline Assist has no element matching ${selector}.`);
  await client.call('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
  const { model } = await client.call('DOM.getBoxModel', { nodeId }).catch((error) => {
    throw new Error(`Inline Assist element ${selector} is not showing (${error.message}).`);
  });
  const quad = model.content;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

// Clicks an element inside Assist with trusted pointer input. The tab is
// brought to the front first, as it is for a person clicking it.
export async function assistClick(client, selector) {
  await client.call('Page.bringToFront');
  const point = await assistElementCenter(client, selector);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  return point;
}

// Clicks an element that must be showing; returns false when it is not there or
// hidden so callers can poll.
export async function assistClickWhenVisible(client, selector) {
  const visible = await assistEvaluate(client, `(() => {
    const node = __assistRoot?.querySelector(${JSON.stringify(selector)});
    return Boolean(node && !node.hidden && node.getBoundingClientRect().width > 0);
  })()`);
  if (!visible) return false;
  await assistClick(client, selector);
  return true;
}

// Types text into the focused control with trusted key input.
export async function typeTrusted(client, text) {
  for (const character of String(text)) {
    const upper = character.toUpperCase();
    const code = /[a-z]/i.test(character) ? `Key${upper}` : '';
    const windowsVirtualKeyCode = /[a-z]/i.test(character) ? upper.charCodeAt(0) : character.charCodeAt(0);
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: character, ...(code ? { code } : {}), text: character, unmodifiedText: character, windowsVirtualKeyCode,
    });
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: character, ...(code ? { code } : {}), windowsVirtualKeyCode,
    });
  }
}
