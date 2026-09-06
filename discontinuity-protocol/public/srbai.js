/**
 * Shared front-end helpers.
 *
 * The four items are the SRBAI (Gardner, Abraham, Lally & de Bruijn, 2012).
 * They are written out in full on both pages. The draft abbreviated them on the
 * weekly page ("Done automatically?") while the baseline page used the full
 * wording, so the baseline and the weekly readings were not answers to the same
 * questions and the trend line compared two different measures.
 */
export const ITEMS = [
  'Doing it is something I do automatically.',
  'Doing it is something I do without having to consciously remember.',
  'Doing it is something I start doing before I realise I am doing it.',
  'Doing it is something I would find it hard not to do.',
];

/** Build the four sliders. Every node is created, never injected as markup. */
export function renderItems(container, onChange) {
  ITEMS.forEach((text, index) => {
    const number = index + 1;
    const wrapper = document.createElement('div');
    wrapper.className = 'item';

    const prompt = document.createElement('p');
    prompt.id = `label${number}`;
    prompt.textContent = `${number}. ${text}`;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `q${number}`;
    slider.min = '1';
    slider.max = '7';
    slider.step = '1';
    slider.value = '4';
    slider.setAttribute('aria-labelledby', `label${number}`);
    slider.setAttribute('aria-valuetext', '4 of 7');

    const scale = document.createElement('div');
    scale.className = 'scale';
    const low = document.createElement('span');
    low.textContent = '1 strongly disagree';
    const value = document.createElement('output');
    value.id = `v${number}`;
    value.htmlFor = `q${number}`;
    value.textContent = '4';
    const high = document.createElement('span');
    high.textContent = '7 strongly agree';
    scale.append(low, value, high);

    slider.addEventListener('input', () => {
      value.textContent = slider.value;
      slider.setAttribute('aria-valuetext', `${slider.value} of 7`);
      onChange();
    });

    wrapper.append(prompt, slider, scale);
    container.append(wrapper);
  });
}

export function readScores() {
  return [1, 2, 3, 4].map((n) => Number.parseInt(document.getElementById(`q${n}`).value, 10));
}

export function show(element, text, kind) {
  element.textContent = text;
  element.className = `message ${kind}`;
}

/**
 * One place that talks to the API. Any non-JSON or unexpected response becomes a
 * plain sentence rather than an unhandled rejection and a form that looks frozen.
 */
export async function postJson(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, data: { error: 'No connection. Check your signal and try again.' } };
  }
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok && !data.error) data.error = 'Something went wrong. Try again shortly.';
  return { ok: response.ok, status: response.status, data };
}
