import { renderItems, readScores, show, postJson } from './srbai.js';

const form = document.getElementById('activation');
const submit = document.getElementById('submit');
const message = document.getElementById('message');
const total = document.getElementById('total');

function updateTotal() {
  total.textContent = `${readScores().reduce((sum, value) => sum + value, 0)} of 28`;
}

renderItems(document.getElementById('items'), updateTotal);
updateTotal();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // Guard against the double tap. Without it a slow network produces two
  // activations, the second of which reports the code as already used.
  if (submit.disabled) return;

  if (!document.getElementById('behaviourRecorded').checked) {
    show(message, 'Write the behaviour on page 1 of your ledger first, then tick the box.', 'error');
    return;
  }
  if (!document.getElementById('consent').checked) {
    show(message, 'Tick the consent box before starting.', 'error');
    return;
  }

  submit.disabled = true;
  show(message, 'Starting the protocol.', 'info');

  const { ok, data } = await postJson('/api/activate', {
    code: document.getElementById('code').value,
    phone: document.getElementById('phone').value,
    behaviourRecorded: true,
    scores: readScores(),
    consent: true,
  });

  if (!ok) {
    show(message, data.error, 'error');
    submit.disabled = false;
    return;
  }

  form.hidden = true;
  const smsLine = data.smsDelivered
    ? 'A confirmation text is on its way.'
    : 'We could not send the confirmation text. Your protocol is running. Contact us if the first audit link does not arrive.';
  show(
    message,
    `Protocol running. Day 0 automaticity: ${data.baseline} of 28. `
      + `Your first weekly audit link arrives Sunday at 18:00. ${smsLine} `
      + 'Write your Day 0 score on page 21 of the ledger, next to the behaviour on page 1.',
    'ok',
  );
});
