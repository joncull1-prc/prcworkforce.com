/**
 * Twilio SMS dispatch.
 *
 * The draft fell back to console logging whenever credentials were absent and
 * returned true. In production that means every participant silently receives
 * nothing while the system reports success. Dry-run is now an explicit opt-in
 * (SMS_DRY_RUN="1"), and missing credentials are a hard error.
 */

/** Characters outside the GSM 03.38 alphabet force UCS-2 and halve the segment size. */
const GSM_BASIC = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\s^{}\\[~\]|€]*$/;

/** Segment count, so a message that quietly costs three times as much is visible in tests. */
export function segmentCount(text) {
  const unicode = !GSM_BASIC.test(text);
  const limit = unicode ? 70 : 160;
  const multipart = unicode ? 67 : 153;
  return text.length <= limit ? 1 : Math.ceil(text.length / multipart);
}

export async function sendSMS(to, body, env) {
  if (env.SMS_DRY_RUN === '1') {
    console.log(JSON.stringify({ event: 'sms.dry_run', segments: segmentCount(body), bytes: body.length }));
    return { sent: true, dryRun: true };
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio credentials are not configured.');
  }

  const form = new URLSearchParams({ To: to, From: env.TWILIO_PHONE_NUMBER, Body: body });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );

  if (!response.ok) {
    // Never log the destination number or the response body: both carry personal data.
    console.error(JSON.stringify({ event: 'sms.failed', status: response.status }));
    return { sent: false, status: response.status };
  }
  return { sent: true };
}

/** Minimal TwiML reply. Escaped, because the body is echoed into XML. */
export function twiml(message) {
  const escaped = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

export function emptyTwiml() {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
