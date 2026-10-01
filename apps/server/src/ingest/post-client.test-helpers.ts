// Task 2.7, clause C1: a one-shot hook client run in its own node process
// (`node post-client.test-helpers.ts <url> <token> <body>`). It times the round trip on its own
// clock and prints `{ status, body, ms }` as JSON, so the test can tell a reply sent before
// processing from one sent after, even while the server's process is blocked.
//
// Task 2.7-fix, clause F1: `node post-client.test-helpers.ts <url> <token> --burst <bodies>`, where
// `<bodies>` is a JSON array of strings, sends one request per body, all at once (each on its own
// connection), and prints `{ results: [{ status, body, sentAt, repliedAt }] }` in the order of the
// bodies. `sentAt` and `repliedAt` are wall-clock ms epochs (`Date.now()`), comparable with the
// server's, taken just before the request is sent and as soon as its reply has arrived.
const [url, token, third, fourth] = process.argv.slice(2);

async function single(target: string, auth: string, body: string): Promise<void> {
  const started = performance.now();
  const response = await fetch(target, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  process.stdout.write(JSON.stringify({ status: response.status, body: text, ms }));
}

async function burst(target: string, auth: string, bodiesJson: string): Promise<void> {
  const parsed: unknown = JSON.parse(bodiesJson);
  if (!Array.isArray(parsed) || !parsed.every((b): b is string => typeof b === 'string')) {
    process.stdout.write(JSON.stringify({ error: '--burst needs a JSON array of strings' }));
    return;
  }
  const results = await Promise.all(
    parsed.map(async (body) => {
      const sentAt = Date.now();
      const response = await fetch(target, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      const repliedAt = Date.now();
      return { status: response.status, body: text, sentAt, repliedAt };
    }),
  );
  process.stdout.write(JSON.stringify({ results }));
}

async function main(): Promise<void> {
  if (url === undefined || token === undefined || third === undefined) {
    process.stdout.write(JSON.stringify({ error: 'usage: <url> <token> <body>' }));
    return;
  }
  if (third === '--burst' && fourth !== undefined) {
    await burst(url, token, fourth);
    return;
  }
  await single(url, token, third);
}

await main();

export {};
