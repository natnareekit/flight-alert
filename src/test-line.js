/**
 * One-off test: fires a single LINE push so you can confirm your token and
 * user ID are correct. Same script that already worked for the Garuda bot.
 *
 *   LINE_CHANNEL_TOKEN=xxx LINE_USER_ID=Uxxx node src/test-line.js
 */
async function main() {
  const token = process.env.LINE_CHANNEL_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!token || !userId) {
    console.error('Set LINE_CHANNEL_TOKEN and LINE_USER_ID env vars first.');
    process.exit(1);
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [
        { type: 'text', text: '✅ IKEA stock monitor: LINE test message. If you see this, notifications work.' },
      ],
    }),
  });
  console.log('Status:', res.status);
  console.log('Body:', await res.text());
  if (!res.ok) process.exit(1);
}
main();
