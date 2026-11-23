/* ======================================================================
   Transactional email for THE SYSTEM
   ----------------------------------------------------------------------
   One plain-text message, sent through whichever provider has a key:
   Resend (RESEND_API_KEY) or Postmark (POSTMARK_TOKEN). Both are single
   HTTPS calls, which is all a Worker needs; no SDK or dependency.

   The local Node server logs the message instead, so password reset can be
   tested without any provider at all.

   Nothing here throws on a missing key: the caller decides whether to tell
   the user that mail is not configured.
   ====================================================================== */

export function mailConfigured(env) {
  return !!(env.RESEND_API_KEY || env.POSTMARK_TOKEN);
}

export function mailFrom(env) {
  return String(env.MAIL_FROM || 'THE SYSTEM <onboarding@resend.dev>');
}

export async function sendMail(env, { to, subject, text }) {
  if (!mailConfigured(env)) return { sent: false, reason: 'mail not configured' };

  try {
    if (env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: mailFrom(env), to: [to], subject, text })
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error('[system] resend rejected:', res.status, detail.slice(0, 200));
        return { sent: false, reason: `resend ${res.status}` };
      }
      return { sent: true, provider: 'resend' };
    }

    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': String(env.POSTMARK_TOKEN),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ From: mailFrom(env), To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[system] postmark rejected:', res.status, detail.slice(0, 200));
      return { sent: false, reason: `postmark ${res.status}` };
    }
    return { sent: true, provider: 'postmark' };
  } catch (err) {
    console.error('[system] mail send failed:', err);
    return { sent: false, reason: 'network' };
  }
}

/* Shared wording, so the Worker and the local server send the same text. */
export function resetMessage(origin, link) {
  return {
    subject: 'THE SYSTEM — reset your password',
    text: [
      'Someone asked to reset the password for this THE SYSTEM account.',
      '',
      `Open this link within 30 minutes to set a new one: ${link}`,
      '',
      'If it was not you, ignore this email: the password stays as it is.'
    ].join('\n')
  };
}

export function verifyMessage(origin, link) {
  return {
    subject: 'THE SYSTEM — confirm your email',
    text: [
      'Confirm this address so THE SYSTEM can recover your account and link Google safely.',
      '',
      `Open this link within 24 hours: ${link}`,
      '',
      'If you did not create an account, ignore this email.'
    ].join('\n')
  };
}
