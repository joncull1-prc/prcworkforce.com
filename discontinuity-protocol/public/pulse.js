import { renderItems, readScores, show, postJson } from './srbai.js';

const form = document.getElementById('pulse');
const message = document.getElementById('message');
const behaviourLine = document.getElementById('behaviour');
const heading = document.getElementById('heading');
const eyebrow = document.getElementById('eyebrow');

// The link itself is the credential. It is passed straight back to the API and
// never written into the page, so it cannot leak through the DOM or a screenshot.
const query = window.location.search;

async function start() {
  let response;
  try {
    response = await fetch(`/api/pulse-context${query}`, { headers: { Accept: 'application/json' } });
  } catch {
    show(message, 'No connection. Open the link again when you have signal.', 'error');
    return;
  }

  let context = {};
  try { context = await response.json(); } catch { context = {}; }

  if (!response.ok) {
    show(
      message,
      context.error || 'That link is not valid. Use the most recent link we texted you.',
      'error',
    );
    return;
  }

  eyebrow.textContent = `Week ${context.week} of ${context.totalWeeks}, day ${context.week * 7}`;
  heading.textContent = `Week ${context.week} audit`;
  // The behaviour is not stored, so it is not echoed here. Pointing at page 1
  // keeps the referent fixed without the server ever holding the text.
  behaviourLine.textContent =
    'Rate the past seven days for the behaviour you wrote on page 1 of your ledger. '
    + 'Open the ledger and read it before you answer.';

  const total = document.getElementById('total');
  const submit = document.getElementById('submit');
  const updateTotal = () => {
    total.textContent = `${readScores().reduce((sum, value) => sum + value, 0)} of 28`;
  };
  renderItems(document.getElementById('items'), updateTotal);
  updateTotal();
  form.hidden = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    show(message, 'Recording.', 'info');

    const result = await postJson(`/api/pulse${query}`, { scores: readScores() });
    if (!result.ok) {
      show(message, result.data.error, 'error');
      // A duplicate week is final, so there is nothing to retry.
      if (result.status !== 409) submit.disabled = false;
      return;
    }

    form.hidden = true;
    const { total: score, baseline, change, graduated, week } = result.data;
    const direction = change < 0
      ? `${Math.abs(change)} points below your Day 0 reading of ${baseline}.`
      : change === 0
        ? `Level with your Day 0 reading of ${baseline}.`
        : `${change} points above your Day 0 reading of ${baseline}. That happens. Record it and carry on.`;

    show(
      message,
      graduated
        ? `Week ${week}: ${score} of 28. You have stayed at or below the exit threshold for three `
          + 'consecutive audits. The protocol is complete and the texts stop here. '
          + 'Turn to the maintenance section of your ledger.'
        : `Week ${week} recorded: ${score} of 28. ${direction} Copy it into your ledger. `
          + 'The next link arrives Sunday at 18:00.',
      'ok',
    );
  });
}

start();
